/*
 * miniPaint AI: pure region math for AI requests (no DOM, no app imports).
 * Unit tested with `node --test src/js/ai/__tests__/region-math.test.mjs`.
 *
 * Coordinate spaces:
 * - canvas space: miniPaint document pixels (config.WIDTH x config.HEIGHT), zoom independent.
 * - crop space:   pixels relative to crop.x / crop.y, same scale as canvas.
 * - send space:   the image actually sent to Runware (send.w x send.h), per-axis scaled from crop.
 */

import { snapValue } from './size.js';

/**
 * Normalizes a raw selection {x, y, width, height} (may be fractional, negative sized, partly
 * outside the canvas) into an integer rect clamped to the canvas.
 * Edges are rounded to the nearest pixel boundary.
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} null when missing or smaller than minSize
 */
export function normalizeRect(sel, canvasW, canvasH, minSize = 8) {
	if (!sel) return null;
	let { x, y } = sel;
	let w = sel.width !== undefined ? sel.width : sel.w;
	let h = sel.height !== undefined ? sel.height : sel.h;
	if ([x, y, w, h].some((v) => v === null || v === undefined || !Number.isFinite(Number(v)))) return null;
	x = Number(x); y = Number(y); w = Number(w); h = Number(h);
	if (w < 0) { x += w; w = -w; }
	if (h < 0) { y += h; h = -h; }
	const x0 = Math.max(0, Math.round(x));
	const y0 = Math.max(0, Math.round(y));
	const x1 = Math.min(canvasW, Math.round(x + w));
	const y1 = Math.min(canvasH, Math.round(y + h));
	const rw = x1 - x0;
	const rh = y1 - y0;
	if (rw < minSize || rh < minSize) return null;
	return { x: x0, y: y0, w: rw, h: rh };
}

/** Grows a rect by `pad` px on every side, clamped to the canvas. */
export function expandRect(rect, pad, canvasW, canvasH) {
	const x0 = Math.max(0, rect.x - pad);
	const y0 = Math.max(0, rect.y - pad);
	const x1 = Math.min(canvasW, rect.x + rect.w + pad);
	const y1 = Math.min(canvasH, rect.y + rect.h + pad);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Grows (never shrinks) a crop so its aspect ratio approaches `aspect` (w/h), centered on the
 * crop and shifted inward at canvas edges. The result always contains the input crop.
 */
export function fitCropToAspect(crop, aspect, canvasW, canvasH) {
	let { x, y, w, h } = crop;
	if (!(aspect > 0)) return { x, y, w, h };
	if (w / h < aspect) {
		const wantW = Math.min(canvasW, Math.round(h * aspect));
		if (wantW > w) {
			x = x - Math.floor((wantW - w) / 2);
			x = Math.max(0, Math.min(canvasW - wantW, x));
			w = wantW;
		}
	} else if (w / h > aspect) {
		const wantH = Math.min(canvasH, Math.round(w / aspect));
		if (wantH > h) {
			y = y - Math.floor((wantH - h) / 2);
			y = Math.max(0, Math.min(canvasH - wantH, y));
			h = wantH;
		}
	}
	return { x, y, w, h };
}

/**
 * Computes the crop to take from the canvas and the size to send to Runware.
 *
 * 1. crop = region grown by padding * max(region.w, region.h) on every side, clamped to canvas.
 * 2. scale s: shrink so the long side <= max; grow so the long side >= minLongSide (small
 *    crops give better model detail); grow so the short side >= min; never let the long side
 *    pass max.
 * 3. send = each side * s snapped to `multiple` inside [min, max].
 * 4. crop grown (never shrunk) toward send's aspect so the per-axis scales match as closely as
 *    the canvas allows.
 *
 * @param {{x,y,w,h}} region normalized region (canvas px)
 * @param {number} canvasW
 * @param {number} canvasH
 * @param {{padding?:number, multiple?:number, min?:number, max?:number, minLongSide?:number}} opts
 * @returns {{crop:{x,y,w,h}, send:{w,h}, scale:number, scaleX:number, scaleY:number}}
 */
export function buildRequestRegion(region, canvasW, canvasH, opts = {}) {
	const padding = opts.padding !== undefined ? opts.padding : 0.25;
	const multiple = opts.multiple || 64;
	const min = opts.min || 128;
	const max = opts.max || 2048;
	const minLongSide = Math.min(max, opts.minLongSide !== undefined ? opts.minLongSide : 512);

	const pad = Math.round(Math.max(0, padding) * Math.max(region.w, region.h));
	let crop = expandRect(region, pad, canvasW, canvasH);

	const longer = Math.max(crop.w, crop.h);
	const shorter = Math.min(crop.w, crop.h);
	let s = 1;
	if (longer * s > max) s = max / longer;
	if (longer * s < minLongSide) s = Math.min(minLongSide / longer, max / longer);
	if (shorter * s < min) s = Math.min(min / shorter, max / longer);

	const send = {
		w: snapValue(crop.w * s, multiple, min, max),
		h: snapValue(crop.h * s, multiple, min, max),
	};
	crop = fitCropToAspect(crop, send.w / send.h, canvasW, canvasH);
	const scaleX = send.w / crop.w;
	const scaleY = send.h / crop.h;
	return { crop, send, scale: (scaleX + scaleY) / 2, scaleX, scaleY };
}

/** Maps a canvas-space rect into send space (floats). */
export function mapRectToSend(rect, crop, send) {
	const sx = send.w / crop.w;
	const sy = send.h / crop.h;
	return {
		x: (rect.x - crop.x) * sx,
		y: (rect.y - crop.y) * sy,
		w: rect.w * sx,
		h: rect.h * sy,
	};
}

/**
 * 1D coverage inside [a, b] for pixels 0..len-1 (pixel centers at i + 0.5), with an inward
 * linear ramp: value is 0 at the edge and reaches 1 at `fa` px (left/top) or `fb` px
 * (right/bottom) inside. A feather of 0 gives a hard edge. Outside [a, b] the value is 0.
 *
 * @returns {Float32Array}
 */
export function insideRamp1D(len, a, b, fa = 0, fb = fa) {
	const out = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		const p = i + 0.5;
		if (p < a || p > b) continue;
		const vl = fa > 0 ? Math.min(1, (p - a) / fa) : 1;
		const vr = fb > 0 ? Math.min(1, (b - p) / fb) : 1;
		out[i] = Math.min(vl, vr);
	}
	return out;
}

/**
 * 1D coverage for [a, b] with an outward ramp: 1 inside, fading to 0 over `f` px outside.
 * @returns {Float32Array}
 */
export function outwardRamp1D(len, a, b, f = 0) {
	const out = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		const p = i + 0.5;
		if (p >= a && p <= b) {
			out[i] = 1;
		} else if (f > 0) {
			const d = p < a ? a - p : p - b;
			out[i] = Math.max(0, 1 - d / f);
		}
	}
	return out;
}

/**
 * Per-side feather for clipping a result to its selection. Sides touching the canvas edge get
 * no feather (there is nothing to blend into). Feather is capped at a quarter of the short side.
 */
export function clipFeathers(region, canvasW, canvasH, feather) {
	const f = Math.max(0, Math.min(feather || 0, Math.floor(Math.min(region.w, region.h) / 4)));
	return {
		left: region.x <= 0 ? 0 : f,
		top: region.y <= 0 ? 0 : f,
		right: region.x + region.w >= canvasW ? 0 : f,
		bottom: region.y + region.h >= canvasH ? 0 : f,
	};
}

/**
 * Outpaint plan. Runware (FLUX Fill) needs seed width/height in multiples of 64, every
 * extension a multiple of 64, and final = seed + extensions <= 2048 per side. The canvas is
 * usually not a multiple of 64, so the seed is a scaled, snapped copy of the canvas and the
 * extensions are converted between send and canvas space.
 *
 * @param {{canvasW:number, canvasH:number, top?:number, right?:number, bottom?:number, left?:number,
 *          multiple?:number, min?:number, max?:number}} p  requested extensions in canvas px
 * @returns {{
 *   seed:{w:number,h:number}, final:{w:number,h:number},
 *   outpaint:{top:number,right:number,bottom:number,left:number},  // send px, multiples of 64
 *   ext:{top:number,right:number,bottom:number,left:number},       // canvas px
 *   newCanvas:{w:number,h:number}, scaleX:number, scaleY:number
 * }}
 */
export function computeOutpaint(p) {
	const multiple = p.multiple || 64;
	const min = p.min || 128;
	const max = p.max || 2048;
	const W = p.canvasW;
	const H = p.canvasH;
	if (!(W > 0) || !(H > 0)) throw new Error('canvas size must be > 0');
	const req = {};
	for (const side of ['top', 'right', 'bottom', 'left']) {
		req[side] = Math.max(0, Math.round(Number(p[side]) || 0));
	}
	if (req.top + req.right + req.bottom + req.left === 0) throw new Error('at least one outpaint side must be > 0');

	const upTo = (v) => (v > 0 ? Math.max(multiple, Math.ceil(v / multiple) * multiple) : 0);
	const totalW = W + req.left + req.right;
	const totalH = H + req.top + req.bottom;
	let s = Math.min(1, max / totalW, max / totalH);

	for (let attempt = 0; attempt < 64; attempt++) {
		const seed = {
			w: snapValue(W * s, multiple, min, max),
			h: snapValue(H * s, multiple, min, max),
		};
		const sx = seed.w / W;
		const sy = seed.h / H;
		const outpaint = {
			top: upTo(req.top * sy),
			right: upTo(req.right * sx),
			bottom: upTo(req.bottom * sy),
			left: upTo(req.left * sx),
		};
		const final = { w: seed.w + outpaint.left + outpaint.right, h: seed.h + outpaint.top + outpaint.bottom };
		if (final.w <= max && final.h <= max) {
			const ext = {
				top: Math.round(outpaint.top / sy),
				right: Math.round(outpaint.right / sx),
				bottom: Math.round(outpaint.bottom / sy),
				left: Math.round(outpaint.left / sx),
			};
			return {
				seed,
				final,
				outpaint,
				ext,
				newCanvas: { w: W + ext.left + ext.right, h: H + ext.top + ext.bottom },
				scaleX: sx,
				scaleY: sy,
			};
		}
		s *= 0.95;
	}
	throw new Error('Outpaint request does not fit in ' + max + ' px. Use smaller extensions.');
}
