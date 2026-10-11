import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../mask-math.js';

function rect(w, h, x0, y0, x1, y1) {
	const a = new Uint8Array(w * h);
	for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
	return a;
}

test('bbox and coverage', () => {
	const a = rect(20, 10, 3, 2, 8, 6);
	assert.deepEqual(m.bbox_of(a, 20, 10), { x: 3, y: 2, w: 5, h: 4 });
	assert.equal(m.bbox_of(new Uint8Array(200), 20, 10), null);
	assert.equal(m.coverage(a), 20 / 200);
});

test('combine modes', () => {
	const a = rect(10, 1, 0, 0, 6, 1);
	const b = rect(10, 1, 4, 0, 10, 1);
	assert.equal(m.combine(Uint8Array.from(a), b, 'add').filter((v) => v === 255).length, 10);
	assert.equal(m.combine(Uint8Array.from(a), b, 'subtract').filter((v) => v === 255).length, 4);
	assert.equal(m.combine(Uint8Array.from(a), b, 'intersect').filter((v) => v === 255).length, 2);
	assert.deepEqual(Array.from(m.combine(Uint8Array.from(a), b, 'replace')), Array.from(b));
});

test('wand: contiguous stays inside the region, global finds all matches', () => {
	const w = 12, h = 6;
	const px = new Uint8ClampedArray(w * h * 4).fill(255); // white
	const set = (x, y, v) => { const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = v; };
	for (let y = 0; y < h; y++) set(6, y, 0); // black wall splits the image
	set(10, 2, 250); // slightly off white on the right side
	const left = m.wand(px, w, h, 1, 1, 10, true);
	assert.equal(left.filter((v) => v).length, 6 * h);
	assert.equal(left[1 * w + 8], 0);
	const all = m.wand(px, w, h, 1, 1, 10, false);
	assert.equal(all.filter((v) => v).length, w * h - h);
	const strict = m.wand(px, w, h, 1, 1, 2, true);
	assert.equal(strict.length, w * h);
	assert.equal(m.wand(px, w, h, -1, 0, 10).filter((v) => v).length, 0);
});

test('grow and shrink use exact euclidean distance', () => {
	const w = 41, h = 41;
	const a = new Uint8Array(w * h);
	a[20 * w + 20] = 255;
	const g = m.grow(a, w, h, 5);
	assert.equal(g[20 * w + 25], 255); // distance 5 inside
	assert.equal(g[20 * w + 27], 0); // distance 7 outside
	assert.ok(g[25 * w + 25] === 0 || g[25 * w + 25] < 128); // diagonal distance 7.07
	const big = rect(30, 30, 5, 5, 25, 25);
	const s = m.shrink(big, 30, 30, 3);
	assert.equal(s[15 * 30 + 15], 255);
	assert.equal(s[15 * 30 + 6], 0); // 1 px from the edge
	assert.equal(s[15 * 30 + 8], 255); // 3 px in is the new border
});

test('feather keeps the center and softens the edge', () => {
	const big = rect(40, 40, 10, 10, 30, 30);
	const f = m.feather(big, 40, 40, 4);
	assert.equal(f[20 * 40 + 20], 255);
	assert.ok(f[20 * 40 + 10] > 0 && f[20 * 40 + 10] < 255);
	assert.ok(f[20 * 40 + 3] < 20);
});

test('invert', () => {
	assert.deepEqual(Array.from(m.invert(Uint8Array.from([0, 255, 100]))), [255, 0, 155]);
});
