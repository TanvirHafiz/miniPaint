/*
 * miniPaint layer effects: pure math and data helpers (no DOM, unit tested with node --test).
 */

export const EFFECT_TYPES = ['dropShadow', 'outerGlow', 'innerShadow', 'stroke', 'bevel'];

export const EFFECT_LABELS = {
	dropShadow: 'Drop Shadow',
	outerGlow: 'Outer Glow',
	innerShadow: 'Inner Shadow',
	stroke: 'Stroke',
	bevel: 'Bevel & Emboss',
};

export const EFFECT_DEFAULTS = {
	dropShadow: { type: 'dropShadow', enabled: true, color: '#000000', opacity: 0.6, angle: 120, distance: 8, size: 12 },
	outerGlow: { type: 'outerGlow', enabled: true, color: '#ffff99', opacity: 0.75, size: 14 },
	innerShadow: { type: 'innerShadow', enabled: true, color: '#000000', opacity: 0.6, angle: 120, distance: 6, size: 8 },
	stroke: { type: 'stroke', enabled: true, color: '#ffffff', opacity: 1, size: 3, position: 'outside' },
	bevel: { type: 'bevel', enabled: true, depth: 100, size: 6, angle: 120, altitude: 30, highlight: '#ffffff', highlightOpacity: 0.75, shadow: '#000000', shadowOpacity: 0.75 },
};

export const MAX_SIDE = 6000;

export function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

/** Full effect object for a type, filling missing or invalid fields from the defaults. */
export function normalize_effect(effect) {
	if (!effect || !EFFECT_DEFAULTS[effect.type]) return null;
	const out = Object.assign({}, EFFECT_DEFAULTS[effect.type]);
	for (const k of Object.keys(out)) {
		if (effect[k] === undefined || effect[k] === null) continue;
		if (typeof out[k] === 'number') {
			const n = Number(effect[k]);
			if (isFinite(n)) out[k] = n;
		} else {
			out[k] = effect[k];
		}
	}
	out.enabled = effect.enabled !== false;
	return out;
}

export function normalize_effects(list) {
	if (!Array.isArray(list)) return [];
	return list.map(normalize_effect).filter(Boolean);
}

export function active_effects(layer) {
	if (!layer || !Array.isArray(layer.effects)) return [];
	return normalize_effects(layer.effects).filter((e) => e.enabled);
}

export function has_effects(layer) {
	return !!layer && Array.isArray(layer.effects) && layer.effects.some((e) => e && e.enabled !== false && EFFECT_DEFAULTS[e.type]);
}

/** Shadow offset for a light angle in degrees (angle 120 = light from upper left, shadow falls lower right). */
export function angle_offset(angle, distance) {
	const a = (angle * Math.PI) / 180;
	return { dx: -Math.cos(a) * distance, dy: Math.sin(a) * distance };
}

/** Extra pixels needed around the layer box so outer effects are not clipped. */
export function effects_padding(effects) {
	let pad = 0;
	for (const e of effects) {
		if (e.type === 'dropShadow') pad = Math.max(pad, e.distance + e.size * 1.5);
		else if (e.type === 'outerGlow') pad = Math.max(pad, e.size * 1.5);
		else if (e.type === 'stroke') pad = Math.max(pad, e.size);
	}
	return Math.ceil(pad) + 3;
}

/** Axis-aligned bounds of a layer box (x, y, width, height, rotate in degrees about the center). */
export function layer_bounds(layer) {
	const cx = layer.x + layer.width / 2;
	const cy = layer.y + layer.height / 2;
	const r = ((layer.rotate || 0) * Math.PI) / 180;
	const c = Math.abs(Math.cos(r));
	const s = Math.abs(Math.sin(r));
	const w = layer.width * c + layer.height * s;
	const h = layer.width * s + layer.height * c;
	return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Integer canvas box (document coordinates) that holds the layer plus padding. */
export function effect_box(layer, effects) {
	const b = layer_bounds(layer);
	const pad = effects_padding(effects);
	const x = Math.floor(b.x - pad);
	const y = Math.floor(b.y - pad);
	return { x, y, w: Math.ceil(b.x + b.w + pad) - x, h: Math.ceil(b.y + b.h + pad) - y };
}

export function hex_to_rgb(hex) {
	let h = String(hex || '#000000').replace('#', '');
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	const n = parseInt(h.slice(0, 6), 16);
	if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex, alpha) {
	const c = hex_to_rgb(hex);
	return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp(alpha, 0, 1) + ')';
}

/**
 * Cache key: everything that changes the rendered pixels of the layer plus its effects.
 * Image pixels are identified by src length and tail, not hashed in full.
 */
export function cache_key(layer, effects) {
	const snap = {
		x: layer.x, y: layer.y, w: layer.width, h: layer.height, r: layer.rotate, t: layer.type,
		p: layer.params, c: layer.color, f: layer.filters, e: effects,
	};
	if (layer.type === 'image') {
		const src = (layer.link && layer.link.src) || '';
		snap.s = src.length + ':' + src.slice(-48);
		snap.n = layer.link ? layer.link.width + 'x' + layer.link.height : '';
	} else {
		snap.d = layer.data;
	}
	return JSON.stringify(snap);
}

/** In-place separable box blur of a Float32Array (one pass, radius r). Outside the array counts as zero. */
export function box_blur(src, w, h, r) {
	r = Math.round(r);
	if (r < 1) return src;
	const tmp = new Float32Array(src.length);
	const norm = 1 / (2 * r + 1);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let acc = 0;
		for (let x = 0; x <= r; x++) if (x < w) acc += src[row + x];
		for (let x = 0; x < w; x++) {
			tmp[row + x] = acc * norm;
			const add = x + r + 1;
			const sub = x - r;
			if (add < w) acc += src[row + add];
			if (sub >= 0) acc -= src[row + sub];
		}
	}
	for (let x = 0; x < w; x++) {
		let acc = 0;
		for (let y = 0; y <= r; y++) if (y < h) acc += tmp[y * w + x];
		for (let y = 0; y < h; y++) {
			src[y * w + x] = acc * norm;
			const add = y + r + 1;
			const sub = y - r;
			if (add < h) acc += tmp[add * w + x];
			if (sub >= 0) acc -= tmp[sub * w + x];
		}
	}
	return src;
}

/**
 * Bevel shading. alpha: Float32Array 0..1 silhouette. Returns {hi, lo}: Float32Arrays 0..1 strength
 * of highlight and shadow per pixel (before color and opacity are applied).
 */
export function bevel_shading(alpha, w, h, e) {
	const height = Float32Array.from(alpha);
	const r = Math.max(1, Math.round(e.size / 2));
	box_blur(height, w, h, r);
	box_blur(height, w, h, r);
	box_blur(height, w, h, r);
	const az = (e.angle * Math.PI) / 180;
	const alt = (clamp(e.altitude, 0, 90) * Math.PI) / 180;
	const lx = Math.cos(az) * Math.cos(alt);
	const ly = -Math.sin(az) * Math.cos(alt);
	const lz = Math.sin(alt);
	const scale = Math.max(0.1, e.size) * (e.depth / 100) * 1.5;
	const hi = new Float32Array(w * h);
	const lo = new Float32Array(w * h);
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const gx = (height[i + 1] - height[i - 1]) * 0.5 * scale;
			const gy = (height[i + w] - height[i - w]) * 0.5 * scale;
			const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
			const d = (-gx * lx - gy * ly + lz) * inv - lz;
			if (d > 0) hi[i] = Math.min(1, d * 2.5);
			else lo[i] = Math.min(1, -d * 2.5);
		}
	}
	return { hi, lo };
}
