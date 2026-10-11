/*
 * miniPaint AI: the AI verbs (Generate, Inpaint, Edit, Outpaint, Remove BG, Upscale).
 *
 * Each verb prepares pixels with canvas-io.js, calls Runware through runware-client.js, and
 * returns a result object; nothing touches the document until result.place() runs, and every
 * place() call is ONE undo step that only adds layers (or, for Outpaint / Upscale, resizes the
 * canvas and moves layers in the same step). The panel (ai-panel.js) decides when to place
 * (immediately, or after the user picks a variation).
 *
 * Result object:
 * {
 *   verb, title, images: [{dataURI|url, seed}], cost, ms, model, overlay: {x,y,w,h},
 *   variations: boolean,                 // true when the user may pick among several images
 *   place(indexes?) -> Promise,          // inserts the chosen images (default: all)
 *   actions: [{label, run() | href+download}]  // extra one-click actions after placing
 *   note: string                         // extra status text (e.g. default prompt used)
 * }
 */

import app from '../app.js';
import config from '../config.js';
import { runModel, RunwareError } from './runware-client.js';
import { pickModel, getModelInfo, sizeRuleFor } from './models.js';
import { snapSize } from './size.js';
import { buildPresetRequestRegion, planUpscale, wantsMaskMargin } from './region-math.js';
import {
	DEFAULTS, flattenToCanvas, fullCanvasRegion, buildRequestRegion, exportRegion, buildMask,
	placeResults, computeOutpaint, exportOutpaintSeed, applyOutpaintCanvas, applyUpscaleCanvas,
	layerRect,
} from './canvas-io.js';

export const VERBS = ['generate', 'inpaint', 'edit', 'outpaint', 'removeBg', 'upscale'];

export const VERB_LABELS = {
	generate: 'Generate',
	inpaint: 'Inpaint',
	edit: 'Edit',
	outpaint: 'Outpaint',
	removeBg: 'Remove BG',
	upscale: 'Upscale',
};

/** Verbs that need a prompt. Outpaint uses a default prompt when empty. */
export const PROMPT_REQUIRED = { generate: true, inpaint: true, edit: true };

/** Verbs that support several results (variations picker). */
export const SUPPORTS_VARIATIONS = { generate: true, inpaint: true, edit: true };

export const DEFAULT_OUTPAINT_PROMPT = 'seamless continuation of the scene, same style and lighting';

/** Error with a friendly message for the status line (not a Runware error). */
export class AiUserError extends Error {}

function short_prompt(prompt, max = 30) {
	const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
	return clean.length > max ? clean.slice(0, max) : clean;
}

function layer_name(verb, text, i, n) {
	const base = 'AI ' + VERB_LABELS[verb] + (text ? ': ' + text : '');
	return n > 1 ? base + ' #' + (i + 1) : base;
}

function resolve_model(verb, opts) {
	const routeVerb = verb === 'outpaint' ? 'outpaint' : verb;
	if (opts.model) {
		const info = getModelInfo(opts.model);
		if (!info) throw new AiUserError('Unknown model ' + opts.model + '.');
		return { air: opts.model, info };
	}
	return pickModel(routeVerb, opts.preset === 'quality' ? 'quality' : 'fast');
}

function check_aborted(signal) {
	if (signal && signal.aborted) throw new RunwareError('Cancelled.', { code: 'cancelled', cancelled: true });
}

function count_of(verb, opts) {
	return SUPPORTS_VARIATIONS[verb] ? Math.max(1, Math.min(4, parseInt(opts.count, 10) || 1)) : 1;
}

/**
 * Shared shape for verbs that place into a crop with an optional selection clip.
 */
function crop_result(verb, run, { crop, region, prompt, feather, signal, overlay, note }) {
	const images = run.images;
	const text = short_prompt(prompt);
	return {
		verb,
		images,
		cost: run.cost,
		ms: run.ms,
		model: run.task.model,
		overlay,
		note,
		variations: images.length > 1,
		place: async (indexes) => {
			check_aborted(signal);
			const chosen = (indexes || images.map((_, i) => i)).map((i) => images[i]);
			const all = images.length;
			const opts = chosen.map((img) => ({
				feather,
				name: layer_name(verb, text, images.indexOf(img), all),
			}));
			return placeResults(chosen.map((img) => img.dataURI || img.url), crop, region, opts);
		},
		actions: [],
	};
}

/* ------------------------------------------------------------------ verbs */

/** Generate: text to image at (snapped) canvas size, placed as a full-canvas layer at 0,0. */
export async function runGenerate(opts, ctx = {}) {
	const prompt = String(opts.prompt || '').trim();
	if (prompt.length < 2) throw new AiUserError('Type a prompt first (at least 2 characters).');
	const { air } = resolve_model('generate', opts);
	const rule = sizeRuleFor(air);
	const size = snapSize(config.WIDTH, config.HEIGHT, rule.multiple, rule.min, rule.max);
	const crop = fullCanvasRegion();
	const run = await runModel(air, {
		positivePrompt: prompt,
		width: size.width,
		height: size.height,
		numberResults: count_of('generate', opts),
	}, {}, { signal: ctx.signal });
	return crop_result('generate', run, { crop, region: null, prompt, signal: ctx.signal, overlay: crop });
}

/** Inpaint: FLUX Fill on the padded selection with a white-on-black mask, clipped back. */
export async function runInpaint(opts, ctx = {}) {
	const prompt = String(opts.prompt || '').trim();
	const region = ctx.region;
	if (!region) throw new AiUserError('Inpaint needs a selection. Use the Select tool to draw a rectangle first.');
	if (prompt.length < 2) throw new AiUserError('Type what should appear in the selection (at least 2 characters).');
	const { air, info } = resolve_model('inpaint', opts);
	const rule = sizeRuleFor(air);
	const req = buildRequestRegion(region, { multiple: rule.multiple, min: rule.min, max: rule.max });
	const flat = flattenToCanvas({ source: 'visible' });
	const seedImage = exportRegion(flat, req.crop, req.send);
	const maskImage = buildMask(region, req.crop, req.send, { feather: opts.maskFeather || 0 });
	const params = {
		positivePrompt: prompt,
		width: req.send.w,
		height: req.send.h,
		numberResults: count_of('inpaint', opts),
	};
	if (info.supportsStrength && opts.strength != null) params.strength = Math.max(0, Math.min(1, Number(opts.strength)));
	if (info.supportsMaskMargin && wantsMaskMargin(region, req.crop, req.send)) params.maskMargin = 64;
	const run = await runModel(air, params, { seedImage, maskImage }, { signal: ctx.signal });
	return crop_result('inpaint', run, {
		crop: req.crop, region, prompt, feather: opts.feather, signal: ctx.signal, overlay: region,
	});
}

/**
 * Edit: instruction edit with the image as reference. With a selection: padded crop, result
 * clipped to the selection. Without: the whole image, result as a full-canvas layer.
 */
export async function runEdit(opts, ctx = {}) {
	const prompt = String(opts.prompt || '').trim();
	if (prompt.length < 2) throw new AiUserError('Describe the edit (for example "make the jacket red").');
	const { air, info } = resolve_model('edit', opts);
	const region = ctx.region || null;
	const target = region || fullCanvasRegion();
	const rule = sizeRuleFor(air);
	const req = info.sizePresets
		? buildPresetRequestRegion(target, config.WIDTH, config.HEIGHT, info.sizePresets, { padding: region ? DEFAULTS.padding : 0 })
		: buildRequestRegion(target, { multiple: rule.multiple, min: rule.min, max: rule.max, padding: region ? DEFAULTS.padding : 0 });
	const flat = flattenToCanvas({ source: 'visible' });
	const ref = exportRegion(flat, req.crop, req.send);
	const run = await runModel(air, {
		positivePrompt: prompt,
		width: req.send.w,
		height: req.send.h,
		numberResults: count_of('edit', opts),
	}, { referenceImages: [ref] }, { signal: ctx.signal });
	return crop_result('edit', run, {
		crop: req.crop, region, prompt, feather: opts.feather, signal: ctx.signal, overlay: target,
	});
}

/** Outpaint: FLUX Fill outpaint; grows the canvas, shifts layers, adds the masked result. */
export async function runOutpaint(opts, ctx = {}) {
	let prompt = String(opts.prompt || '').trim();
	let note = '';
	if (prompt.length < 2) {
		prompt = DEFAULT_OUTPAINT_PROMPT;
		note = 'No prompt, used "' + DEFAULT_OUTPAINT_PROMPT + '".';
	}
	const sides = opts.sides || {};
	const px = Math.max(0, parseInt(opts.outpaintPx, 10) || 0);
	const ext = {
		top: sides.top ? px : 0,
		right: sides.right ? px : 0,
		bottom: sides.bottom ? px : 0,
		left: sides.left ? px : 0,
	};
	if (px <= 0 || ext.top + ext.right + ext.bottom + ext.left === 0) {
		throw new AiUserError('Pick at least one outpaint direction and a pixel amount.');
	}
	const { air } = resolve_model('outpaint', opts);
	let plan;
	try {
		plan = computeOutpaint(ext);
	} catch (e) {
		throw new AiUserError(e.message);
	}
	const seedImage = exportOutpaintSeed(plan, flattenToCanvas({ source: 'visible' }));
	const blur = Math.max(0, Math.min(32, parseInt(opts.outpaintBlur, 10) || 0));
	const run = await runModel(air, {
		positivePrompt: prompt,
		width: plan.final.w,
		height: plan.final.h,
		outpaint: { ...plan.outpaint, blur },
		numberResults: 1,
	}, { seedImage }, { signal: ctx.signal });
	const text = short_prompt(opts.prompt || '');
	return {
		verb: 'outpaint',
		images: run.images,
		cost: run.cost,
		ms: run.ms,
		model: air,
		overlay: fullCanvasRegion(),
		note: (note ? note + ' ' : '') + 'Canvas ' + config.WIDTH + 'x' + config.HEIGHT + ' to ' + plan.newCanvas.w + 'x' + plan.newCanvas.h + '.',
		variations: false,
		place: async () => {
			check_aborted(ctx.signal);
			const img = run.images[0];
			return applyOutpaintCanvas(plan, img.dataURI || img.url, { name: layer_name('outpaint', text || 'border', 0, 1) });
		},
		actions: [],
	};
}

/**
 * Remove BG: active layer (default) or the whole flattened image. The result is a new layer with
 * transparency at the same position and size. The original stays visible; the returned actions
 * include "Hide original".
 */
export async function runRemoveBg(opts, ctx = {}) {
	const { air } = resolve_model('removeBg', opts);
	const wholeImage = opts.removeBgSource === 'image';
	const layer = config.layer;
	let crop;
	let flat;
	let label;
	if (wholeImage) {
		crop = fullCanvasRegion();
		flat = flattenToCanvas({ source: 'visible' });
		label = 'image';
	} else {
		if (!layer || layer.type == null) throw new AiUserError('The active layer is empty. Select a layer with content, or choose "Whole image".');
		if (layer.visible === false) throw new AiUserError('The active layer is hidden. Show it first, or choose "Whole image".');
		crop = layerRect(layer);
		if (!crop) throw new AiUserError('The active layer is outside the canvas.');
		flat = flattenToCanvas({ source: 'active', layerId: layer.id });
		label = short_prompt(layer.name, 24);
	}
	const longest = Math.max(crop.w, crop.h);
	const s = longest > 4096 ? 4096 / longest : 1;
	const send = { w: Math.max(1, Math.round(crop.w * s)), h: Math.max(1, Math.round(crop.h * s)) };
	const image = exportRegion(flat, crop, send);
	const run = await runModel(air, { outputFormat: 'PNG' }, { image }, { signal: ctx.signal });
	const sourceId = wholeImage ? null : layer.id;
	const result = crop_result('removeBg', { ...run, images: run.images.slice(0, 1) }, {
		crop, region: null, prompt: label, signal: ctx.signal, overlay: crop,
	});
	if (sourceId != null) {
		result.actions.push({
			label: 'Hide original',
			run: () => {
				const l = config.layers.find((x) => x.id === sourceId);
				if (l && l.visible !== false) {
					return app.State.do_action(new app.Actions.Toggle_layer_visibility_action(sourceId));
				}
				return null;
			},
		});
	}
	return result;
}

/**
 * Upscale: the flattened image x2 or x4. Applied in ONE undo step: canvas grows by the factor,
 * existing layers are scaled in place (position and size), and the upscaled image is added as
 * a new top layer. A "Download PNG" action is offered too.
 *
 * @param {{factor?: number, confirm?: (msg: string) => boolean}} opts
 */
export async function runUpscale(opts, ctx = {}) {
	const { air } = resolve_model('upscale', opts);
	const plan = planUpscale(config.WIDTH, config.HEIGHT, parseInt(opts.factor, 10) || 2);
	if (plan.tooLargeInput) {
		throw new AiUserError('The image is larger than 4096 px on one side. Resize it first (Image > Resize) or use 2x on a smaller copy.');
	}
	if (plan.needsConfirm) {
		const ask = ctx.confirm || ((msg) => window.confirm(msg));
		if (!ask('Upscaling ' + plan.factor + 'x gives a ' + plan.outW + 'x' + plan.outH + ' px canvas. That can make the editor slow. Continue?')) {
			throw new RunwareError('Cancelled.', { code: 'cancelled', cancelled: true });
		}
	}
	const crop = fullCanvasRegion();
	const flat = flattenToCanvas({ source: 'visible' });
	const image = exportRegion(flat, crop, { w: crop.w, h: crop.h });
	const run = await runModel(air, { upscaleFactor: plan.factor, outputFormat: 'PNG' }, { image }, { signal: ctx.signal });
	const img = run.images[0];
	const src = img.dataURI || img.url;
	return {
		verb: 'upscale',
		images: [img],
		cost: run.cost,
		ms: run.ms,
		model: air,
		overlay: crop,
		note: 'Canvas ' + config.WIDTH + 'x' + config.HEIGHT + ' to ' + plan.outW + 'x' + plan.outH + '.',
		variations: false,
		place: async () => {
			check_aborted(ctx.signal);
			return applyUpscaleCanvas(src, plan.factor, { name: 'AI Upscale: ' + plan.factor + 'x' });
		},
		actions: [{ label: 'Download PNG', href: src, download: 'upscaled-' + plan.factor + 'x.png' }],
	};
}

export const RUNNERS = {
	generate: runGenerate,
	inpaint: runInpaint,
	edit: runEdit,
	outpaint: runOutpaint,
	removeBg: runRemoveBg,
	upscale: runUpscale,
};
