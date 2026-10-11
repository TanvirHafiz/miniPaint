// Run: node --test src/js/ai/__tests__/size.test.mjs   (or npm run test:ai)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapValue, snapSize, outpaintSize } from '../size.js';

const isMultiple = (v, m) => v % m === 0;

test('snapValue rounds to nearest multiple and clamps', () => {
	assert.equal(snapValue(1000, 64), 1024);
	assert.equal(snapValue(1010, 64), 1024);
	assert.equal(snapValue(990, 64), 960);
	assert.equal(snapValue(970, 64), 960);
	assert.equal(snapValue(10, 64), 128);
	assert.equal(snapValue(5000, 64), 2048);
	assert.equal(snapValue(100, 16), 128);
	assert.equal(snapValue(1000, 16), 1008);
});

test('snapSize keeps exact multiples unchanged', () => {
	assert.deepEqual(snapSize(1024, 768, 64), { width: 1024, height: 768, scale: 1 });
	assert.deepEqual(snapSize(1280, 720, 16), { width: 1280, height: 720, scale: 1 });
});

test('snapSize snaps 1280x720 to multiples of 64 near 16:9', () => {
	const r = snapSize(1280, 720, 64);
	assert.equal(r.width, 1280);
	assert.equal(r.height, 704);
	assert.ok(isMultiple(r.width, 64) && isMultiple(r.height, 64));
});

test('snapSize scales large images down preserving aspect ratio', () => {
	const r = snapSize(4000, 3000, 64);
	assert.equal(r.width, 2048);
	assert.equal(r.height, 1536);
	assert.ok(Math.abs(r.scale - 2048 / 4000) < 1e-9);
	const r2 = snapSize(3840, 2160, 64);
	assert.equal(r2.width, 2048);
	assert.equal(r2.height, 1152);
});

test('snapSize scales tiny images up to min', () => {
	const r = snapSize(50, 100, 64);
	assert.equal(r.width, 128);
	assert.equal(r.height, 256);
});

test('snapSize handles extreme aspect ratios by clamping', () => {
	const r = snapSize(4000, 100, 64);
	assert.equal(r.width, 2048);
	assert.equal(r.height, 128);
	const r2 = snapSize(100, 5000, 16);
	assert.equal(r2.height, 2048);
	assert.equal(r2.width, 128);
});

test('snapSize results always respect multiple and range', () => {
	for (const m of [16, 64]) {
		for (let i = 0; i < 500; i++) {
			const w = 1 + Math.floor(Math.random() * 6000);
			const h = 1 + Math.floor(Math.random() * 6000);
			const r = snapSize(w, h, m);
			assert.ok(isMultiple(r.width, m), `${w}x${h} m=${m} -> ${r.width}`);
			assert.ok(isMultiple(r.height, m), `${w}x${h} m=${m} -> ${r.height}`);
			assert.ok(r.width >= 128 && r.width <= 2048);
			assert.ok(r.height >= 128 && r.height <= 2048);
		}
	}
});

test('snapSize rejects bad input', () => {
	assert.throws(() => snapSize(0, 100));
	assert.throws(() => snapSize(100, NaN));
	assert.throws(() => snapValue(100, 0));
});

test('outpaintSize rounds extensions up to 64 and sums dimensions', () => {
	const r = outpaintSize(1024, 768, { left: 100, top: 0, right: 64 });
	assert.deepEqual(r.outpaint, { top: 0, right: 64, bottom: 0, left: 128 });
	assert.equal(r.width, 1024 + 128 + 64);
	assert.equal(r.height, 768);
});
