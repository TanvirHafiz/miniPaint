/*
 * miniPaint AI: browser side Runware client.
 *
 * Talks only to the local proxy (/api/runware). The API key never reaches the browser.
 * Every task gets a uuid v4 taskUUID and includeCost: true.
 */

import { v4 as uuidv4 } from 'uuid';
import { INPUT_STYLE, getModelInfo, taskTypeFor } from './models.js';

export const API_BASE = '/api';
const DEFAULT_TIMEOUT_MS = 120000;

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

/**
 * The single place that knows how image inputs are shaped for Runware.
 * Returns an object to merge into the task.
 *
 * 'inputs' style (current model schemas):
 *   { inputs: { seedImage, maskImage, referenceImages } } for imageInference
 *   { inputs: { image } } for removeBackground / upscale
 * 'root' style (legacy REST docs):
 *   { seedImage, maskImage, referenceImages } for imageInference
 *   { inputImage } for imageBackgroundRemoval / imageUpscale
 *
 * @param {string} model AIR id
 * @param {{seedImage?: string, maskImage?: string, referenceImages?: string[], image?: string}} images
 * @param {string} [style] override INPUT_STYLE
 */
export function buildInputs(model, images = {}, style = INPUT_STYLE) {
	const info = getModelInfo(model);
	const utility = info && (info.task === 'removeBackground' || info.task === 'upscale');
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
		let refs = images.referenceImages;
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

/**
 * Builds one task object. `params` are merged in as Runware root fields (positivePrompt, width,
 * height, steps, numberResults, strength, outpaint, upscaleFactor, ...). `images` go through
 * buildInputs().
 */
export function buildTask(model, params = {}, images = {}) {
	const info = getModelInfo(model);
	const task = {
		taskType: taskTypeFor(model),
		taskUUID: uuidv4(),
		model,
		outputType: 'dataURI',
		outputFormat: 'PNG',
		...((info && info.defaults) || {}),
		...params,
		...buildInputs(model, images),
	};
	task.includeCost = true; // always, cannot be overridden
	for (const key of Object.keys(task)) {
		if (task[key] === undefined) delete task[key];
	}
	return task;
}

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

	const started = performance.now();
	let response;
	let json = null;
	try {
		response = await fetch(API_BASE + '/runware', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(tasks),
			signal: controller.signal,
		});
		const text = await response.text();
		try {
			json = text ? JSON.parse(text) : null;
		} catch (e) {
			json = null;
		}
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
	const ms = Math.round(performance.now() - started);

	if (json && Array.isArray(json.errors) && json.errors.length > 0) {
		throw new RunwareError('Runware: ' + format_errors(json.errors), {
			code: json.errors[0].code,
			status: response.status,
			errors: json.errors,
		});
	}
	if (!response.ok) {
		const hint = response.status === 404 || response.status === 504 || response.status === 502
			? ' Is the AI proxy running? (npm run proxy)' : '';
		throw new RunwareError('AI proxy returned HTTP ' + response.status + '.' + hint, { code: 'http' + response.status, status: response.status });
	}
	if (!json || !Array.isArray(json.data)) {
		throw new RunwareError('Unexpected response from Runware (no data array).', { code: 'badResponse', status: response.status });
	}

	let cost = 0;
	for (const item of json.data) {
		if (typeof item.cost === 'number') cost += item.cost;
	}
	return { data: json.data, cost, ms };
}

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
 * @param {{signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<{images: Array<{dataURI: string|null, url: string|null, imageUUID: string, seed: number}>, cost: number, ms: number, task: object}>}
 */
export async function runModel(model, params = {}, images = {}, options = {}) {
	const task = buildTask(model, params, images);
	const result = await runTasks([task], options);
	const items = result.data.filter((d) => !d.taskUUID || d.taskUUID === task.taskUUID);
	const imagesOut = items.map(to_image).filter((img) => img.dataURI || img.url);
	if (imagesOut.length === 0) {
		throw new RunwareError('Runware returned no images.', { code: 'noImages' });
	}
	return { images: imagesOut, cost: result.cost, ms: result.ms, task };
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

/** GET /api/health -> {ok, hasKey, mock} */
export async function health(options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
	try {
		const response = await fetch(API_BASE + '/health', { signal: controller.signal, cache: 'no-store' });
		if (!response.ok) {
			const hint = response.status >= 502 ? ' The dev server cannot reach the AI proxy; start it with npm run proxy (or npm run start:ai).' : '';
			throw new RunwareError('AI proxy health check returned HTTP ' + response.status + '.' + hint, { status: response.status });
		}
		return await response.json();
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
