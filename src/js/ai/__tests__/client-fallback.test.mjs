// Run: node --test src/js/ai/__tests__/client-fallback.test.mjs   (or npm run test:ai)
// Request format fallback in runware-client.js, with a fake transport (no network).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	setTransport, runModel, resetRequestFormat, getRequestFormat, classifyFormatError,
	buildTask, diagnoseRequestFormat, RunwareError,
} from '../runware-client.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Fake Runware: accepts only tasks matching `accept(task)`, otherwise returns `reject(task)`. */
function fakeRunware(accept, reject) {
	const calls = [];
	setTransport(async (path, { body }) => {
		const task = body[0];
		calls.push(JSON.parse(JSON.stringify(task)));
		if (accept(task)) {
			return { status: 200, json: { data: [{ taskType: task.taskType, taskUUID: task.taskUUID, imageUUID: 'u1', imageDataURI: PNG, seed: 1, cost: 0.0012 }] } };
		}
		return { status: 400, json: { errors: [reject(task)] } };
	});
	return calls;
}

beforeEach(() => {
	resetRequestFormat();
	setTransport(null);
});

test('buildTask: inputs style nests images, root style puts them at the task root', () => {
	const a = buildTask('runware:102@1', { positivePrompt: 'x', width: 512, height: 512 }, { seedImage: PNG, maskImage: PNG });
	assert.deepEqual(a.inputs, { seedImage: PNG, maskImage: PNG });
	assert.equal(a.seedImage, undefined);
	assert.equal(a.includeCost, true);
	const b = buildTask('runware:102@1', { positivePrompt: 'x', width: 512, height: 512 }, { seedImage: PNG }, { style: 'root' });
	assert.equal(b.seedImage, PNG);
	assert.equal(b.inputs, undefined);
	const c = buildTask('runware:112@5', {}, { image: PNG }, { style: 'root' });
	assert.equal(c.inputImage, PNG);
	assert.equal(c.taskType, 'imageBackgroundRemoval');
	const d = buildTask('runware:112@5', {}, { image: PNG });
	assert.deepEqual(d.inputs, { image: PNG });
	assert.equal(d.taskType, 'removeBackground');
	const e = buildTask('runware:400@2', { positivePrompt: 'x', width: 512, height: 512, includeCost: false });
	assert.equal(e.includeCost, true, 'includeCost cannot be overridden');
});

test('fallback: inputs style rejected, root style accepted, remembered for next call', async () => {
	const calls = fakeRunware(
		(t) => t.seedImage !== undefined && t.inputs === undefined,
		() => ({ code: 'invalidParameter', parameter: 'inputs', message: 'Unknown parameter: inputs' })
	);
	const r = await runModel('runware:102@1', { positivePrompt: 'a cat', width: 512, height: 512 }, { seedImage: PNG, maskImage: PNG });
	assert.equal(calls.length, 2);
	assert.ok(calls[0].inputs && !calls[0].seedImage, 'first try uses inputs style');
	assert.ok(calls[1].seedImage && !calls[1].inputs, 'retry uses root style');
	assert.equal(r.fellBack, true);
	assert.equal(r.format.style, 'root');
	assert.equal(r.cost, 0.0012);
	assert.equal(getRequestFormat().imageInference.style, 'root');
	// Next call goes straight to root, no extra request.
	const r2 = await runModel('runware:102@1', { positivePrompt: 'a dog', width: 512, height: 512 }, { seedImage: PNG, maskImage: PNG });
	assert.equal(calls.length, 3);
	assert.ok(calls[2].seedImage && !calls[2].inputs);
	assert.equal(r2.fellBack, false);
});

test('fallback: utility task type alternative is tried and remembered', async () => {
	const calls = fakeRunware(
		(t) => (t.taskType === 'imageBackgroundRemoval' || t.taskType === 'imageUpscale') && t.inputImage,
		(t) => ({ code: 'invalidTaskType', parameter: 'taskType', message: 'Invalid taskType ' + t.taskType })
	);
	const r = await runModel('runware:112@5', {}, { image: PNG });
	assert.equal(calls.length, 2);
	assert.equal(calls[0].taskType, 'removeBackground');
	assert.equal(calls[1].taskType, 'imageBackgroundRemoval');
	assert.equal(r.format.style, 'root');
	const f = getRequestFormat();
	assert.equal(f.utility.style, 'root');
	// imageInference format is untouched by a utility fallback
	assert.equal(f.imageInference.style, 'inputs');
	await runModel('runware:504@1', { upscaleFactor: 2 }, { image: PNG });
	assert.equal(calls[2].taskType, 'imageUpscale', 'remembered root style picks the root task name for upscale too');
	assert.ok(calls[2].inputImage);
});

test('fallback: only the task type name is wrong (inputs style kept)', async () => {
	const calls = fakeRunware(
		(t) => t.taskType === 'imageBackgroundRemoval' && t.inputs && t.inputs.image,
		() => ({ code: 'invalidTaskType', parameter: 'taskType', message: 'Unsupported task type' })
	);
	// first try: removeBackground + inputs; the error names only taskType, so retry flips type AND style
	// (the two documented combinations). That fails here, so the error surfaces with both messages.
	await assert.rejects(runModel('runware:112@5', {}, { image: PNG }), /also failed/);
	assert.equal(calls.length, 2);
	assert.equal(getRequestFormat().utility.style, 'inputs', 'nothing remembered after a failed retry');
});

test('no fallback for content errors, cancels, or text-only requests', async () => {
	const calls = fakeRunware(() => false, () => ({ code: 'insufficientCredits', message: 'Insufficient credits' }));
	await assert.rejects(runModel('runware:102@1', { positivePrompt: 'x', width: 512, height: 512 }, { seedImage: PNG }), /Insufficient credits/);
	assert.equal(calls.length, 1);
	const calls2 = fakeRunware(() => false, () => ({ code: 'invalidParameter', parameter: 'width', message: 'width must be a multiple of 64' }));
	await assert.rejects(runModel('runware:102@1', { positivePrompt: 'x', width: 500, height: 512 }, { seedImage: PNG }), /multiple of 64/);
	assert.equal(calls2.length, 1);
	const calls3 = fakeRunware(() => false, () => ({ code: 'invalidParameter', parameter: 'inputs', message: 'Unknown parameter: inputs' }));
	await assert.rejects(runModel('runware:400@2', { positivePrompt: 'x', width: 512, height: 512 }, {}));
	assert.equal(calls3.length, 1, 'text-to-image has no image inputs, so no style retry');
});

test('classifyFormatError recognizes typical messages', () => {
	const mk = (e) => new RunwareError('Runware: ' + e.message, { status: 400, errors: [e] });
	assert.equal(classifyFormatError(mk({ code: 'invalidParameter', parameter: 'seedImage', message: 'Unsupported parameter' })).inputs, true);
	assert.equal(classifyFormatError(mk({ code: 'x', message: 'additionalProperties: inputs is not allowed' })).inputs, true);
	assert.equal(classifyFormatError(mk({ code: 'x', message: 'Missing required parameter inputImage' })).inputs, true);
	assert.equal(classifyFormatError(mk({ code: 'invalidTaskType', message: 'Invalid taskType upscale' })).taskType, true);
	assert.deepEqual(classifyFormatError(mk({ code: 'insufficientCredits', message: 'Insufficient credits' })), { inputs: false, taskType: false });
	assert.deepEqual(classifyFormatError(new RunwareError('Cancelled.', { cancelled: true })), { inputs: false, taskType: false });
});

test('diagnoseRequestFormat probes both styles and remembers the working one', async () => {
	const calls = fakeRunware(
		(t) => t.taskType === 'imageBackgroundRemoval' && t.inputImage,
		() => ({ code: 'invalidParameter', parameter: 'inputs', message: 'Unknown parameter: inputs' })
	);
	const d = await diagnoseRequestFormat(PNG);
	assert.equal(calls.length, 2);
	assert.equal(d.results[0].ok, false);
	assert.equal(d.results[1].ok, true);
	assert.equal(d.working.style, 'root');
	assert.equal(d.totalCost, 0.0012);
	assert.equal(getRequestFormat().utility.style, 'root');
	assert.equal(getRequestFormat().imageInference.style, 'root');
});
