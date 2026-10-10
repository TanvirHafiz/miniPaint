/*
 * miniPaint AI: Phase 1 UI (Generate dialog, Runware settings / test connection).
 * Phase 3 replaces the dialog with a docked AI panel; the client and models stay the same.
 */

import app from '../app.js';
import config from '../config.js';
import Dialog_class from '../libs/popup.js';
import Helper_class from '../libs/helpers.js';
import alertify from '../../../node_modules/alertifyjs/build/alertify.min.js';
import { generate, health, formatCost, RunwareError, diagnoseRequestFormat, getRequestFormat, resetRequestFormat } from './runware-client.js';
import { MODELS, pickModel, sizeRuleFor, getModelInfo, INPUT_STYLE } from './models.js';
import { snapSize } from './size.js';

const PREFS_KEY = 'minipaint_ai_prefs';
const PRESETS = ['Fast', 'Quality'];

/** In-memory session cost (USD). Not persisted. */
export const session = {
	cost: 0,
	generations: 0,
};

function load_prefs() {
	try {
		return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
	} catch (e) {
		return {};
	}
}

function save_prefs(prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify({ ...load_prefs(), ...prefs }));
	} catch (e) {}
}

function short_prompt(prompt, max = 30) {
	const clean = String(prompt).replace(/\s+/g, ' ').trim();
	return clean.length > max ? clean.slice(0, max) : clean;
}

export class AI_generate_class {

	constructor() {
		this.POP = new Dialog_class();
		this.Helper = new Helper_class();
		this.controller = null;
		this.running = false;
	}

	/**
	 * Generate dialog: prompt, Fast/Quality, size, number of results.
	 */
	show_generate() {
		if (this.running) {
			alertify.message('A generation is already running.');
			return;
		}
		const prefs = load_prefs();
		const _this = this;
		const canvas_w = config.WIDTH || 1024;
		const canvas_h = config.HEIGHT || 1024;
		// Multiples of 64 satisfy both the 16 and 64 rules used by the generate models.
		const initial = snapSize(canvas_w, canvas_h, 64);

		this.POP.show({
			title: 'AI Generate',
			params: [
				{ name: 'prompt', title: 'Prompt:', type: 'textarea', value: prefs.last_prompt || '', placeholder: 'Describe the image', prevent_submission: true },
				{ name: 'preset', title: 'Model:', type: 'select', values: PRESETS, value: prefs.preset || 'Fast' },
				{ name: 'width', title: 'Width:', value: initial.width, prevent_submission: true, comment: 'canvas ' + canvas_w },
				{ name: 'height', title: 'Height:', value: initial.height, prevent_submission: true, comment: 'canvas ' + canvas_h },
				{ name: 'count', title: 'Results:', type: 'select', values: ['1', '2', '3', '4'], value: String(prefs.count || 1) },
				{ title: 'Status:', html: '<span id="ai_gen_status">Ready. Ctrl+Enter to generate, Escape to cancel.</span>' },
			],
			on_load: function (params, popup) {
				_this.hook_dialog(popup);
			},
			// Present so the Cancel button is shown. OK is re-wired in hook_dialog().
			on_finish: function () {},
			on_cancel: function () {
				// Escape, Cancel or the close button: abort a running request.
				if (_this.controller) {
					_this.controller.abort();
				}
			},
		});
	}

	/**
	 * Replaces the stock OK behavior (which closes the dialog immediately) with an async run
	 * that keeps the dialog open, disables OK and shows progress.
	 */
	hook_dialog(popup) {
		const el = popup.el;
		const ok = el.querySelector('[data-id="popup_ok"]');
		const fresh_ok = ok.cloneNode(true); // drops the stock click listener
		fresh_ok.textContent = 'Generate';
		ok.parentNode.replaceChild(fresh_ok, ok);
		fresh_ok.addEventListener('click', () => this.run_from_dialog(popup));

		const textarea = el.querySelector('#pop_data_prompt');
		if (textarea) {
			textarea.rows = 4;
			setTimeout(() => textarea.focus(), 0);
		}

		// Keep editor shortcuts (N, D, S, Ctrl+Z...) from firing while this dialog has focus.
		// Escape must still reach the popup's own document listener, so let it through.
		el.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') return;
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.target.tagName === 'INPUT')) {
				event.preventDefault();
				this.run_from_dialog(popup);
			}
			event.stopPropagation();
		});
	}

	set_status(popup, text) {
		const target = popup.el && popup.el.querySelector('#ai_gen_status');
		if (target) target.textContent = text;
	}

	async run_from_dialog(popup) {
		if (this.running) return;
		const params = popup.get_params();
		const prompt = String(params.prompt || '').trim();
		if (prompt.length < 2) {
			this.set_status(popup, 'Please enter a prompt (at least 2 characters).');
			return;
		}
		const preset = params.preset === 'Quality' ? 'quality' : 'fast';
		const count = Math.max(1, Math.min(4, parseInt(params.count, 10) || 1));
		const req_w = parseFloat(params.width);
		const req_h = parseFloat(params.height);
		if (!(req_w > 0) || !(req_h > 0)) {
			this.set_status(popup, 'Width and height must be positive numbers.');
			return;
		}

		const { air, info } = pickModel('generate', preset);
		const rule = sizeRuleFor(air);
		const size = snapSize(req_w, req_h, rule.multiple, rule.min, rule.max);
		save_prefs({ preset: params.preset, count, last_prompt: prompt });

		const ok = popup.el.querySelector('[data-id="popup_ok"]');
		ok.disabled = true;
		ok.textContent = 'Generating...';
		this.set_status(popup, 'Generating ' + count + ' x ' + size.width + 'x' + size.height + ' with ' + info.label + '...');

		this.running = true;
		this.controller = new AbortController();
		let result;
		try {
			result = await generate({
				model: air,
				prompt,
				width: size.width,
				height: size.height,
				numberResults: count,
			}, { signal: this.controller.signal });
		} catch (error) {
			this.running = false;
			this.controller = null;
			if (error instanceof RunwareError && error.cancelled) {
				alertify.message('AI generation cancelled.');
				return;
			}
			const message = error && error.message ? error.message : String(error);
			if (popup.active) {
				ok.disabled = false;
				ok.textContent = 'Generate';
				this.set_status(popup, message);
			}
			alertify.error(this.Helper.escapeHtml(message), 10);
			return;
		}
		this.running = false;
		this.controller = null;

		// Display at the size the user asked for (undo the snap scale), keep natural pixels.
		const display_scale = size.scale > 0 ? 1 / size.scale : 1;
		await this.insert_results(result.images, prompt, display_scale);

		session.cost += result.cost;
		session.generations += 1;
		if (window.AI_panel && window.AI_panel.root) window.AI_panel.update_session();
		if (popup.active) popup.hide(true);
		alertify.success(
			this.Helper.escapeHtml(result.images.length + ' image(s) in ' + (result.ms / 1000).toFixed(1) + ' s, '
				+ formatCost(result.cost) + ' (session ' + formatCost(session.cost) + ')'),
			8
		);
	}

	/**
	 * Inserts every result as a new layer at 0,0 in a single undo step.
	 */
	async insert_results(images, prompt, display_scale = 1) {
		const name = 'AI Generate: ' + short_prompt(prompt);
		const loaded = await Promise.all(images.map((img) => this.measure(img.dataURI || img.url)));
		const actions = loaded.map((dim, i) => {
			const src = images[i].dataURI || images[i].url;
			return new app.Actions.Insert_layer_action({
				name: images.length > 1 ? name + ' #' + (i + 1) : name,
				type: 'image',
				data: src,
				x: 0,
				y: 0,
				width: Math.round(dim.width * display_scale),
				height: Math.round(dim.height * display_scale),
				width_original: dim.width,
				height_original: dim.height,
			}, false);
		});
		return app.State.do_action(
			new app.Actions.Bundle_action('ai_generate', 'AI Generate', actions)
		);
	}

	measure(src) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
			img.onerror = () => reject(new Error('Could not decode the generated image.'));
			img.crossOrigin = 'Anonymous';
			img.src = src;
		});
	}

	/**
	 * Runware settings: proxy status, key presence, routing table, Test connection.
	 */
	show_settings() {
		const _this = this;
		const rows = Object.keys(MODELS).map((verb) => {
			const r = MODELS[verb];
			const f = getModelInfo(r.fast);
			const q = getModelInfo(r.quality);
			return '<tr><td>' + verb + '</td><td>' + (f ? f.label : r.fast) + '</td><td>' + (q ? q.label : r.quality) + '</td></tr>';
		}).join('');
		this.POP.show({
			title: 'Runware Settings',
			params: [
				{ title: 'Proxy:', html: '<span id="ai_health">Not checked</span>' },
				{ title: 'Session cost:', html: '<span>' + formatCost(session.cost) + ' (' + session.generations + ' generation(s))</span>' },
				{ title: 'Request format:', html: '<span id="ai_format">' + this.format_text() + '</span> <button type="button" class="button" id="ai_format_reset">Reset</button>' },
				{ title: '', html: '<button type="button" class="button" id="ai_test_connection">Test connection</button>' },
				{ title: 'Models:', html: '<table class="ai_models"><tr><th>Verb</th><th>Fast</th><th>Quality</th></tr>' + rows + '</table>' },
				{ title: '', html: '<span class="text_muted">The API key lives only on the proxy (RUNWARE_API_KEY env var or server/.env).</span>' },
			],
			on_load: function (params, popup) {
				popup.el.querySelector('#ai_format_reset').addEventListener('click', () => {
					resetRequestFormat();
					popup.el.querySelector('#ai_format').textContent = _this.format_text();
				});
				const button = popup.el.querySelector('#ai_test_connection');
				button.addEventListener('click', () => _this.test_connection(popup));
				_this.test_connection(popup);
			},
		});
	}

	format_text() {
		const f = getRequestFormat();
		const types = Object.keys(f.utility.taskTypes || {}).map((k) => k + ' as ' + f.utility.taskTypes[k]).join(', ');
		return 'images: ' + f.imageInference.style + ', utilities: ' + f.utility.style + (types ? ' (' + types + ')' : '') + ' (default ' + INPUT_STYLE + ')';
	}

	/**
	 * Diagnose request format: sends the cheapest image-input task (background removal of a
	 * 128x128 PNG with runware:112@5, about $0.0006 per try) in both formats and remembers the one
	 * that works. Mock mode simulates success.
	 */
	async diagnose() {
		const c = document.createElement('canvas');
		c.width = 128;
		c.height = 128;
		const g = c.getContext('2d');
		g.fillStyle = '#d8e4f0';
		g.fillRect(0, 0, 128, 128);
		g.fillStyle = '#c0392b';
		g.beginPath();
		g.arc(64, 64, 36, 0, Math.PI * 2);
		g.fill();
		const image = c.toDataURL('image/png');
		this.POP.show({
			title: 'Diagnose Request Format',
			params: [
				{ title: 'Test:', html: '<span>Background removal of a 128x128 test image (runware:112@5) in both request formats. Up to 2 tiny requests, about $0.0006 each.</span>' },
				{ title: 'Result:', html: '<span id="ai_diag_result">Running...</span>' },
			],
		});
		const out = (text) => {
			const target = document.getElementById('ai_diag_result');
			if (target) target.innerHTML = text;
		};
		try {
			const h = await health();
			if (!h.hasKey && !h.mock) {
				out('The proxy has no API key. Set RUNWARE_API_KEY and restart it (or run the proxy with --mock).');
				return null;
			}
			const d = await diagnoseRequestFormat(image);
			const lines = d.results.map((r) => '<b>' + r.style + '</b> (taskType ' + this.Helper.escapeHtml(r.taskType) + '): '
				+ (r.ok ? 'works, ' + formatCost(r.cost) + ', ' + r.ms + ' ms' : 'failed: ' + this.Helper.escapeHtml(r.error || '')));
			lines.push(d.working
				? 'Using <b>' + d.working.style + '</b> from now on (remembered in this browser).' + (h.mock ? ' (mock mode)' : '')
				: 'Neither format worked. Check the errors above.');
			lines.push('Total cost: ' + formatCost(d.totalCost));
			out(lines.join('<br>'));
			session.cost += d.totalCost;
			if (d.working) alertify.success('Request format: ' + d.working.style, 5);
			return d;
		} catch (error) {
			out(this.Helper.escapeHtml(error.message || String(error)));
			return null;
		}
	}

	async test_connection(popup) {
		const target = popup.el && popup.el.querySelector('#ai_health');
		const show = (text) => {
			if (target) target.textContent = text;
		};
		show('Checking...');
		try {
			const h = await health();
			let text;
			if (h.mock) text = 'Connected (mock mode, no real Runware calls).';
			else if (h.hasKey) text = 'Connected, API key present.';
			else text = 'Connected, but no API key. Set RUNWARE_API_KEY and restart the proxy.';
			show(text);
			if (h.hasKey || h.mock) alertify.success(text, 5);
			else alertify.warning(text, 8);
		} catch (error) {
			show(error.message);
			alertify.error(this.Helper.escapeHtml(error.message), 8);
		}
	}
}

export default AI_generate_class;
