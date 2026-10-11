/*
 * miniPaint AI: mask editor. Draws the AI mask as a red overlay on the canvas and provides the tools
 * that edit it: rectangle, lasso, polygonal lasso, ellipse, magic wand, brush and eraser.
 *
 * It does not use miniPaint's tool system (those clear the selection on tool change and know nothing about
 * masks). While a mask tool is active a transparent overlay canvas sits above the editor canvas and
 * receives the pointer events; wheel events still bubble to #main_wrapper so zoom keeps working.
 */

import zoomView from '../libs/zoomView.js';
import config from '../config.js';
import { mask as store } from './mask.js';

export const TOOLS = [
	['rect', 'Rect', 'Drag a rectangle'],
	['lasso', 'Lasso', 'Drag to draw a free-hand outline'],
	['poly', 'Polygon', 'Click points. Double-click, Enter or click the first point to close. Esc cancels'],
	['ellipse', 'Ellipse', 'Drag an ellipse'],
	['wand', 'Wand', 'Click to select similar colors'],
	['brush', 'Brush', 'Paint the area. [ and ] change the size'],
	['eraser', 'Eraser', 'Erase from the mask. [ and ] change the size'],
];

const TINT = [232, 60, 60];
const TINT_ALPHA = 0.45;

function make_canvas(w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export class Mask_editor {

	constructor() {
		this.tool = null;
		this.mode = 'replace'; // replace, add, subtract
		this.brushSize = 40;
		this.tolerance = 32;
		this.contiguous = true;
		this.show = true;
		this.overlay = null;
		this.ctx = null;
		this.raf = null;
		this.tint = { version: -1, canvas: null };
		this.drag = null; // current gesture
		this.poly = null; // polygon points in world coords
		this.hover = null; // pointer in world coords
		this.listeners = new Set();
		store.on_change(() => {
			this.ensure_overlay();
			this.schedule();
			this.emit();
		});
	}

	on_change(fn) {
		this.listeners.add(fn);
	}

	emit() {
		for (const fn of this.listeners) fn(this);
	}

	/* ------------------------------------------------------------ state */

	set_tool(tool) {
		if (tool === this.tool) tool = null;
		this.cancel_gesture();
		this.tool = tool;
		this.ensure_overlay();
		this.overlay.style.pointerEvents = tool ? 'auto' : 'none';
		this.overlay.style.cursor = tool ? 'crosshair' : 'default';
		this.schedule();
		this.emit();
	}

	set_show(show) {
		this.show = show;
		this.schedule();
		this.emit();
	}

	/* ------------------------------------------------------------ overlay */

	ensure_overlay() {
		if (this.overlay) return;
		const wrapper = document.getElementById('main_wrapper') || document.body;
		this.overlay = document.createElement('canvas');
		this.overlay.className = 'ai_mask_overlay';
		this.overlay.style.pointerEvents = 'none';
		wrapper.appendChild(this.overlay);
		this.ctx = this.overlay.getContext('2d');
		const o = this.overlay;
		o.addEventListener('pointerdown', (e) => this.pointer_down(e));
		o.addEventListener('pointermove', (e) => this.pointer_move(e));
		o.addEventListener('pointerup', (e) => this.pointer_up(e));
		o.addEventListener('pointercancel', () => this.cancel_gesture());
		o.addEventListener('pointerleave', () => { this.hover = null; });
		o.addEventListener('dblclick', (e) => {
			if (this.tool === 'poly') {
				e.preventDefault();
				this.finish_poly();
			}
		});
		o.addEventListener('contextmenu', (e) => e.preventDefault());
		// Capture phase on window so the mask undo wins over miniPaint's document level Ctrl+Z.
		window.addEventListener('keydown', (e) => this.key_down(e), true);
	}

	needs_frames() {
		return !!this.tool || (this.show && !store.is_empty()) || !!this.drag;
	}

	schedule() {
		if (this.raf || !this.overlay) return;
		const tick = () => {
			this.raf = null;
			this.render();
			if (this.needs_frames()) this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);
	}

	canvas_rect() {
		const canvas = document.getElementById('canvas_minipaint');
		return canvas ? canvas.getBoundingClientRect() : null;
	}

	/** Pointer event to document coordinates (not rounded). */
	to_world(e) {
		const r = this.canvas_rect();
		return zoomView.toWorld(e.clientX - r.left, e.clientY - r.top);
	}

	world_to_overlay(p) {
		return zoomView.toScreen({ x: p.x, y: p.y });
	}

	tint_canvas() {
		store.ensure();
		if (this.tint.version === store.version && this.tint.canvas) return this.tint.canvas;
		const c = make_canvas(store.w, store.h);
		const ctx = c.getContext('2d');
		const img = ctx.createImageData(store.w, store.h);
		for (let i = 0; i < store.alpha.length; i++) {
			const o = i * 4;
			img.data[o] = TINT[0];
			img.data[o + 1] = TINT[1];
			img.data[o + 2] = TINT[2];
			img.data[o + 3] = Math.round(store.alpha[i] * TINT_ALPHA);
		}
		ctx.putImageData(img, 0, 0);
		this.tint = { version: store.version, canvas: c };
		return c;
	}

	render() {
		if (!this.overlay) return;
		const r = this.canvas_rect();
		if (!r) return;
		const o = this.overlay;
		const s = o.style;
		s.position = 'fixed';
		s.left = r.left + 'px';
		s.top = r.top + 'px';
		s.width = r.width + 'px';
		s.height = r.height + 'px';
		s.zIndex = 40;
		const w = Math.max(1, Math.round(r.width));
		const h = Math.max(1, Math.round(r.height));
		if (o.width !== w || o.height !== h) {
			o.width = w;
			o.height = h;
		}
		const ctx = this.ctx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const scale = zoomView.getScale();

		if (this.show && !store.is_empty()) {
			const a = this.world_to_overlay({ x: 0, y: 0 });
			ctx.imageSmoothingEnabled = scale < 1;
			ctx.drawImage(this.tint_canvas(), a.x, a.y, store.w * scale, store.h * scale);
		}
		if (this.drag && this.drag.kind === 'paint') {
			const a = this.world_to_overlay({ x: 0, y: 0 });
			ctx.globalAlpha = 0.5;
			ctx.drawImage(this.drag.canvas, a.x, a.y, store.w * scale, store.h * scale);
			ctx.globalAlpha = 1;
		}
		this.draw_shape_preview(ctx);
		this.draw_cursor(ctx, scale);
	}

	outline(ctx) {
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
		ctx.lineDashOffset = 5;
		ctx.strokeStyle = '#000000';
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.lineDashOffset = 0;
	}

	draw_shape_preview(ctx) {
		const d = this.drag;
		if (d && (d.kind === 'rect' || d.kind === 'ellipse')) {
			const a = this.world_to_overlay(d.start);
			const b = this.world_to_overlay(d.end);
			ctx.beginPath();
			if (d.kind === 'rect') ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
			else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
			this.outline(ctx);
		} else if (d && d.kind === 'lasso' && d.points.length > 1) {
			ctx.beginPath();
			d.points.forEach((p, i) => {
				const q = this.world_to_overlay(p);
				if (i === 0) ctx.moveTo(q.x, q.y);
				else ctx.lineTo(q.x, q.y);
			});
			ctx.closePath();
			this.outline(ctx);
		} else if (this.poly && this.poly.length) {
			ctx.beginPath();
			this.poly.forEach((p, i) => {
				const q = this.world_to_overlay(p);
				if (i === 0) ctx.moveTo(q.x, q.y);
				else ctx.lineTo(q.x, q.y);
			});
			if (this.hover) {
				const q = this.world_to_overlay(this.hover);
				ctx.lineTo(q.x, q.y);
			}
			this.outline(ctx);
			const f = this.world_to_overlay(this.poly[0]);
			ctx.beginPath();
			ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
			ctx.fillStyle = '#ffffff';
			ctx.fill();
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}

	draw_cursor(ctx, scale) {
		if ((this.tool !== 'brush' && this.tool !== 'eraser') || !this.hover) return;
		const q = this.world_to_overlay(this.hover);
		ctx.beginPath();
		ctx.arc(q.x, q.y, (this.brushSize * scale) / 2, 0, Math.PI * 2);
		ctx.lineWidth = 1;
		ctx.strokeStyle = '#ffffff';
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(q.x, q.y, (this.brushSize * scale) / 2 + 1, 0, Math.PI * 2);
		ctx.strokeStyle = '#000000';
		ctx.stroke();
	}

	/* ------------------------------------------------------------ gestures */

	effective_mode(e) {
		if (e.altKey) return 'subtract';
		if (e.shiftKey) return 'add';
		return this.mode;
	}

	pointer_down(e) {
		if (!this.tool || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		store.ensure();
		const p = this.to_world(e);
		this.hover = p;
		const mode = this.effective_mode(e);
		const t = this.tool;
		if (t === 'wand') {
			store.wand(p.x, p.y, this.tolerance, this.contiguous, mode);
			this.schedule();
			return;
		}
		if (t === 'poly') {
			if (this.poly && this.poly.length >= 3) {
				const f = this.world_to_overlay(this.poly[0]);
				const c = this.world_to_overlay(p);
				if (Math.hypot(f.x - c.x, f.y - c.y) < 8) {
					this.finish_poly();
					return;
				}
			}
			if (!this.poly) {
				this.poly = [];
				this.polyMode = mode;
			}
			this.poly.push({ x: p.x, y: p.y });
			this.schedule();
			return;
		}
		try { this.overlay.setPointerCapture(e.pointerId); } catch (err) {} // synthetic events have no active pointer
		if (t === 'rect' || t === 'ellipse') {
			this.drag = { kind: t, start: p, end: p, mode };
		} else if (t === 'lasso') {
			this.drag = { kind: 'lasso', points: [p], mode };
		} else if (t === 'brush' || t === 'eraser') {
			const canvas = make_canvas(store.w, store.h);
			this.drag = { kind: 'paint', canvas, last: p, mode: t === 'brush' ? 'add' : 'subtract' };
			this.paint_to(p, p);
		}
		this.schedule();
	}

	pointer_move(e) {
		if (!this.tool) return;
		const p = this.to_world(e);
		this.hover = p;
		const d = this.drag;
		if (!d) return;
		if (d.kind === 'rect' || d.kind === 'ellipse') d.end = p;
		else if (d.kind === 'lasso') {
			const last = d.points[d.points.length - 1];
			if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5 / Math.max(0.05, zoomView.getScale())) d.points.push(p);
		} else if (d.kind === 'paint') {
			this.paint_to(d.last, p);
			d.last = p;
		}
	}

	pointer_up(e) {
		const d = this.drag;
		if (!d) return;
		this.drag = null;
		try { this.overlay.releasePointerCapture(e.pointerId); } catch (err) {}
		const p = this.to_world(e);
		if (d.kind === 'rect' || d.kind === 'ellipse') {
			d.end = p;
			const x = Math.min(d.start.x, d.end.x);
			const y = Math.min(d.start.y, d.end.y);
			const w = Math.abs(d.end.x - d.start.x);
			const h = Math.abs(d.end.y - d.start.y);
			if (w < 2 || h < 2) return;
			this.commit_shape(d.mode, (ctx) => {
				ctx.beginPath();
				if (d.kind === 'rect') ctx.rect(x, y, w, h);
				else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
				ctx.fill();
			});
		} else if (d.kind === 'lasso') {
			if (d.points.length < 3) return;
			this.commit_polygon(d.points, d.mode);
		} else if (d.kind === 'paint') {
			store.apply_canvas(d.canvas, d.mode);
		}
		this.schedule();
	}

	paint_to(a, b) {
		const ctx = this.drag.canvas.getContext('2d');
		ctx.strokeStyle = '#ffffff';
		ctx.fillStyle = '#ffffff';
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = this.brushSize;
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(b.x, b.y, this.brushSize / 2, 0, Math.PI * 2);
		ctx.fill();
	}

	commit_shape(mode, draw) {
		const c = make_canvas(store.w, store.h);
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#ffffff';
		draw(ctx);
		store.apply_canvas(c, mode);
	}

	commit_polygon(points, mode) {
		this.commit_shape(mode, (ctx) => {
			ctx.beginPath();
			points.forEach((p, i) => {
				if (i === 0) ctx.moveTo(p.x, p.y);
				else ctx.lineTo(p.x, p.y);
			});
			ctx.closePath();
			ctx.fill();
		});
	}

	finish_poly() {
		const pts = this.poly;
		this.poly = null;
		if (pts && pts.length >= 3) this.commit_polygon(pts, this.polyMode || 'replace');
		this.schedule();
	}

	cancel_gesture() {
		this.drag = null;
		this.poly = null;
	}

	/* ------------------------------------------------------------ keyboard */

	key_down(e) {
		if (!this.tool) return;
		const t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
		if (e.key === 'Enter' && this.poly) {
			e.preventDefault();
			e.stopPropagation();
			this.finish_poly();
		} else if (e.key === 'Escape') {
			e.stopPropagation();
			if (this.drag || this.poly) this.cancel_gesture();
			else this.set_tool(null);
		} else if (e.key === '[' || e.key === ']') {
			this.brushSize = Math.max(2, Math.min(400, Math.round(this.brushSize * (e.key === ']' ? 1.2 : 1 / 1.2))));
			e.stopPropagation();
			this.emit();
		} else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && store.undoStack.length) {
			e.preventDefault();
			e.stopPropagation(); // do not also undo the document
			store.undo();
		}
	}
}

export const editor = new Mask_editor();

/** Mask size of the current document, used by tests and the UI. */
export function document_size() {
	return { w: config.WIDTH, h: config.HEIGHT };
}
