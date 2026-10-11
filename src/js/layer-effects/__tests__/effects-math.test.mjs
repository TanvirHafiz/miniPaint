import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../effects-math.js';

test('normalize fills defaults and drops unknown types', () => {
	const e = m.normalize_effect({ type: 'stroke', size: '5' });
	assert.equal(e.size, 5);
	assert.equal(e.position, 'outside');
	assert.equal(e.enabled, true);
	assert.equal(m.normalize_effect({ type: 'nope' }), null);
	assert.deepEqual(m.normalize_effects('x'), []);
});

test('has_effects ignores disabled and unknown', () => {
	assert.equal(m.has_effects({ effects: [{ type: 'stroke', enabled: false }] }), false);
	assert.equal(m.has_effects({ effects: [{ type: 'bevel' }] }), true);
	assert.equal(m.has_effects({}), false);
});

test('angle 120 puts the shadow lower right', () => {
	const o = m.angle_offset(120, 10);
	assert.ok(o.dx > 0 && o.dy > 0);
});

test('effect box contains rotated layer plus padding', () => {
	const layer = { x: 100, y: 100, width: 200, height: 50, rotate: 90 };
	const eff = m.normalize_effects([{ type: 'dropShadow' }]);
	const b = m.effect_box(layer, eff);
	const bounds = m.layer_bounds(layer);
	assert.ok(b.x <= bounds.x && b.y <= bounds.y);
	assert.ok(b.x + b.w >= bounds.x + bounds.w && b.y + b.h >= bounds.y + bounds.h);
});

test('cache key changes with effects and with image src', () => {
	const l = { x: 0, y: 0, width: 5, height: 5, rotate: 0, type: 'image', link: { src: 'data:abc', width: 5, height: 5 } };
	const a = m.cache_key(l, [{ type: 'stroke', size: 1 }]);
	assert.notEqual(a, m.cache_key(l, [{ type: 'stroke', size: 2 }]));
	assert.notEqual(a, m.cache_key({ ...l, link: { src: 'data:abcd', width: 5, height: 5 } }, [{ type: 'stroke', size: 1 }]));
	assert.equal(a, m.cache_key(l, [{ type: 'stroke', size: 1 }]));
});

test('bevel lights the edge facing the light and shades the opposite edge', () => {
	const w = 40, h = 40;
	const a = new Float32Array(w * h);
	for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) a[y * w + x] = 1;
	const { hi, lo } = m.bevel_shading(a, w, h, { ...m.EFFECT_DEFAULTS.bevel, angle: 180, size: 6 });
	assert.ok(hi[20 * w + 10] > 0.05 && lo[20 * w + 10] < 0.01);
	assert.ok(lo[20 * w + 29] > 0.05 && hi[20 * w + 29] < 0.01);
	assert.equal(hi[20 * w + 20], 0);
});
