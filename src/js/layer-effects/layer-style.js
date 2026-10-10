/*
 * miniPaint layer effects: Layer Style dialog (live preview), copy / paste / clear style.
 * Edits are previewed by writing layer.effects directly; OK commits one Update_layer_action (one undo step),
 * Cancel restores the original array.
 */

import app from './../app.js';
import config from './../config.js';
import './layer-style.css';
import {
	EFFECT_TYPES, EFFECT_LABELS, EFFECT_DEFAULTS, normalize_effect, normalize_effects,
} from './effects-math.js';

// Field specs per effect type: [key, label, kind, min, max, step]
const FIELDS = {
	dropShadow: [['color', 'Color', 'color'], ['opacity', 'Opacity', 'range', 0, 1, 0.05], ['angle', 'Angle', 'range', 0, 360, 1], ['distance', 'Distance', 'range', 0, 100, 1], ['size', 'Blur', 'range', 0, 100, 1]],
	outerGlow: [['color', 'Color', 'color'], ['opacity', 'Opacity', 'range', 0, 1, 0.05], ['size', 'Size', 'range', 0, 100, 1]],
	innerShadow: [['color', 'Color', 'color'], ['opacity', 'Opacity', 'range', 0, 1, 0.05], ['angle', 'Angle', 'range', 0, 360, 1], ['distance', 'Distance', 'range', 0, 60, 1], ['size', 'Blur', 'range', 0, 60, 1]],
	stroke: [['color', 'Color', 'color'], ['opacity', 'Opacity', 'range', 0, 1, 0.05], ['size', 'Size', 'range', 1, 60, 1], ['position', 'Position', 'select', ['outside', 'inside', 'center']]],
	bevel: [['depth', 'Depth', 'range', 10, 300, 5], ['size', 'Size', 'range', 1, 40, 1], ['angle', 'Angle', 'range', 0, 360, 1], ['altitude', 'Altitude', 'range', 0, 90, 1], ['highlight', 'Highlight', 'color'], ['highlightOpacity', 'Highlight opacity', 'range', 0, 1, 0.05], ['shadow', 'Shadow', 'color'], ['shadowOpacity', 'Shadow opacity', 'range', 0, 1, 0.05]],
};

let style_clipboard = null;

function clone(v) {
	return JSON.parse(JSON.stringify(v));
}

class Layer_style_class {

	constructor() {
		this.el = null;
		this.layer_id = null;
		this.original = null; // effects array before the dialog opened
		this.working = null; // normalized effects, one per type
	}

	get_layer() {
		return this.layer_id ? app.Layers.get_layer(this.layer_id) : null;
	}

	/** Menu target: layer/style.open */
	open(layer_id) {
		const layer = layer_id ? app.Layers.get_layer(layer_id) : config.layer;
		if (!layer) return;
		this.close(true);
		this.layer_id = layer.id;
		this.original = clone(layer.effects || []);
		const existing = normalize_effects(layer.effects);
		this.working = {};
		for (const t of EFFECT_TYPES) {
			const found = existing.find((e) => e.type === t);
			this.working[t] = found ? found : Object.assign(clone(EFFECT_DEFAULTS[t]), { enabled: false });
		}
		this.build(layer);
	}

	build(layer) {
		const el = document.createElement('div');
		el.className = 'layer_style';
		let html = '<div class="ls_head"><span>Layer Style: ' + this.escape(layer.name) + '</span><button type="button" class="ls_x" data-act="cancel" title="Cancel">&times;</button></div>';
		html += '<div class="ls_body">';
		for (const t of EFFECT_TYPES) {
			const e = this.working[t];
			html += '<div class="ls_sec" data-type="' + t + '">';
			html += '<label class="ls_title"><input type="checkbox" data-enable="' + t + '"' + (e.enabled ? ' checked' : '') + '> ' + EFFECT_LABELS[t] + '</label>';
			html += '<div class="ls_fields">';
			for (const f of FIELDS[t]) {
				html += '<div class="ls_row"><span>' + f[1] + '</span>' + this.field_html(t, f, e[f[0]]) + '</div>';
			}
			html += '</div></div>';
		}
		html += '</div>';
		html += '<div class="ls_foot"><button type="button" data-act="reset">Clear all</button><span class="ls_sp"></span><button type="button" data-act="cancel">Cancel</button><button type="button" class="ls_ok" data-act="ok">OK</button></div>';
		el.innerHTML = html;
		document.body.appendChild(el);
		this.el = el;

		el.addEventListener('keydown', (ev) => {
			ev.stopPropagation(); // keep editor shortcuts (N, D, S ...) out of the dialog
			if (ev.key === 'Escape') this.cancel();
			if (ev.key === 'Enter' && ev.target.tagName !== 'BUTTON') this.ok();
		});
		el.addEventListener('input', (ev) => this.on_input(ev));
		el.addEventListener('change', (ev) => this.on_input(ev));
		el.addEventListener('click', (ev) => {
			const act = ev.target.dataset && ev.target.dataset.act;
			if (act === 'ok') this.ok();
			else if (act === 'cancel') this.cancel();
			else if (act === 'reset') this.clear_all();
		});
		this.sync_sections();
	}

	field_html(type, f, value) {
		const key = 'data-type="' + type + '" data-key="' + f[0] + '"';
		if (f[2] === 'color') return '<input type="color" ' + key + ' value="' + this.escape(value) + '">';
		if (f[2] === 'select') {
			return '<select ' + key + '>' + f[3].map((o) => '<option' + (o === value ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
		}
		return '<input type="range" ' + key + ' min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '" value="' + value + '"><output>' + value + '</output>';
	}

	on_input(ev) {
		const t = ev.target;
		if (t.dataset.enable) {
			this.working[t.dataset.enable].enabled = t.checked;
			this.sync_sections();
		} else if (t.dataset.key) {
			const spec = FIELDS[t.dataset.type].find((f) => f[0] === t.dataset.key);
			this.working[t.dataset.type][t.dataset.key] = spec[2] === 'range' ? Number(t.value) : t.value;
			const out = t.nextElementSibling;
			if (out && out.tagName === 'OUTPUT') out.textContent = t.value;
			// Touching a field of a disabled effect turns it on.
			if (!this.working[t.dataset.type].enabled) {
				this.working[t.dataset.type].enabled = true;
				this.el.querySelector('[data-enable="' + t.dataset.type + '"]').checked = true;
				this.sync_sections();
			}
		} else {
			return;
		}
		this.preview();
	}

	sync_sections() {
		for (const sec of this.el.querySelectorAll('.ls_sec')) {
			sec.classList.toggle('off', !this.working[sec.dataset.type].enabled);
		}
	}

	current_effects() {
		return EFFECT_TYPES.filter((t) => this.working[t].enabled).map((t) => clone(this.working[t]));
	}

	preview() {
		const layer = this.get_layer();
		if (!layer) return;
		layer.effects = this.current_effects();
		config.need_render = true;
	}

	ok() {
		const layer = this.get_layer();
		if (!layer) return this.close(true);
		const next = this.current_effects();
		layer.effects = clone(this.original); // restore so the action records the true previous value
		if (JSON.stringify(next) !== JSON.stringify(this.original)) {
			app.State.do_action(new app.Actions.Update_layer_action(layer.id, { effects: next }));
		}
		this.close(true);
	}

	cancel() {
		const layer = this.get_layer();
		if (layer) layer.effects = clone(this.original);
		config.need_render = true;
		this.close(true);
	}

	clear_all() {
		for (const t of EFFECT_TYPES) this.working[t].enabled = false;
		for (const cb of this.el.querySelectorAll('[data-enable]')) cb.checked = false;
		this.sync_sections();
		this.preview();
	}

	close() {
		if (this.el) this.el.remove();
		this.el = null;
		this.layer_id = null;
	}

	escape(s) {
		return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	}

	// Menu targets: layer/style.copy, layer/style.paste, layer/style.clear

	copy() {
		const layer = config.layer;
		if (!layer) return;
		style_clipboard = clone(normalize_effects(layer.effects));
	}

	paste() {
		const layer = config.layer;
		if (!layer || !style_clipboard) return;
		app.State.do_action(new app.Actions.Update_layer_action(layer.id, { effects: clone(style_clipboard) }));
	}

	clear() {
		const layer = config.layer;
		if (!layer || !(layer.effects || []).length) return;
		app.State.do_action(new app.Actions.Update_layer_action(layer.id, { effects: [] }));
	}
}

export default Layer_style_class;
