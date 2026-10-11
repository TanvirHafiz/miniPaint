/*
 * miniPaint AI: pure mask math (no DOM, unit tested with node --test).
 * A mask is a Uint8Array/Uint8ClampedArray of w*h alpha values (0 = outside, 255 = inside).
 */

import { box_blur } from '../layer-effects/effects-math.js';

/** Bounding box of pixels with alpha >= thr, or null when the mask is empty. */
export function bbox_of(a, w, h, thr = 8) {
	let x0 = w, y0 = h, x1 = -1, y1 = -1;
	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			if (a[row + x] >= thr) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return null;
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Share of pixels with alpha >= 128 (0..1). */
export function coverage(a) {
	let n = 0;
	for (let i = 0; i < a.length; i++) if (a[i] >= 128) n++;
	return a.length ? n / a.length : 0;
}

/**
 * Combines `src` into `dst` in place.
 * modes: replace, add (union), subtract, intersect.
 */
export function combine(dst, src, mode) {
	for (let i = 0; i < dst.length; i++) {
		const d = dst[i];
		const s = src[i];
		if (mode === 'replace') dst[i] = s;
		else if (mode === 'add') dst[i] = d > s ? d : s;
		else if (mode === 'subtract') dst[i] = Math.round(d * (1 - s / 255));
		else if (mode === 'intersect') dst[i] = Math.round((d * s) / 255);
	}
	return dst;
}

export function invert(a) {
	for (let i = 0; i < a.length; i++) a[i] = 255 - a[i];
	return a;
}

/**
 * Magic wand: pixels whose color is within `tol` (0..255, max channel difference over RGBA) of the
 * seed pixel. contiguous = flood fill from the seed; otherwise every matching pixel in the image.
 * @param {Uint8ClampedArray} rgba w*h*4
 * @returns {Uint8Array} mask (0 or 255)
 */
export function wand(rgba, w, h, sx, sy, tol, contiguous = true) {
	const out = new Uint8Array(w * h);
	sx = Math.floor(sx);
	sy = Math.floor(sy);
	if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
	const si = (sy * w + sx) * 4;
	const r0 = rgba[si], g0 = rgba[si + 1], b0 = rgba[si + 2], a0 = rgba[si + 3];
	const match = (p) => {
		const i = p * 4;
		return Math.abs(rgba[i] - r0) <= tol && Math.abs(rgba[i + 1] - g0) <= tol
			&& Math.abs(rgba[i + 2] - b0) <= tol && Math.abs(rgba[i + 3] - a0) <= tol;
	};
	if (!contiguous) {
		for (let p = 0; p < w * h; p++) if (match(p)) out[p] = 255;
		return out;
	}
	const stack = [sx, sy];
	while (stack.length) {
		const y = stack.pop();
		let x = stack.pop();
		let p = y * w + x;
		if (out[p] || !match(p)) continue;
		let l = x;
		while (l > 0 && !out[y * w + l - 1] && match(y * w + l - 1)) l--;
		let r = x;
		while (r < w - 1 && !out[y * w + r + 1] && match(y * w + r + 1)) r++;
		for (x = l; x <= r; x++) out[y * w + x] = 255;
		for (const ny of [y - 1, y + 1]) {
			if (ny < 0 || ny >= h) continue;
			let inRun = false;
			for (x = l; x <= r; x++) {
				const q = ny * w + x;
				const ok = !out[q] && match(q);
				if (ok && !inRun) stack.push(x, ny);
				inRun = ok;
			}
		}
	}
	return out;
}

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb and Huttenlocher), f in, d out, length n. */
function edt_1d(f, d, v, z, n) {
	let k = 0;
	v[0] = 0;
	z[0] = -INF;
	z[1] = INF;
	for (let q = 1; q < n; q++) {
		let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) {
			k--;
			s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = INF;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1] < q) k++;
		const p = v[k];
		d[q] = (q - p) * (q - p) + f[p];
	}
}

/** Squared euclidean distance from every pixel to the nearest pixel where `inside(i)` is true. */
function distance_squared(w, h, inside) {
	const n = Math.max(w, h);
	const grid = new Float64Array(w * h);
	for (let i = 0; i < grid.length; i++) grid[i] = inside(i) ? 0 : INF;
	const f = new Float64Array(n);
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
		edt_1d(f, d, v, z, h);
		for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
		edt_1d(f, d, v, z, w);
		for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
	}
	return grid;
}

/** Grows the mask by r pixels (round, exact distance) with a 1 px anti-aliased edge (a pixel at distance r is fully inside). */
export function grow(a, w, h, r) {
	if (!(r > 0)) return a;
	const dist = distance_squared(w, h, (i) => a[i] >= 128);
	const out = new Uint8Array(w * h);
	for (let i = 0; i < out.length; i++) {
		if (a[i] >= 128) {
			out[i] = Math.max(a[i], 255);
			continue;
		}
		const d = Math.sqrt(dist[i]);
		const v = Math.min(1, Math.max(0, r + 1 - d));
		out[i] = Math.round(v * 255);
	}
	return out;
}

/** Shrinks the mask by r pixels (round, exact distance). */
export function shrink(a, w, h, r) {
	if (!(r > 0)) return a;
	const inv = invert(Uint8Array.from(a));
	return invert(grow(inv, w, h, r));
}

/** Soft edge: blurs the mask with radius r (three box passes, close to a gaussian). */
export function feather(a, w, h, r) {
	r = Math.round(r);
	if (r < 1) return a;
	const f = new Float32Array(w * h);
	for (let i = 0; i < f.length; i++) f[i] = a[i] / 255;
	const each = Math.max(1, Math.round(r / 2));
	box_blur(f, w, h, each);
	box_blur(f, w, h, each);
	box_blur(f, w, h, each);
	const out = new Uint8Array(w * h);
	for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 255);
	return out;
}
