/*
 * miniPaint AI: canvas I/O for AI requests.
 *
 * Takes pixels out of the document (flatten, crop, mask) in a form Runware accepts and puts
 * results back as NEW layers (never touching existing pixels). All coordinates are document
 * (canvas) pixels, independent of zoom. Pure math lives in region-math.js / size.js.
 *
 * Typical inpaint round trip (Phase 3):
 *   const region = getAiRegion() || fullCanvasRegion();
 *   const req = buildRequestRegion(region);
 *   const flat = flattenToCanvas({ source: 'visible' });
 *   const seedImage = exportRegion(flat, req.crop, req.send);
 *   const maskImage = buildMask(region, req.crop, req.send);
 *   ... runModel(inpaintModel, { width: req.send.w, height: req.send.h, ... }, { seedImage, maskImage })
 *   await placeResult(result.images[0].dataURI, req.crop, region, { name: 'AI: ' + prompt });
 */

import app from '../app.js';
import config from '../config.js';
import {
	normalizeRect, buildRequestRegion as buildRequestRegionMath, mapRectToSend,
	insideRamp1D, outwardRamp1D, clipFeathers, computeOutpaint as computeOutpaintMath,
} from './region-math.js';

/** Defaults chosen in Phase 2 (see docs/ARCHITECTURE-NOTES.md "AI canvas I/O"). */
export const DEFAULTS = {
	padding: 0.25,        // context around the selection, as a fraction of its longer side
	multiple: 64,
	min: 128,
	max: 2048,
	minLongSide: 512,     // upscale small crops so the model works at a useful resolution
	maskFeather: 0,       // px in canvas space, outward. Hard mask by default.
	clipFeather: 8,       // px in canvas space, inward soft edge when baking the result clip
	minSelection: 8,      // smaller selections are ignored
	outpaintBlend: 24,    // px in canvas space the outpaint result overlaps the original edge
};

function make_canvas(w, h) {
	const c = document.createElement('canvas');
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return c;
}

/**
 * Loads an image source (data URI, URL, HTMLImageElement, canvas or ImageBitmap) into something
 * drawImage accepts, waiting for decode when needed.
 * @returns {Promise<CanvasImageSource & {width:number,height:number}>}
 */
export function loadImage(src) {
	if (src && typeof src === 'object') {
		if (src instanceof HTMLCanvasElement || (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap)) {
			return Promise.resolve(src);
		}
		if (src instanceof HTMLImageElement && src.complete && src.naturalWidth > 0) {
			return Promise.resolve(src);
		}
		if (src instanceof HTMLImageElement) {
			return new Promise((resolve, reject) => {
				src.addEventListener('load', () => resolve(src), { once: true });
				src.addEventListener('error', () => reject(new Error('Image failed to load.')), { once: true });
			});
		}
	}
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'Anonymous';
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Image failed to load.'));
		img.src = src;
	});
}

/**
 * Renders the document into a new offscreen canvas of config.WIDTH x config.HEIGHT.
 * Uses Base_layers.convert_layers_to_canvas (honors visibility, opacity, composition, rotation,
 * live filters) so it never includes the selection overlay, guides, grid or rulers, and is not
 * affected by zoom or pan.
 *
 * @param {{source?: 'visible'|'active', layerId?: number}} opts
 *   'visible' = all visible layers (default), 'active' = only the active layer (or layerId).
 * @returns {HTMLCanvasElement}
 */
export function flattenToCanvas(opts = {}) {
	const source = opts.source || 'visible';
	const canvas = make_canvas(config.WIDTH, config.HEIGHT);
	const ctx = canvas.getContext('2d');
	let layerId = null;
	if (source === 'active') {
		layerId = opts.layerId != null ? opts.layerId : (config.layer ? config.layer.id : null);
	}
	ctx.save();
	app.Layers.convert_layers_to_canvas(ctx, layerId, false);
	// convert_layers_to_canvas leaves an unbalanced save() and the last layer's alpha/composite.
	ctx.restore();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
	ctx.filter = 'none';
	return canvas;
}

/** Region covering the whole document. */
export function fullCanvasRegion() {
	return { x: 0, y: 0, w: config.WIDTH, h: config.HEIGHT };
}

/**
 * Captures the current rectangle selection NOW (the selection is cleared on tool change,
 * layer click and Escape, so call this when the user starts an AI action).
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} integer rect clamped to the canvas, or
 *   null when there is no usable selection (smaller than DEFAULTS.minSelection px).
 */
export function getAiRegion(minSize = DEFAULTS.minSelection) {
	const tool = app.GUI && app.GUI.GUI_tools && app.GUI.GUI_tools.tools_modules.selection;
	const sel = tool && tool.object ? tool.object.selection : null;
	return normalizeRect(sel, config.WIDTH, config.HEIGHT, minSize);
}

/**
 * Crop and send size for a region. See region-math.js buildRequestRegion for the algorithm.
 * @returns {{crop:{x,y,w,h}, send:{w,h}, scale:number, scaleX:number, scaleY:number}}
 */
export function buildRequestRegion(region, opts = {}) {
	return buildRequestRegionMath(region, config.WIDTH, config.HEIGHT, { ...DEFAULTS, ...opts });
}

/**
 * Crops `canvas` to `crop` and scales it to `send` size.
 * @param {HTMLCanvasElement} canvas usually flattenToCanvas()
 * @returns {string} PNG data URI (keeps alpha)
 */
export function exportRegion(canvas, crop, send) {
	return exportRegionCanvas(canvas, crop, send).toDataURL('image/png');
}

/** Same as exportRegion but returns the canvas. */
export function exportRegionCanvas(canvas, crop, send) {
	const out = make_canvas(send.w, send.h);
	const ctx = out.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, send.w, send.h);
	return out;
}

/**
 * Builds the inpaint mask in send space: opaque black, white = the selection rect.
 * Edges are anti-aliased by pixel coverage; `feather` (canvas px) adds an outward soft ramp.
 *
 * @returns {string} PNG data URI, fully opaque (no alpha)
 */
export function buildMask(region, crop, send, opts = {}) {
	return buildMaskCanvas(region, crop, send, opts).toDataURL('image/png');
}

/** Same as buildMask but returns the canvas. */
export function buildMaskCanvas(region, crop, send, opts = {}) {
	const feather = opts.feather !== undefined ? opts.feather : DEFAULTS.maskFeather;
	const r = mapRectToSend(region, crop, send);
	const fx = feather * (send.w / crop.w);
	const fy = feather * (send.h / crop.h);
	const ax = outwardRamp1D(send.w, r.x, r.x + r.w, fx);
	const ay = outwardRamp1D(send.h, r.y, r.y + r.h, fy);
	const out = make_canvas(send.w, send.h);
	const ctx = out.getContext('2d');
	const img = ctx.createImageData(send.w, send.h);
	const d = img.data;
	for (let y = 0; y < send.h; y++) {
		const vy = ay[y];
		for (let x = 0; x < send.w; x++) {
			const v = Math.round(255 * vy * ax[x]);
			const i = (y * send.w + x) * 4;
			d[i] = v;
			d[i + 1] = v;
			d[i + 2] = v;
			d[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	return out;
}

/**
 * Canvas (crop.w x crop.h) whose alpha is the soft clip of `region` in crop space:
 * 1 inside, ramping to 0 at the selection edge over `feather` px, 0 outside.
 */
function clip_alpha_canvas(region, crop, feather) {
	const f = clipFeathers(region, config.WIDTH, config.HEIGHT, feather);
	const rx = region.x - crop.x;
	const ry = region.y - crop.y;
	const ax = insideRamp1D(crop.w, rx, rx + region.w, f.left, f.right);
	const ay = insideRamp1D(crop.h, ry, ry + region.h, f.top, f.bottom);
	const c = make_canvas(crop.w, crop.h);
	const ctx = c.getContext('2d');
	const img = ctx.createImageData(crop.w, crop.h);
	const d = img.data;
	for (let y = 0; y < crop.h; y++) {
		for (let x = 0; x < crop.w; x++) {
			const i = (y * crop.w + x) * 4;
			d[i] = 255;
			d[i + 1] = 255;
			d[i + 2] = 255;
			d[i + 3] = Math.round(255 * ay[y] * ax[x]);
		}
	}
	ctx.putImageData(img, 0, 0);
	return c;
}

/**
 * Scales an AI result back to crop size, bakes a soft clip to the original selection
 * (destination-in), and inserts ONE new layer at crop.x / crop.y as a single undo step.
 * Existing layers are never modified.
 *
 * @param {string|HTMLImageElement|HTMLCanvasElement} resultImage image in send space (any size)
 * @param {{x,y,w,h}} crop from buildRequestRegion
 * @param {{x,y,w,h}|null} region selection to clip to; null keeps the whole crop
 * @param {{feather?: number, name?: string}} opts feather in canvas px (default DEFAULTS.clipFeather)
 * @returns {Promise<{status:string}>} result of State.do_action
 */
export async function placeResult(resultImage, crop, region, opts = {}) {
	const feather = opts.feather !== undefined ? opts.feather : DEFAULTS.clipFeather;
	const img = await loadImage(resultImage);
	const canvas = make_canvas(crop.w, crop.h);
	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, 0, 0, crop.w, crop.h);
	if (region) {
		ctx.globalCompositeOperation = 'destination-in';
		ctx.drawImage(clip_alpha_canvas(region, crop, feather), 0, 0);
		ctx.globalCompositeOperation = 'source-over';
	}
	return app.State.do_action(
		new app.Actions.Bundle_action('ai_place_result', 'AI Result', [
			new app.Actions.Insert_layer_action({
				name: opts.name || 'AI: result',
				type: 'image',
				data: canvas.toDataURL('image/png'),
				x: crop.x,
				y: crop.y,
				width: crop.w,
				height: crop.h,
				width_original: crop.w,
				height_original: crop.h,
			}, false),
		])
	);
}

/**
 * Outpaint plan for the current canvas. Extensions are canvas px; see region-math.js.
 */
export function computeOutpaint(ext, opts = {}) {
	return computeOutpaintMath({
		canvasW: config.WIDTH,
		canvasH: config.HEIGHT,
		top: ext.top, right: ext.right, bottom: ext.bottom, left: ext.left,
		multiple: opts.multiple || DEFAULTS.multiple,
		min: opts.min || DEFAULTS.min,
		max: opts.max || DEFAULTS.max,
	});
}

/**
 * Seed image for an outpaint request: the flattened canvas scaled to plan.seed.
 * Send with width = plan.final.w, height = plan.final.h, outpaint = plan.outpaint.
 * @returns {string} PNG data URI
 */
export function exportOutpaintSeed(plan, flatCanvas) {
	const flat = flatCanvas || flattenToCanvas({ source: 'visible' });
	return exportRegion(flat, { x: 0, y: 0, w: config.WIDTH, h: config.HEIGHT }, plan.seed);
}

/**
 * Applies an outpaint result in ONE undo step:
 * 1. grows the canvas to plan.newCanvas,
 * 2. shifts every existing layer by (ext.left, ext.top) so the originals stay in place visually,
 * 3. inserts the result (plan.final sized, scaled to the new canvas) as a new layer at 0,0.
 *
 * Layering (default placement 'top'): the result goes ON TOP but is masked to the new border
 * plus a `blend` px band reaching into the original area with a soft ramp, so seams are hidden
 * while the original layers keep all their pixels (hide or delete the AI layer to get the plain
 * original back). placement 'bottom' puts the full result below every layer instead
 * (no mask; originals cover the center, transparent areas show the generated content).
 *
 * The canvas grows through Update_config_action between Prepare_canvas_action('undo'/'do'),
 * the same pattern as Image > Canvas Size, so Autoresize_canvas_action is never involved for the
 * growth. The inserted layer exactly matches the new canvas size, so its autoresize step is a
 * no-op (insert passes ignore_same_size).
 *
 * @param {object} plan from computeOutpaint
 * @param {string|HTMLImageElement|HTMLCanvasElement} resultImage plan.final sized result
 * @param {{placement?: 'top'|'bottom', blend?: number, name?: string}} opts
 */
export async function applyOutpaintCanvas(plan, resultImage, opts = {}) {
	const placement = opts.placement || 'top';
	const blend = opts.blend !== undefined ? opts.blend : DEFAULTS.outpaintBlend;
	const img = await loadImage(resultImage);
	const W = config.WIDTH;
	const H = config.HEIGHT;
	const NW = plan.newCanvas.w;
	const NH = plan.newCanvas.h;
	const ext = plan.ext;

	const canvas = make_canvas(NW, NH);
	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(img, 0, 0, NW, NH);

	if (placement === 'top') {
		// Keep alpha = 1 - (inside original area, ramping in over `blend` px). Sides that were not
		// extended have no seam, so the original area reaches the canvas edge there.
		const b = Math.max(0, Math.min(blend, Math.floor(Math.min(W, H) / 4)));
		const ax = insideRamp1D(NW, ext.left, ext.left + W, ext.left > 0 ? b : 0, ext.right > 0 ? b : 0);
		const ay = insideRamp1D(NH, ext.top, ext.top + H, ext.top > 0 ? b : 0, ext.bottom > 0 ? b : 0);
		const mask = make_canvas(NW, NH);
		const mctx = mask.getContext('2d');
		const data = mctx.createImageData(NW, NH);
		const d = data.data;
		for (let y = 0; y < NH; y++) {
			for (let x = 0; x < NW; x++) {
				const i = (y * NW + x) * 4;
				d[i] = d[i + 1] = d[i + 2] = 255;
				d[i + 3] = Math.round(255 * (1 - ay[y] * ax[x]));
			}
		}
		mctx.putImageData(data, 0, 0);
		ctx.globalCompositeOperation = 'destination-in';
		ctx.drawImage(mask, 0, 0);
		ctx.globalCompositeOperation = 'source-over';
	}

	const actions = [
		new app.Actions.Prepare_canvas_action('undo'),
		new app.Actions.Update_config_action({ WIDTH: NW, HEIGHT: NH }),
	];
	for (const layer of config.layers) {
		if (ext.left === 0 && ext.top === 0) break;
		actions.push(new app.Actions.Update_layer_action(layer.id, {
			x: (layer.x || 0) + ext.left,
			y: (layer.y || 0) + ext.top,
		}));
	}
	actions.push(new app.Actions.Prepare_canvas_action('do'));

	const settings = {
		name: opts.name || 'AI: outpaint',
		type: 'image',
		data: canvas.toDataURL('image/png'),
		x: 0,
		y: 0,
		width: NW,
		height: NH,
		width_original: NW,
		height_original: NH,
	};
	if (placement === 'bottom') {
		let minOrder = Infinity;
		for (const layer of config.layers) minOrder = Math.min(minOrder, layer.order);
		settings.order = (Number.isFinite(minOrder) ? minOrder : 1) - 1;
	}
	actions.push(new app.Actions.Insert_layer_action(settings, false));

	const result = await app.State.do_action(
		new app.Actions.Bundle_action('ai_outpaint', 'AI Outpaint', actions)
	);
	app.GUI.GUI_layers.render_layers();
	// The Information panel only refreshes its size on mousemove; update it now.
	if (app.GUI.GUI_information) app.GUI.GUI_information.show_size();
	config.need_render = true;
	return result;
}

/** Reads a canvas back as ImageData (debug and tests). */
export function readPixels(canvas) {
	return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}
