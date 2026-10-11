/*
 * miniPaint layer effects renderer.
 *
 * render_layer_effects(ctx, layer, draw_fn) draws a layer together with its effects. draw_fn(c) must draw the
 * bare layer (no effects) onto c in document coordinates. The composite (effects under, layer, effects over)
 * is cached per layer id and only rebuilt when the layer or its effects change.
 * Order: drop shadow, outer glow, outside stroke, layer, inner shadow, inside stroke, bevel.
 */

import {
	active_effects, effect_box, cache_key, angle_offset, rgba, hex_to_rgb, bevel_shading, MAX_SIDE, clamp,
} from './effects-math.js';

const cache = new Map(); // layer id -> { key, canvas, x, y }

function make_canvas(w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

/** Same shape as src filled with a flat color. */
function tint(src, color, alpha) {
	const c = make_canvas(src.width, src.height);
	const g = c.getContext('2d');
	g.drawImage(src, 0, 0);
	g.globalCompositeOperation = 'source-in';
	g.globalAlpha = 1;
	g.fillStyle = rgba(color, alpha === undefined ? 1 : alpha);
	g.fillRect(0, 0, c.width, c.height);
	return c;
}

/** Blurred, offset, colored copy of src's alpha. The source itself is drawn off canvas, so only the shadow shows. */
function shadow_of(src, color, opacity, blur, dx, dy) {
	const c = make_canvas(src.width, src.height);
	const g = c.getContext('2d');
	g.shadowColor = rgba(color, opacity);
	g.shadowBlur = Math.max(0, blur);
	g.shadowOffsetX = dx + src.width;
	g.shadowOffsetY = dy;
	g.drawImage(src, -src.width, 0);
	return c;
}

/** Grows the alpha of src by r pixels (round brush), filled with color. */
function dilate(src, r, color, opacity) {
	const t = tint(src, color, 1);
	const c = make_canvas(src.width, src.height);
	const g = c.getContext('2d');
	g.drawImage(t, 0, 0);
	if (r > 0) {
		const rings = r > 4 ? [r, r * 0.5] : [r];
		for (const rr of rings) {
			const steps = clamp(Math.ceil(2 * Math.PI * rr * 1.2), 12, 160);
			for (let i = 0; i < steps; i++) {
				const a = (i / steps) * Math.PI * 2;
				g.drawImage(t, Math.cos(a) * rr, Math.sin(a) * rr);
			}
		}
	}
	if (opacity < 1) {
		g.globalCompositeOperation = 'source-in';
		g.fillStyle = rgba(color, opacity);
		g.fillRect(0, 0, c.width, c.height);
	}
	return c;
}

/** Fully opaque everywhere the silhouette is transparent. */
function inverse_of(sil) {
	const c = make_canvas(sil.width, sil.height);
	const g = c.getContext('2d');
	g.fillStyle = '#000';
	g.fillRect(0, 0, c.width, c.height);
	g.globalCompositeOperation = 'destination-out';
	g.drawImage(sil, 0, 0);
	return c;
}

function clip_to(canvas, sil) {
	const g = canvas.getContext('2d');
	g.globalCompositeOperation = 'destination-in';
	g.drawImage(sil, 0, 0);
	g.globalCompositeOperation = 'source-over';
	return canvas;
}

function knock_out(canvas, sil) {
	const g = canvas.getContext('2d');
	g.globalCompositeOperation = 'destination-out';
	g.drawImage(sil, 0, 0);
	g.globalCompositeOperation = 'source-over';
	return canvas;
}

function stroke_layers(sil, e) {
	const out = { under: null, over: null };
	if (e.position === 'outside') {
		out.under = knock_out(dilate(sil, e.size, e.color, e.opacity), sil);
	} else if (e.position === 'inside') {
		out.over = clip_to(dilate(inverse_of(sil), e.size, e.color, e.opacity), sil);
	} else {
		const half = e.size / 2;
		out.under = knock_out(dilate(sil, half, e.color, e.opacity), sil);
		out.over = clip_to(dilate(inverse_of(sil), half, e.color, e.opacity), sil);
	}
	return out;
}

function bevel_canvas(sil, e) {
	const w = sil.width;
	const h = sil.height;
	const img = sil.getContext('2d').getImageData(0, 0, w, h);
	const alpha = new Float32Array(w * h);
	for (let i = 0; i < alpha.length; i++) alpha[i] = img.data[i * 4 + 3] / 255;
	const { hi, lo } = bevel_shading(alpha, w, h, e);
	const hc = hex_to_rgb(e.highlight);
	const sc = hex_to_rgb(e.shadow);
	const out = new ImageData(w, h);
	for (let i = 0; i < alpha.length; i++) {
		const a = alpha[i];
		if (a === 0) continue;
		const ha = hi[i] * e.highlightOpacity;
		const sa = lo[i] * e.shadowOpacity;
		if (ha > 0) {
			out.data.set([hc.r, hc.g, hc.b, Math.round(ha * a * 255)], i * 4);
		} else if (sa > 0) {
			out.data.set([sc.r, sc.g, sc.b, Math.round(sa * a * 255)], i * 4);
		}
	}
	const c = make_canvas(w, h);
	c.getContext('2d').putImageData(out, 0, 0);
	return c;
}

/** Builds the composite canvas (box-sized) for a layer. Returns null when the box is unusable. */
function build(layer, effects, box, draw_fn) {
	const sil = make_canvas(box.w, box.h);
	const sg = sil.getContext('2d');
	sg.translate(-box.x, -box.y);
	draw_fn(sg);

	const out = make_canvas(box.w, box.h);
	const g = out.getContext('2d');
	const unders = [];
	const overs = [];

	for (const e of effects) {
		if (e.type === 'dropShadow') {
			const o = angle_offset(e.angle, e.distance);
			unders.push(shadow_of(sil, e.color, e.opacity, e.size, o.dx, o.dy));
		} else if (e.type === 'outerGlow') {
			unders.push(shadow_of(sil, e.color, e.opacity, e.size, 0, 0));
		} else if (e.type === 'stroke') {
			const s = stroke_layers(sil, e);
			if (s.under) unders.push(s.under);
			if (s.over) overs.push(s.over);
		} else if (e.type === 'innerShadow') {
			const o = angle_offset(e.angle, e.distance);
			overs.push(clip_to(shadow_of(inverse_of(sil), e.color, e.opacity, e.size, o.dx, o.dy), sil));
		}
	}
	// Glows and shadows first (rank by effect order), then the layer, then inner effects, bevel last.
	for (const u of unders) g.drawImage(u, 0, 0);
	g.drawImage(sil, 0, 0);
	for (const o of overs) g.drawImage(o, 0, 0);
	for (const e of effects) {
		if (e.type === 'bevel') g.drawImage(bevel_canvas(sil, e), 0, 0);
	}
	return out;
}

/**
 * Draws the layer with its effects onto ctx. Returns false when effects could not be rendered, so the caller
 * can fall back to drawing the bare layer.
 */
export function render_layer_effects(ctx, layer, draw_fn) {
	const effects = active_effects(layer);
	if (effects.length === 0) return false;
	const box = effect_box(layer, effects);
	if (!(box.w > 0 && box.h > 0) || box.w > MAX_SIDE || box.h > MAX_SIDE) return false;

	const id = layer.id;
	const cacheable = !layer.link_canvas; // link_canvas changes pixels without changing any tracked field
	const key = cache_key(layer, effects) + '|' + box.x + ',' + box.y + ',' + box.w + ',' + box.h;
	let entry = cacheable ? cache.get(id) : null;
	if (!entry || entry.key !== key) {
		const canvas = build(layer, effects, box, draw_fn);
		entry = { key, canvas, x: box.x, y: box.y };
		if (cacheable) cache.set(id, entry);
	}
	ctx.drawImage(entry.canvas, entry.x, entry.y);
	return true;
}

export function clear_effects_cache(id) {
	if (id === undefined) cache.clear();
	else cache.delete(id);
}
