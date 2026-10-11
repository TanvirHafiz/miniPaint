/*
 * miniPaint AI: verb to model routing table for Runware.
 *
 * AIR ids below come from Runware's curated model catalog (Runware MCP: model_details,
 * model_schema, model_examples), checked 2026-10-10. Prices are approximate catalog figures.
 *
 * ---------------------------------------------------------------------------------------------
 * REQUEST SHAPE NOTES (read before Phase 3)
 *
 * 1. Image inputs. Two shapes exist today:
 *    - Public REST docs (runware.ai/docs/en/image-inference/api-reference, inpainting page):
 *      seedImage, maskImage, referenceImages at the TASK ROOT; background removal and upscale
 *      take a root "inputImage".
 *    - Current per-model JSON schemas and Runware's own example requests (model_schema /
 *      model_examples for runware:102@1, runware:400@2, runware:112@5, runware:504@1) nest them
 *      under an "inputs" object: inputs.seedImage, inputs.maskImage, inputs.referenceImages,
 *      and inputs.image for background removal / upscale. Those schemas set
 *      additionalProperties: false, so a root seedImage would be rejected for these models.
 *    We default to the "inputs" style (INPUT_STYLE below). buildInputs() in runware-client.js
 *    is the only place that knows the shape; flip INPUT_STYLE to 'root' if a live call
 *    rejects "inputs".
 *
 * 2. Task types.
 *    - Generate / edit / inpaint / outpaint: taskType "imageInference" (both sources agree).
 *    - Background removal: REST docs say taskType "imageBackgroundRemoval" with root
 *      "inputImage". Runware's current example requests send taskType "removeBackground"
 *      with inputs.image, and the RESPONSE echoes taskType "imageBackgroundRemoval".
 *    - Upscale: REST docs say "imageUpscale" with root "inputImage" and upscaleFactor 2 to 4.
 *      Current examples send taskType "upscale" with model runware:504@1, inputs.image and
 *      upscaleFactor (2 or 4); the RESPONSE echoes "imageUpscale".
 *    TASK_TYPES below follows the current examples ('inputs' style) and keeps the legacy
 *    names alongside. Verify with a live key in Phase 3 before shipping Remove BG / Upscale.
 *
 * 3. Every request sends includeCost: true (enforced in runware-client.js).
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Default request format: 'inputs' (current model schemas) or 'root' (legacy REST docs).
 * runware-client.js falls back to the other format automatically on a validation error and
 * remembers what worked (localStorage), separately for imageInference and utility tasks.
 */
export const INPUT_STYLE = 'inputs';

/** Task kinds that share a request format. */
export function taskKindOf(air) {
	const info = MODEL_INFO[air];
	return info && (info.task === 'removeBackground' || info.task === 'upscale') ? 'utility' : 'imageInference';
}

/** The other documented task type name for a utility task, or null. */
export function alternateTaskType(taskType) {
	const pairs = {
		removeBackground: 'imageBackgroundRemoval',
		imageBackgroundRemoval: 'removeBackground',
		upscale: 'imageUpscale',
		imageUpscale: 'upscale',
	};
	return pairs[taskType] || null;
}

/** Kontext [dev] accepts only these sizes (from its model schema). */
const KONTEXT_PRESETS = [
	[1568, 672], [1504, 688], [1456, 720], [1392, 752], [1328, 800], [1248, 832], [1184, 880],
	[1104, 944], [1024, 1024], [944, 1104], [880, 1184], [832, 1248], [800, 1328], [752, 1392],
	[720, 1456], [688, 1504], [672, 1568],
];

export const TASK_TYPES = {
	inputs: {
		imageInference: 'imageInference',
		removeBackground: 'removeBackground',
		upscale: 'upscale',
	},
	root: {
		imageInference: 'imageInference',
		removeBackground: 'imageBackgroundRemoval',
		upscale: 'imageUpscale',
	},
};

/** Default sizing rules used by most diffusion models here. */
const SIZE_64 = { multiple: 64, min: 128, max: 2048 };
const SIZE_16 = { multiple: 16, min: 128, max: 2048 };

/**
 * Model catalog. Capability flags:
 * - textToImage: prompt only
 * - edit: instruction edit with reference images (maxReferenceImages)
 * - inpaint: seedImage + maskImage (+ strength, maskMargin)
 * - outpaint: outpaint {top,right,bottom,left (multiples of 64), blur 0..32}
 * - removeBg / upscale: utility tasks with a single input image
 */
export const MODEL_INFO = {
	'runware:400@2': {
		label: 'FLUX.2 [klein] 9B',
		task: 'imageInference',
		caps: { textToImage: true, edit: true, inpaint: false, outpaint: false, removeBg: false, upscale: false, erase: false },
		size: SIZE_16,
		defaults: { steps: 4 },
		maxReferenceImages: 4,
		note: 'Sub-second generation. Edits via inputs.referenceImages (up to 4). About $0.0008 at 1024x1024.',
	},
	'runware:101@1': {
		label: 'FLUX.1 [dev]',
		task: 'imageInference',
		caps: { textToImage: true, edit: false, inpaint: false, outpaint: false, removeBg: false, upscale: false, erase: false },
		size: SIZE_64,
		defaults: {},
		note: 'Higher quality text to image. About $0.0038 at 1024x1024.',
	},
	'runware:106@1': {
		label: 'FLUX.1 Kontext [dev]',
		task: 'imageInference',
		caps: { textToImage: false, edit: true, inpaint: false, outpaint: false, removeBg: false, upscale: false, erase: false },
		size: SIZE_16,
		sizePresets: KONTEXT_PRESETS,
		defaults: {},
		maxReferenceImages: 1,
		note: 'Instruction editing with a reference image. About $0.0105 at 1024x1024.',
	},
	'runware:102@1': {
		label: 'FLUX.1 Fill',
		task: 'imageInference',
		supportsStrength: true,
		supportsMaskMargin: true,
		caps: { textToImage: false, edit: false, inpaint: true, outpaint: true, removeBg: false, upscale: false, erase: false },
		size: SIZE_64,
		// CFGScale 20 (the schema maximum): without it FLUX Fill barely follows the prompt and returns noisy blobs.
		// Live test 2026-10: strength 0.8 (Runware default) or lower keeps the original pixels, so inpaint sends 1 by default.
		defaults: { steps: 20, CFGScale: 20 },
		limits: { maskMargin: [32, 128], strength: [0, 1], outpaintBlur: [0, 32], outpaintMultiple: 64, CFGScale: [0, 20] },
		required: ['positivePrompt', 'width', 'height', 'model'],
		note: 'Inpaint (inputs.seedImage + inputs.maskImage, white = edit) and outpaint. strength or maskImage requires seedImage.',
	},
	'runware:112@5': {
		label: 'BiRefNet General',
		task: 'removeBackground',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: true, upscale: false, erase: false },
		size: null,
		defaults: { outputFormat: 'PNG' },
		note: 'Background removal, inputs.image. Use PNG or WEBP to keep alpha. About $0.0006.',
	},
	'bria:2@1': {
		label: 'Bria RMBG v2.0',
		task: 'removeBackground',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: true, upscale: false, erase: false },
		size: null,
		defaults: { outputFormat: 'PNG' },
		note: 'Higher quality background removal (inputs.image, schema checked).',
	},
	'runware:504@1': {
		label: 'Real-ESRGAN',
		task: 'upscale',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: false, upscale: true, erase: false },
		size: null,
		defaults: { upscaleFactor: 2 },
		limits: { upscaleFactor: [2, 4] },
		note: 'Upscale x2 (about $0.0006) or x4 (about $0.0013). inputs.image.',
	},
	'bria:52@1': {
		label: 'Bria Upscale',
		task: 'upscale',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: false, upscale: true, erase: false },
		size: null,
		defaults: { upscaleFactor: 2 },
		limits: { upscaleFactor: [2, 4] },
		note: 'Higher quality upscale x2 or x4 (inputs.image, schema checked).',
	},
	'bfl:flux@erase': {
		label: 'FLUX Erase',
		task: 'imageInference',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: false, upscale: false, erase: true },
		size: SIZE_64,
		defaults: {},
		note: 'Object removal (later phase). Verify schema before use.',
	},
	'runware:300@1': {
		label: 'Object Eraser',
		task: 'imageInference',
		caps: { textToImage: false, edit: false, inpaint: false, outpaint: false, removeBg: false, upscale: false, erase: true },
		size: SIZE_64,
		defaults: {},
		note: 'Object removal (later phase). Verify schema before use.',
	},
};

/** Verb routing: Fast and Quality preset per verb. */
export const MODELS = {
	generate: { fast: 'runware:400@2', quality: 'runware:101@1' },
	edit: { fast: 'runware:400@2', quality: 'runware:106@1' },
	inpaint: { fast: 'runware:102@1', quality: 'runware:102@1' },
	outpaint: { fast: 'runware:102@1', quality: 'runware:102@1' },
	removeBg: { fast: 'runware:112@5', quality: 'bria:2@1' },
	upscale: { fast: 'runware:504@1', quality: 'bria:52@1' },
	erase: { fast: 'runware:300@1', quality: 'bfl:flux@erase' },
};

/**
 * @param {string} verb e.g. 'generate'
 * @param {'fast'|'quality'} preset
 * @returns {{air: string, info: object}}
 */
export function pickModel(verb, preset = 'fast') {
	const route = MODELS[verb];
	if (!route) throw new Error('Unknown AI verb: ' + verb);
	const air = route[preset] || route.fast;
	return { air, info: MODEL_INFO[air] };
}

export function getModelInfo(air) {
	return MODEL_INFO[air] || null;
}

/** Default task type string for a model under a request style ('inputs' or 'root'). */
export function taskTypeFor(air, style = INPUT_STYLE) {
	const info = MODEL_INFO[air];
	const kind = info ? info.task : 'imageInference';
	return (TASK_TYPES[style] || TASK_TYPES.inputs)[kind] || 'imageInference';
}

/** Capability key used by each verb. */
export const VERB_CAP = {
	generate: 'textToImage',
	inpaint: 'inpaint',
	edit: 'edit',
	outpaint: 'outpaint',
	removeBg: 'removeBg',
	upscale: 'upscale',
	erase: 'erase',
};

/** AIR ids of every model that can serve a verb. */
export function modelsForVerb(verb) {
	const cap = VERB_CAP[verb];
	return Object.keys(MODEL_INFO).filter((air) => MODEL_INFO[air].caps && MODEL_INFO[air].caps[cap]);
}

/** Size rule for a model, falling back to multiples of 64. */
export function sizeRuleFor(air) {
	const info = MODEL_INFO[air];
	return (info && info.size) || SIZE_64;
}
