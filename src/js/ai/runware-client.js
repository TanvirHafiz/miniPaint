/*
 * miniPaint AI: browser side Runware client.
 *
 * Talks only to the local proxy (/api/runware). The API key never reaches the browser.
 * Every task gets a uuid v4 taskUUID and includeCost: true.
 *
 * Request format safety:
 * Runware documents two shapes for image inputs ('inputs' object vs task root) and two names for
 * the background removal / upscale task types. runModel() sends the remembered (or default)
 * format first; if Runware rejects it with a validation error that points at the inputs or the
 * task type, it retries ONCE with the alternative, and remembers what worked in localStorage
 * (per task kind: imageInference / utility).
 *
 * This module has no DOM dependencies (fetch, localStorage and performance are optional
 * globals), so it can be unit tested in Node with a fake transport (setTransport).
 */

import { v4 as uuidv4 } from 'uuid';
import { INPUT_STYLE, getModelInfo, taskTypeFor, taskKindOf, alternateTaskType } from './models.js';

// Relative on purpose: works at the site root and when the app is hosted under a sub path.
export const API_BASE = 'api';
const DEFAULT_TIMEOUT_MS = 120000;
const FORMAT_KEY = 'minipaint_ai_request_format';

export class RunwareError extends Error {
	/**
	 * @param {string} message
	 * @param {object} details { code, status, errors, cancelled, timedOut }
	 */
	constructor(message, details = {}) {
		super(message);
		this.name = 'RunwareError';
		Object.assign(this, details);
	}
}

/* ---------------------------------------------------------------- transport (testable) */

let transport = null;

/**
 * Replaces the HTTP layer (tests). fn(path, {method, body, signal}) -> Promise<{status, json}>.
 * Pass null to restore the default fetch based transport.
 */
export function setTransport(fn) {
	transport = fn;
}

async function default_transport(path, { method = 'GET', body, signal } = {}) {
	const response = await fetch(API_BASE + path, {
		method,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal,
		cache: 'no-store',
	});
	const text = await response.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch (e) {
		json = null;
	}
	return { status: response.status, ok: response.ok, json };
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ---------------------------------------------------------------- remembered request format */

let memory_format = null; // used when localStorage is unavailable (Node tests, private mode)

function default_format() {
	return {
		imageInference: { style: INPUT_STYLE },
		utility: {
			style: INPUT_STYLE,
			taskTypes: {}, // e.g. { removeBackground: 'imageBackgroundRemoval' } when the alternative worked
		},
	};
}

/** Current request format (remembered or default). */
export function getRequestFormat() {
	if (memory_format) return memory_format;
	let stored = null;
	try {
		stored = JSON.parse(localStorage.getItem(FORMAT_KEY) || 'null');
	} catch (e) {
		stored = null;
	}
	const base = default_format();
	if (stored && typeof stored === 'object') {
		if (stored.imageInference && stored.imageInference.style) base.imageInference.style = stored.imageInference.style;
		if (stored.utility && stored.utility.style) base.utility.style = stored.utility.style;
		if (stored.utility && stored.utility.taskTypes) base.utility.taskTypes = { ...stored.utility.taskTypes };
	}
	memory_format = base;
	return base;
}

function save_format(format) {
	memory_format = format;
	try {
		localStorage.setItem(FORMAT_KEY, JSON.stringify(format));
	} catch (e) {}
}

/** Forgets the remembered format (back to defaults). */
export function resetRequestFormat() {
	memory_format = null;
	try {
		localStorage.removeItem(FORMAT_KEY);
	} catch (e) {}
}

function other_style(style) {
	return style === 'root' ? 'inputs' : 'root';
}

/* ---------------------------------------------------------------- task building */

/**
 * The single place that knows how image inputs are shaped for Runware.
 * Returns an object to merge into the task.
 *
 * 'inputs' style (current model schemas):
 *   { inputs: { seedImage, maskImage, referenceImages } } for imageInference
 *   { inputs: { image } } for background removal / upscale
 * 'root' style (legacy REST docs):
 *   { seedImage, maskImage, referenceImages } for imageInference
 *   { inputImage } for background removal / upscale
 *
 * @param {string} model AIR id
 * @param {{seedImage?: string, maskImage?: string, referenceImages?: string[], image?: string}} images
 * @param {string} [style] 'inputs' | 'root'
 */
export function buildInputs(model, images = {}, style = INPUT_STYLE) {
	const info = getModelInfo(model);
	const utility = taskKindOf(model) === 'utility';
	const out = {};
	const set = (key, value) => {
		if (value === undefined || value === null || value === '') return;
		if (Array.isArray(value) && value.length === 0) return;
		out[key] = value;
	};

	if (utility) {
		const image = images.image || images.seedImage;
		if (style === 'root') set('inputImage', image);
		else set('image', image);
	} else {
		const refs = images.referenceImages;
		if (refs && info && info.maxReferenceImages && refs.length > info.maxReferenceImages) {
			throw new RunwareError(info.label + ' accepts at most ' + info.maxReferenceImages + ' reference image(s).', { code: 'tooManyReferences' });
		}
		set('seedImage', images.seedImage);
		set('maskImage', images.maskImage);
		set('referenceImages', refs);
	}

	if (style === 'root' || Object.keys(out).length === 0) {
		return out;
	}
	return { inputs: out };
}

function has_images(images) {
	return !!images && Object.keys(images).some((k) => {
		const v = images[k];
		return Array.isArray(v) ? v.length > 0 : !!v;
	});
}

/**
 * Builds one task object. `params` are merged in as Runware root fields (positivePrompt, width,
 * height, steps, numberResults, strength, outpaint, upscaleFactor, ...). `images` go through
 * buildInputs().
 *
 * @param {object} [format] {style, taskType} overrides (default: remembered format)
 */
export function buildTask(model, params = {}, images = {}, format = {}) {
	const info = getModelInfo(model);
	const kind = taskKindOf(model);
	const remembered = getRequestFormat()[kind];
	const style = format.style || remembered.style;
	let taskType = format.taskType || taskTypeFor(model, style);
	if (!format.taskType && kind === 'utility' && remembered.taskTypes && remembered.taskTypes[taskType]) {
		taskType = remembered.taskTypes[taskType];
	}
	const task = {
		taskType,
		taskUUID: uuidv4(),
		model,
		outputType: 'dataURI',
		outputFormat: 'PNG',
		...((info && info.defaults) || {}),
		...params,
		...buildInputs(model, images, style),
	};
	task.includeCost = true; // always, cannot be overridden
	for (const key of Object.keys(task)) {
		if (task[key] === undefined) delete task[key];
	}
	return task;
}

/* ---------------------------------------------------------------- HTTP */

function format_errors(errors) {
	return errors.map((e) => {
		let msg = e.message || e.code || 'Unknown error';
		if (e.parameter) msg += ' (parameter: ' + e.parameter + ')';
		return msg;
	}).join('; ');
}

/**
 * Sends a task array through the proxy.
 *
 * @param {object[]} tasks
 * @param {{signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{data: object[], cost: number, ms: number}>}
 */
export async function runTasks(tasks, options = {}) {
	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onExternalAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) controller.abort();
		else options.signal.addEventListener('abort', onExternalAbort, { once: true });
	}

	const started = now();
	let res;
	try {
		res = await (transport || default_transport)('/runware', { method: 'POST', body: tasks, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			if (timedOut) {
				throw new RunwareError('Runware request timed out after ' + Math.round(timeoutMs / 1000) + ' s.', { code: 'timeout', timedOut: true });
			}
			throw new RunwareError('Cancelled.', { code: 'cancelled', cancelled: true });
		}
		throw new RunwareError('Cannot reach the AI proxy at ' + API_BASE + '. Is it running? (npm run proxy)', { code: 'proxyUnreachable' });
	} finally {
		clearTimeout(timer);
		if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
	}
	if (controller.signal.aborted && !timedOut) {
		throw new RunwareError('Cancelled.', { code: 'cancelled', cancelled: true });
	}
	const ms = Math.round(now() - started);
	const json = res.json;
	const status = res.status;
	const ok = res.ok !== undefined ? res.ok : status >= 200 && status < 300;

	if (json && Array.isArray(json.errors) && json.errors.length > 0) {
		throw new RunwareError('Runware: ' + format_errors(json.errors), {
			code: json.errors[0].code,
			status,
			errors: json.errors,
		});
	}
	if (!ok) {
		const hint = status === 404 || status === 504 || status === 502
			? ' Is the AI proxy running? (npm run proxy)' : '';
		throw new RunwareError('AI proxy returned HTTP ' + status + '.' + hint, { code: 'http' + status, status });
	}
	if (!json || !Array.isArray(json.data)) {
		throw new RunwareError('Unexpected response from Runware (no data array).', { code: 'badResponse', status });
	}

	let cost = 0;
	for (const item of json.data) {
		if (typeof item.cost === 'number') cost += item.cost;
	}
	return { data: json.data, cost, ms };
}

/* ---------------------------------------------------------------- format fallback */

const INPUT_WORDS = /\b(inputs?|inputImage|seedImage|maskImage|referenceImages?|image)\b/i;
const UNKNOWN_WORDS = /(unknown|unsupported|unrecognized|not allowed|additional propert|invalid (?:parameter|field|key)|not (?:a )?valid (?:parameter|field)|unexpected (?:parameter|field|property))/i;
const TASKTYPE_WORDS = /\btask ?type\b|taskType/i;

/**
 * Does a Runware error look like it rejected the request FORMAT (where image inputs go, or the
 * task type name) rather than the content? Only those errors trigger the one-time fallback.
 *
 * @param {RunwareError} error
 * @returns {{inputs: boolean, taskType: boolean}}
 */
export function classifyFormatError(error) {
	const result = { inputs: false, taskType: false };
	if (!error || error.cancelled || error.timedOut) return result;
	if (!(error.status === 400 || error.status === 422 || error.status === undefined || (error.errors && error.errors.length))) return result;
	const errors = error.errors && error.errors.length ? error.errors : [{ message: error.message, code: error.code }];
	for (const e of errors) {
		const text = [e.code, e.message, e.parameter].filter(Boolean).join(' ');
		const param = String(e.parameter || '');
		if (TASKTYPE_WORDS.test(param) || (TASKTYPE_WORDS.test(text) && /(invalid|unknown|unsupported|not supported|not allowed)/i.test(text))) {
			result.taskType = true;
		}
		if (INPUT_WORDS.test(param) || (INPUT_WORDS.test(text) && (UNKNOWN_WORDS.test(text) || /required|missing/i.test(text))) || (/unsupportedParameter|unknownParameter/i.test(String(e.code || '')) && !e.parameter)) {
			result.inputs = true;
		}
	}
	return result;
}

/**
 * Runs a single task with format fallback (see file header).
 * @returns {Promise<{data: object[], cost: number, ms: number, task: object, format: {style, taskType}}>}
 */
async function run_with_fallback(model, params, images, options) {
	const kind = taskKindOf(model);
	const format = getRequestFormat();
	const first = buildTask(model, params, images);
	const first_style = format[kind].style;
	try {
		const result = await runTasks([first], options);
		return { ...result, task: first, format: { style: first_style, taskType: first.taskType } };
	} catch (error) {
		if (options.noFallback || !(error instanceof RunwareError)) throw error;
		const why = classifyFormatError(error);
		const imageRequest = has_images(images);
		const try_style = imageRequest && (why.inputs || (kind === 'utility' && why.taskType));
		const alt_type = kind === 'utility' ? alternateTaskType(first.taskType) : null;
		const try_type = kind === 'utility' && alt_type && (why.taskType || why.inputs);
		if (!try_style && !try_type) throw error;

		// One retry: flip the style for input errors; for utility tasks also flip the task type
		// name when the error points at it (the two documented pairs are consistent:
		// inputs + removeBackground/upscale, root + imageBackgroundRemoval/imageUpscale).
		const style = try_style ? other_style(first_style) : first_style;
		const taskType = try_type ? alt_type : first.taskType;
		const second = buildTask(model, params, images, { style, taskType });
		let result;
		try {
			result = await runTasks([second], options);
		} catch (error2) {
			if (error2 instanceof RunwareError && !error2.cancelled) {
				error2.message += ' (also failed with the original format: ' + error.message.replace(/^Runware: /, '') + ')';
			}
			throw error2;
		}
		const next = getRequestFormat();
		const updated = JSON.parse(JSON.stringify(next));
		updated[kind].style = style;
		if (kind === 'utility' && taskType !== taskTypeFor(model, style)) {
			updated.utility.taskTypes = { ...updated.utility.taskTypes, [taskTypeFor(model, style)]: taskType };
		}
		save_format(updated);
		if (typeof console !== 'undefined') {
			console.info('[miniPaint AI] Runware accepted request format "' + style + '" (taskType ' + taskType + ') for ' + kind + ' tasks after "' + first_style + '" (taskType ' + first.taskType + ') was rejected. Remembered.');
		}
		return { ...result, task: second, format: { style, taskType }, fellBack: true };
	}
}

/* ---------------------------------------------------------------- results */

/** Converts one Runware result item to an image record. */
function to_image(item) {
	let dataURI = item.imageDataURI || null;
	if (!dataURI && item.imageBase64Data) dataURI = 'data:image/png;base64,' + item.imageBase64Data;
	const url = item.imageURL && !String(item.imageURL).startsWith('data:') ? item.imageURL : null;
	if (!dataURI && item.imageURL && String(item.imageURL).startsWith('data:')) dataURI = item.imageURL;
	return { dataURI, url, imageUUID: item.imageUUID, seed: item.seed, cost: item.cost };
}

/**
 * Runs a single model call and returns images.
 *
 * @param {string} model AIR id
 * @param {object} params Runware root params (positivePrompt, width, height, numberResults, ...)
 * @param {object} images see buildInputs()
 * @param {{signal?: AbortSignal, timeoutMs?: number, noFallback?: boolean}} options
 * @returns {Promise<{images: Array<{dataURI: string|null, url: string|null, imageUUID: string, seed: number}>, cost: number, ms: number, task: object, format: object}>}
 */
export async function runModel(model, params = {}, images = {}, options = {}) {
	const result = await run_with_fallback(model, params, images, options);
	const task = result.task;
	const items = result.data.filter((d) => !d.taskUUID || d.taskUUID === task.taskUUID);
	const imagesOut = items.map(to_image).filter((img) => img.dataURI || img.url);
	if (imagesOut.length === 0) {
		throw new RunwareError('Runware returned no images.', { code: 'noImages' });
	}
	return { images: imagesOut, cost: result.cost, ms: result.ms, task, format: result.format, fellBack: !!result.fellBack };
}

/** Text to image. */
export function generate({ model, prompt, width, height, numberResults = 1, steps, seed, negativePrompt }, options = {}) {
	return runModel(model, {
		positivePrompt: prompt,
		negativePrompt: negativePrompt || undefined,
		width,
		height,
		numberResults,
		steps,
		seed,
	}, {}, options);
}

/**
 * Tries an image-input task in BOTH formats (no fallback, no memory changes during the probe),
 * then remembers the first working format. Used by AI > Diagnose request format.
 *
 * @param {string} model utility model (default the cheapest background removal)
 * @param {string} image small PNG data URI
 * @returns {Promise<{results: Array<{style, taskType, ok, error?, cost?, ms?}>, working: object|null, totalCost: number}>}
 */
export async function diagnoseRequestFormat(image, model = 'runware:112@5', options = {}) {
	const candidates = [
		{ style: 'inputs', taskType: taskTypeFor(model, 'inputs') },
		{ style: 'root', taskType: taskTypeFor(model, 'root') },
	];
	const results = [];
	let totalCost = 0;
	for (const c of candidates) {
		const task = buildTask(model, {}, { image }, c);
		try {
			const r = await runTasks([task], options);
			const ok = r.data.some((d) => d.imageDataURI || d.imageURL || d.imageBase64Data);
			totalCost += r.cost;
			results.push({ ...c, ok, cost: r.cost, ms: r.ms, error: ok ? undefined : 'no image returned' });
		} catch (error) {
			if (error.cancelled) throw error;
			results.push({ ...c, ok: false, error: error.message });
		}
	}
	const working = results.find((r) => r.ok) || null;
	if (working) {
		const updated = JSON.parse(JSON.stringify(getRequestFormat()));
		updated.utility.style = working.style;
		updated.utility.taskTypes = working.taskType !== taskTypeFor(model, working.style)
			? { [taskTypeFor(model, working.style)]: working.taskType } : {};
		// Same input placement is very likely for imageInference; adopt it unless only one works.
		updated.imageInference.style = working.style;
		save_format(updated);
	}
	return { results, working, totalCost };
}

/** GET /api/health -> {ok, hasKey, mock} */
export async function health(options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
	try {
		const res = await (transport || default_transport)('/health', { signal: controller.signal });
		const ok = res.ok !== undefined ? res.ok : res.status >= 200 && res.status < 300;
		if (!ok) {
			const hint = res.status >= 502 ? ' The dev server cannot reach the AI proxy; start it with npm run proxy (or npm run start:ai).' : '';
			throw new RunwareError('AI proxy health check returned HTTP ' + res.status + '.' + hint, { status: res.status });
		}
		return res.json;
	} catch (error) {
		if (error instanceof RunwareError) throw error;
		throw new RunwareError('Cannot reach the AI proxy at ' + API_BASE + '. Start it with npm run proxy (or npm run start:ai).', { code: 'proxyUnreachable' });
	} finally {
		clearTimeout(timer);
	}
}

/** Formats a USD cost like $0.0038 */
export function formatCost(cost) {
	return '$' + (Number(cost) || 0).toFixed(4);
}
