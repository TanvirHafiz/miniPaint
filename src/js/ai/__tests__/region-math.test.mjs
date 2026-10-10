// Run: node --test src/js/ai/__tests__/region-math.test.mjs   (or npm run test:ai)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeRect, expandRect, fitCropToAspect, buildRequestRegion, mapRectToSend,
	insideRamp1D, outwardRamp1D, clipFeathers, computeOutpaint,
} from '../region-math.js';

const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
	&& inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const inCanvas = (r, W, H) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;

test('normalizeRect rounds, fixes negative sizes, clamps', () => {
	assert.deepEqual(normalizeRect({ x: 10.4, y: 20.6, width: 100.2, height: 50.5 }, 1013, 771), { x: 10, y: 21, w: 101, h: 50 });
	assert.deepEqual(normalizeRect({ x: 200, y: 300, width: -50, height: -100 }, 1013, 771), { x: 150, y: 200, w: 50, h: 100 });
	assert.deepEqual(normalizeRect({ x: -30, y: -10, width: 100, height: 60 }, 1013, 771), { x: 0, y: 0, w: 70, h: 50 });
	assert.deepEqual(normalizeRect({ x: 980, y: 740, width: 200, height: 200 }, 1013, 771), { x: 980, y: 740, w: 33, h: 31 });
	assert.deepEqual(normalizeRect({ x: 5, y: 5, w: 20, h: 20 }, 100, 100), { x: 5, y: 5, w: 20, h: 20 });
});

test('normalizeRect rejects empty, tiny and outside selections', () => {
	assert.equal(normalizeRect(null, 100, 100), null);
	assert.equal(normalizeRect({ x: null, y: null, width: null, height: null }, 100, 100), null);
	assert.equal(normalizeRect({ x: 10, y: 10, width: 7, height: 50 }, 100, 100), null);
	assert.equal(normalizeRect({ x: 10, y: 10, width: 50, height: 0 }, 100, 100), null);
	assert.equal(normalizeRect({ x: 200, y: 10, width: 50, height: 50 }, 100, 100), null);
	assert.equal(normalizeRect({ x: 95, y: 10, width: 50, height: 50 }, 100, 100), null); // only 5 px inside
	assert.deepEqual(normalizeRect({ x: 10, y: 10, width: 7, height: 50 }, 100, 100, 4), { x: 10, y: 10, w: 7, h: 50 });
});

test('expandRect clamps to canvas', () => {
	assert.deepEqual(expandRect({ x: 5, y: 5, w: 10, h: 10 }, 20, 100, 100), { x: 0, y: 0, w: 35, h: 35 });
	assert.deepEqual(expandRect({ x: 80, y: 80, w: 15, h: 15 }, 10, 100, 100), { x: 70, y: 70, w: 30, h: 30 });
});

test('fitCropToAspect grows toward aspect, stays in canvas, contains input', () => {
	const c = { x: 0, y: 100, w: 100, h: 200 };
	const r = fitCropToAspect(c, 1, 1013, 771);
	assert.deepEqual(r, { x: 0, y: 100, w: 200, h: 200 });
	const r2 = fitCropToAspect({ x: 950, y: 0, w: 63, h: 400 }, 1, 1013, 771);
	assert.equal(r2.w, 400); assert.equal(r2.x, 613);
	assert.ok(contains(r2, { x: 950, y: 0, w: 63, h: 400 }));
	// cannot grow past the canvas
	const r3 = fitCropToAspect({ x: 0, y: 0, w: 100, h: 771 }, 4, 300, 771);
	assert.deepEqual(r3, { x: 0, y: 0, w: 300, h: 771 });
});

function checkRequest(region, W, H, opts) {
	const r = buildRequestRegion(region, W, H, opts);
	const m = (opts && opts.multiple) || 64;
	const max = (opts && opts.max) || 2048;
	assert.ok(contains(r.crop, region), 'crop contains region');
	assert.ok(inCanvas(r.crop, W, H), 'crop inside canvas');
	assert.equal(r.send.w % m, 0); assert.equal(r.send.h % m, 0);
	assert.ok(r.send.w >= 128 && r.send.h >= 128 && r.send.w <= max && r.send.h <= max);
	assert.ok(Number.isInteger(r.crop.x) && Number.isInteger(r.crop.w));
	return r;
}

test('buildRequestRegion: mid-canvas selection gets 25% padding and minLongSide 512', () => {
	const r = checkRequest({ x: 400, y: 300, w: 100, h: 80 }, 1013, 771);
	// pad = 25, crop 150x130 before aspect fit; long side scaled to 512
	assert.ok(r.crop.w >= 150 && r.crop.h >= 130);
	assert.ok(Math.max(r.send.w, r.send.h) >= 512);
	assert.ok(Math.abs(r.scaleX - r.scaleY) / r.scaleX < 0.1, 'near uniform scale');
});

test('buildRequestRegion: selection at canvas corner and edges', () => {
	for (const region of [
		{ x: 0, y: 0, w: 120, h: 90 },
		{ x: 1013 - 64, y: 771 - 50, w: 64, h: 50 },
		{ x: 0, y: 300, w: 1013, h: 40 },
		{ x: 500, y: 0, w: 30, h: 771 },
	]) checkRequest(region, 1013, 771);
});

test('buildRequestRegion: tiny selection is upscaled but never past max', () => {
	const r = checkRequest({ x: 50, y: 50, w: 8, h: 8 }, 1013, 771);
	assert.ok(r.scaleX > 1);
	const r2 = checkRequest({ x: 50, y: 50, w: 8, h: 8 }, 1013, 771, { minLongSide: 0 });
	assert.ok(r2.send.w >= 128);
});

test('buildRequestRegion: selection bigger than 2048 is downscaled', () => {
	const W = 5000, H = 3000;
	const r = checkRequest({ x: 100, y: 100, w: 4500, h: 2600 }, W, H);
	assert.ok(r.send.w <= 2048 && r.send.h <= 2048);
	assert.ok(r.scaleX < 0.5);
});

test('buildRequestRegion: whole odd-size canvas', () => {
	const r = checkRequest({ x: 0, y: 0, w: 1013, h: 771 }, 1013, 771);
	assert.deepEqual(r.crop, { x: 0, y: 0, w: 1013, h: 771 });
	assert.deepEqual(r.send, { w: 1024, h: 768 });
});

test('buildRequestRegion: multiple 16 and custom padding', () => {
	const r = checkRequest({ x: 300, y: 200, w: 200, h: 100 }, 1013, 771, { multiple: 16, padding: 0 });
	assert.equal(r.send.w % 16, 0);
});

test('buildRequestRegion: random fuzz keeps invariants', () => {
	for (let i = 0; i < 400; i++) {
		const W = 64 + Math.floor(Math.random() * 4000);
		const H = 64 + Math.floor(Math.random() * 4000);
		const raw = { x: Math.random() * W * 1.2 - W * 0.1, y: Math.random() * H * 1.2 - H * 0.1, width: (Math.random() - 0.2) * W, height: (Math.random() - 0.2) * H };
		const region = normalizeRect(raw, W, H);
		if (!region) continue;
		checkRequest(region, W, H);
	}
});

test('mapRectToSend maps selection into send space', () => {
	const crop = { x: 100, y: 50, w: 200, h: 100 };
	const send = { w: 512, h: 256 };
	assert.deepEqual(mapRectToSend({ x: 150, y: 75, w: 100, h: 50 }, crop, send), { x: 128, y: 64, w: 256, h: 128 });
});

test('insideRamp1D hard and feathered edges', () => {
	const hard = insideRamp1D(10, 2, 8, 0);
	assert.deepEqual(Array.from(hard), [0, 0, 1, 1, 1, 1, 1, 1, 0, 0]);
	const soft = insideRamp1D(10, 0, 10, 2);
	assert.ok(Math.abs(soft[0] - 0.25) < 1e-6 && Math.abs(soft[1] - 0.75) < 1e-6 && soft[2] === 1 && Math.abs(soft[9] - 0.25) < 1e-6);
	const asym = insideRamp1D(10, 0, 10, 0, 4);
	assert.equal(asym[0], 1);
	assert.ok(asym[9] < 0.2);
});

test('outwardRamp1D fades outside', () => {
	const r = outwardRamp1D(10, 4, 6, 2);
	assert.equal(r[4], 1); assert.equal(r[5], 1);
	assert.ok(Math.abs(r[3] - 0.75) < 1e-6);
	assert.ok(Math.abs(r[2] - 0.25) < 1e-6);
	assert.equal(r[0], 0);
});

test('clipFeathers drops feather on canvas edges and caps it', () => {
	assert.deepEqual(clipFeathers({ x: 0, y: 10, w: 100, h: 100 }, 1013, 771, 8), { left: 0, top: 8, right: 8, bottom: 8 });
	assert.deepEqual(clipFeathers({ x: 913, y: 671, w: 100, h: 100 }, 1013, 771, 8), { left: 8, top: 8, right: 0, bottom: 0 });
	assert.deepEqual(clipFeathers({ x: 10, y: 10, w: 20, h: 20 }, 100, 100, 12), { left: 5, top: 5, right: 5, bottom: 5 });
});

test('computeOutpaint: multiples of 64, consistent sums, odd canvas', () => {
	const r = computeOutpaint({ canvasW: 1013, canvasH: 771, left: 100, right: 37 });
	for (const k of ['top', 'right', 'bottom', 'left']) assert.equal(r.outpaint[k] % 64, 0);
	assert.equal(r.seed.w % 64, 0); assert.equal(r.seed.h % 64, 0);
	assert.equal(r.final.w, r.seed.w + r.outpaint.left + r.outpaint.right);
	assert.equal(r.final.h, r.seed.h + r.outpaint.top + r.outpaint.bottom);
	assert.ok(r.ext.left >= 100 - 1 && r.ext.right >= 37 - 1, 'extensions at least what was asked');
	assert.equal(r.ext.top, 0); assert.equal(r.ext.bottom, 0);
	assert.equal(r.newCanvas.w, 1013 + r.ext.left + r.ext.right);
	assert.equal(r.newCanvas.h, 771);
	assert.ok(r.final.w <= 2048 && r.final.h <= 2048);
});

test('computeOutpaint: large canvas is scaled to fit 2048', () => {
	const r = computeOutpaint({ canvasW: 3000, canvasH: 2000, top: 500, bottom: 500 });
	assert.ok(r.final.w <= 2048 && r.final.h <= 2048);
	assert.ok(r.scaleX < 1);
	assert.equal(r.final.h, r.seed.h + r.outpaint.top + r.outpaint.bottom);
	assert.ok(r.ext.top >= 450, 'canvas extension close to request');
});

test('computeOutpaint: random fuzz', () => {
	for (let i = 0; i < 300; i++) {
		const p = {
			canvasW: 100 + Math.floor(Math.random() * 2500),
			canvasH: 100 + Math.floor(Math.random() * 2500),
			top: Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 400),
			right: Math.floor(Math.random() * 400) + 1,
			bottom: Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 400),
			left: Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 400),
		};
		const r = computeOutpaint(p);
		for (const k of ['top', 'right', 'bottom', 'left']) {
			assert.equal(r.outpaint[k] % 64, 0);
			if (p[k] > 0) assert.ok(r.outpaint[k] >= 64);
			else assert.equal(r.outpaint[k], 0);
		}
		assert.ok(r.final.w <= 2048 && r.final.h <= 2048, JSON.stringify(p));
		assert.equal(r.final.w, r.seed.w + r.outpaint.left + r.outpaint.right);
	}
});

test('computeOutpaint rejects zero extension', () => {
	assert.throws(() => computeOutpaint({ canvasW: 100, canvasH: 100 }));
});
