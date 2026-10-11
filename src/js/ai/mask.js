/*
 * miniPaint AI: the AI mask. One document-sized alpha mask (config.WIDTH x config.HEIGHT) that holds
 * the free-form area an AI edit should touch (lasso, polygon, ellipse, wand, brush ...).
 *
 * Kept outside miniPaint's undo history on purpose (editing a mask is not a document change); it has
 * its own small undo stack. The mask is cleared when the document size changes (resize, outpaint, upscale).
 */

import config from '../config.js';
import * as M from './mask-math.js';
import { flattenToCanvas } from './canvas-io.js';

const MAX_UNDO = 20;

export class Mask_store {

	constructor() {
		this.w = 0;
		this.h = 0;
		this.alpha = null;
		this.version = 0;
		this.undoStack = [];
		this.listeners = new Set();
		this.cache = { version: -1, bounds: null };
	}

	/** Re-creates the mask when the document size changed. Call before every read or write. */
	ensure() {
		if (this.alpha && this.w === config.WIDTH && this.h === config.HEIGHT) return;
		this.w = config.WIDTH;
		this.h = config.HEIGHT;
		this.alpha = new Uint8Array(this.w * this.h);
		this.undoStack = [];
		this.touch();
	}

	on_change(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	touch() {
		this.version++;
		for (const fn of this.listeners) {
			try { fn(this); } catch (e) { console.log('mask listener failed', e); }
		}
	}

	push_undo() {
		this.undoStack.push(Uint8Array.from(this.alpha));
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
	}

	undo() {
		this.ensure();
		const prev = this.undoStack.pop();
		if (!prev) return false;
		this.alpha = prev;
		this.touch();
		return true;
	}

	bounds() {
		this.ensure();
		if (this.cache.version !== this.version) {
			this.cache = { version: this.version, bounds: M.bbox_of(this.alpha, this.w, this.h) };
		}
		return this.cache.bounds;
	}

	is_empty() {
		return this.bounds() === null;
	}

	coverage() {
		this.ensure();
		return M.coverage(this.alpha);
	}

	clear() {
		this.ensure();
		if (this.is_empty()) return;
		this.push_undo();
		this.alpha.fill(0);
		this.touch();
	}

	invert() {
		this.ensure();
		this.push_undo();
		M.invert(this.alpha);
		this.touch();
	}

	feather(r) {
		this.ensure();
		this.push_undo();
		this.alpha = M.feather(this.alpha, this.w, this.h, r);
		this.touch();
	}

	grow(r) {
		this.ensure();
		this.push_undo();
		this.alpha = Uint8Array.from(M.grow(this.alpha, this.w, this.h, r));
		this.touch();
	}

	shrink(r) {
		this.ensure();
		this.push_undo();
		this.alpha = Uint8Array.from(M.shrink(this.alpha, this.w, this.h, r));
		this.touch();
	}

	/** Merges a document-sized canvas (its alpha channel) into the mask. mode: replace, add, subtract, intersect. */
	apply_canvas(canvas, mode = 'replace') {
		this.ensure();
		const px = canvas.getContext('2d').getImageData(0, 0, this.w, this.h).data;
		const src = new Uint8Array(this.w * this.h);
		for (let i = 0; i < src.length; i++) src[i] = px[i * 4 + 3];
		this.apply_array(src, mode);
	}

	apply_array(src, mode = 'replace') {
		this.ensure();
		this.push_undo();
		M.combine(this.alpha, src, mode);
		this.touch();
	}

	/** Magic wand on the flattened visible document. */
	wand(x, y, tolerance, contiguous, mode = 'replace') {
		this.ensure();
		const flat = flattenToCanvas({ source: 'visible' });
		const px = flat.getContext('2d').getImageData(0, 0, this.w, this.h).data;
		this.apply_array(M.wand(px, this.w, this.h, x, y, tolerance, contiguous), mode);
	}

	/** Mask from a rectangle (document px), for example the Select tool's rectangle. */
	from_rect(rect, mode = 'replace') {
		this.ensure();
		const src = new Uint8Array(this.w * this.h);
		const x0 = Math.max(0, Math.floor(rect.x));
		const y0 = Math.max(0, Math.floor(rect.y));
		const x1 = Math.min(this.w, Math.ceil(rect.x + rect.w));
		const y1 = Math.min(this.h, Math.ceil(rect.y + rect.h));
		for (let y = y0; y < y1; y++) src.fill(255, y * this.w + x0, y * this.w + x1);
		this.apply_array(src, mode);
	}

	/** White canvas whose alpha is the mask, document sized. */
	to_canvas() {
		this.ensure();
		const c = document.createElement('canvas');
		c.width = this.w;
		c.height = this.h;
		const ctx = c.getContext('2d');
		const img = ctx.createImageData(this.w, this.h);
		for (let i = 0; i < this.alpha.length; i++) {
			const o = i * 4;
			img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
			img.data[o + 3] = this.alpha[i];
		}
		ctx.putImageData(img, 0, 0);
		return c;
	}

	/**
	 * Snapshot for an AI run: the bounding box as an AI region plus the mask canvas. Taken when Run is
	 * pressed so later edits of the mask do not affect a running request.
	 * @returns {{region:{x,y,w,h}, canvas:HTMLCanvasElement}|null}
	 */
	snapshot(minSize = 8) {
		const b = this.bounds();
		if (!b || b.w < minSize || b.h < minSize) return null;
		return { region: { x: b.x, y: b.y, w: b.w, h: b.h }, canvas: this.to_canvas() };
	}
}

export const mask = new Mask_store();
