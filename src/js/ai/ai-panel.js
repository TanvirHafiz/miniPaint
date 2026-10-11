/*
 * miniPaint AI: floating AI panel (main AI UI from Phase 3).
 *
 * - Floating, draggable by its header, collapsible, about 320 px wide, outside the 200 px sidebar.
 *   Position, open and collapsed state are remembered in localStorage (all access wrapped).
 * - Verb tabs (Generate, Inpaint, Edit, Outpaint, Remove BG, Upscale) select the action; the Run
 *   button (or Ctrl+Enter anywhere in the panel) runs it. Verb specific options appear below the
 *   tabs; model, strength, variations and feather are under "Advanced".
 * - The selection is captured when Run is pressed and kept for the request. A dashed, animated
 *   overlay marks the region on the canvas while the request runs. Cancel aborts it.
 * - Keyboard events inside the panel never reach miniPaint's document shortcuts (letters, Delete,
 *   Escape that would clear the selection, Ctrl+Z ...). Escape inside the panel cancels a running
 *   request or blurs the field.
 */

import './ai-panel.css';
import app from '../app.js';
import config from '../config.js';
import Helper_class from '../libs/helpers.js';
import zoomView from '../libs/zoomView.js';
import alertify from '../../../node_modules/alertifyjs/build/alertify.min.js';
import { formatCost, RunwareError } from './runware-client.js';
import { MODELS, MODEL_INFO, modelsForVerb } from './models.js';
import { DEFAULTS, getAiRegion } from './canvas-io.js';
import {
	VERBS, VERB_LABELS, RUNNERS, PROMPT_REQUIRED, SUPPORTS_VARIATIONS, AiUserError,
} from './ai-verbs.js';
import { session } from './ai-generate.js';
import { mask as maskStore } from './mask.js';
import { build_mask_section } from './mask-ui.js';
import { pushPrompt, stepIndex, loadHistory, saveHistory } from './ai-history.js';
import { updateStatusChip } from './ai-status.js';

const STATE_KEY = 'minipaint_ai_panel';
const PANEL_WIDTH = 320;

function load_state() {
	try {
		return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {};
	} catch (e) {
		return {};
	}
}

function save_state(patch) {
	try {
		const next = { ...load_state(), ...patch };
		localStorage.setItem(STATE_KEY, JSON.stringify(next));
	} catch (e) {}
}

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const k of Object.keys(attrs)) {
		if (k === 'class') node.className = attrs[k];
		else if (k === 'text') node.textContent = attrs[k];
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
		else if (attrs[k] === true) node.setAttribute(k, '');
		else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k]);
	}
	for (const c of [].concat(children)) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

export class AI_panel_class {

	constructor() {
		this.Helper = new Helper_class();
		this.root = null;
		this.verb = 'generate';
		this.controller = null;
		this.running = false;
		this.overlayEl = null;
		this.overlayRegion = null;
		this.overlayRaf = null;
		this.history = loadHistory();
		this.historyIndex = -1; // -1 = the box shows the user's own text
		this.historyDraft = '';
		this.last = null; // last verb result (for variations)
		this.placed = new Set();
		this.state = {
			preset: 'fast',
			model: {},
			strength: 0.85,
			count: 1,
			feather: DEFAULTS.clipFeather,
			outpaintPx: 256,
			sides: { right: true },
			upscaleFactor: 2,
			removeBgSource: 'layer',
			advanced: false,
			...load_state().opts,
		};
	}

	/* ------------------------------------------------------------ setup */

	init() {
		if (this.root) return;
		this.build();
		const st = load_state();
		this.apply_position(st.left, st.top);
		this.set_collapsed(!!st.collapsed, false);
		this.set_open(st.open !== false, false);
		this.add_toggle_button();
		this.add_global_shortcuts();
		updateStatusChip(() => this.show());
		window.addEventListener('resize', () => this.apply_position(this.root.offsetLeft, this.root.offsetTop));
	}

	build() {
		this.prompt = el('textarea', { class: 'ai_prompt', placeholder: 'Describe what you want. Ctrl+Enter to run.', rows: 3 });
		this.prompt.value = load_state().prompt || '';
		this.prompt.addEventListener('input', () => {
			save_state({ prompt: this.prompt.value });
			this.historyIndex = -1;
		});
		this.prompt.addEventListener('keydown', (e) => {
			if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.history.length) {
				e.preventDefault();
				if (this.historyIndex === -1) this.historyDraft = this.prompt.value;
				this.historyIndex = stepIndex(this.historyIndex, e.key === 'ArrowUp' ? -1 : 1, this.history.length);
				this.prompt.value = this.historyIndex === -1 ? this.historyDraft : this.history[this.historyIndex];
				save_state({ prompt: this.prompt.value });
			}
		});
		this.historyButton = el('button', { type: 'button', class: 'ai_history_button', text: 'Recent', title: 'Recent prompts (Alt+Up and Alt+Down in the box)' });
		this.historyList = el('div', { class: 'ai_history_list' });
		this.historyList.style.display = 'none';
		this.historyButton.addEventListener('click', () => this.toggle_history());
		this.promptWrap = el('div', { class: 'ai_prompt_wrap' }, [this.prompt, this.historyButton, this.historyList]);

		this.verbButtons = {};
		const verbs = el('div', { class: 'ai_verbs' }, VERBS.map((v) => {
			const b = el('button', { type: 'button', 'data-verb': v, text: VERB_LABELS[v], title: VERB_LABELS[v] });
			b.addEventListener('click', () => this.set_verb(v));
			this.verbButtons[v] = b;
			return b;
		}));

		this.presetButtons = {
			fast: el('button', { type: 'button', class: 'ai_chip', 'data-preset': 'fast', text: 'Fast' }),
			quality: el('button', { type: 'button', class: 'ai_chip', 'data-preset': 'quality', text: 'Quality' }),
		};
		for (const p of Object.keys(this.presetButtons)) {
			this.presetButtons[p].addEventListener('click', () => {
				this.state.preset = p;
				this.state.model[this.verb] = '';
				this.save_opts();
				this.refresh();
			});
		}
		const presetRow = el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: 'Model' }), this.presetButtons.fast, this.presetButtons.quality]);

		this.options = el('div', { class: 'ai_options' });

		this.runButton = el('button', { type: 'button', class: 'button ai_run', text: 'Run' });
		this.runButton.addEventListener('click', () => this.run());
		this.cancelButton = el('button', { type: 'button', class: 'button ai_cancel', text: 'Cancel', disabled: true });
		this.cancelButton.addEventListener('click', () => this.cancel());

		this.advancedToggle = el('div', { class: 'ai_advanced_toggle', text: 'Advanced' });
		this.advancedToggle.addEventListener('click', () => {
			this.state.advanced = !this.state.advanced;
			this.save_opts();
			this.refresh();
		});
		this.advanced = el('div', { class: 'ai_advanced' });

		this.thumbs = el('div', { class: 'ai_thumbs' });
		this.status = el('div', { class: 'ai_status', text: 'Ready.' });
		this.sessionLine = el('div', { class: 'ai_session ai_session_total' });

		const header = el('div', { class: 'ai_panel_header' }, [
			el('span', { class: 'ai_panel_title', text: 'AI (Runware)' }),
			this.collapseButton = el('button', { type: 'button', title: 'Collapse', text: '_' }),
			this.closeButton = el('button', { type: 'button', title: 'Hide panel (AI menu or AI button to show)', text: 'x' }),
		]);
		this.collapseButton.addEventListener('click', () => this.set_collapsed(!this.collapsed));
		this.closeButton.addEventListener('click', () => this.set_open(false));
		this.make_draggable(header);

		this.maskSection = build_mask_section();

		const body = el('div', { class: 'ai_panel_body' }, [
			this.promptWrap,
			verbs,
			this.maskSection,
			presetRow,
			this.options,
			this.advancedToggle,
			this.advanced,
			el('div', { class: 'ai_run_row' }, [this.runButton, this.cancelButton]),
			this.thumbs,
			this.status,
			this.sessionLine,
		]);

		this.root = el('div', { class: 'ai_panel', id: 'ai_panel', role: 'dialog', 'aria-label': 'AI panel' }, [header, body]);
		this.isolate_keyboard(this.root);
		document.body.appendChild(this.root);
		this.set_verb(load_state().verb || 'generate', false);
		this.update_session();
	}

	/** Stops panel key events from reaching miniPaint's document level shortcuts. */
	isolate_keyboard(node) {
		const stop = (e) => e.stopPropagation();
		node.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				this.run();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				if (this.running) this.cancel();
				else if (document.activeElement && node.contains(document.activeElement)) document.activeElement.blur();
			}
			e.stopPropagation();
		});
		node.addEventListener('keyup', stop);
		node.addEventListener('keypress', stop);
		// Selection and select tools react to document mousedown; keep panel clicks to ourselves.
		node.addEventListener('mousedown', stop);
		node.addEventListener('touchstart', stop);
		node.addEventListener('wheel', stop);
	}

	make_draggable(handle) {
		let start = null;
		handle.addEventListener('mousedown', (e) => {
			if (e.target.tagName === 'BUTTON') return;
			e.preventDefault();
			start = { x: e.clientX, y: e.clientY, left: this.root.offsetLeft, top: this.root.offsetTop };
		});
		document.addEventListener('mousemove', (e) => {
			if (!start) return;
			this.apply_position(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
		});
		document.addEventListener('mouseup', () => {
			if (!start) return;
			start = null;
			save_state({ left: this.root.offsetLeft, top: this.root.offsetTop });
		});
	}

	apply_position(left, top) {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (left == null || top == null || !Number.isFinite(left) || !Number.isFinite(top)) {
			// Default: right side, left of the 200 px sidebar.
			left = vw - PANEL_WIDTH - 230;
			top = 80;
		}
		left = Math.max(0, Math.min(vw - 60, left));
		top = Math.max(0, Math.min(vh - 30, top));
		this.root.style.left = Math.round(left) + 'px';
		this.root.style.top = Math.round(top) + 'px';
	}

	add_toggle_button() {
		const bar = document.querySelector('.submenu');
		if (!bar || document.getElementById('ai_panel_toggle')) return;
		this.toggleButton = el('button', { type: 'button', id: 'ai_panel_toggle', class: 'button ai_panel_toggle_button', title: 'Show or hide the AI panel', text: 'AI' });
		this.toggleButton.addEventListener('click', () => this.toggle());
		bar.appendChild(this.toggleButton);
		this.toggleButton.classList.toggle('ai_active', this.open);
	}

	set_open(open, save = true) {
		this.open = open;
		this.root.classList.toggle('ai_hidden', !open);
		if (this.toggleButton) this.toggleButton.classList.toggle('ai_active', open);
		if (save) save_state({ open });
	}

	toggle() {
		this.set_open(!this.open);
	}

	show() {
		this.set_open(true);
		this.set_collapsed(false);
	}

	set_collapsed(collapsed, save = true) {
		this.collapsed = collapsed;
		this.root.classList.toggle('ai_collapsed', collapsed);
		this.collapseButton.textContent = collapsed ? '+' : '_';
		this.collapseButton.title = collapsed ? 'Expand' : 'Collapse';
		if (save) save_state({ collapsed });
	}

	save_opts() {
		save_state({ opts: { ...this.state } });
	}

	/* ------------------------------------------------------------ verb and options */

	toggle_history() {
		const open = this.historyList.style.display === 'none';
		this.historyList.innerHTML = '';
		if (!open) {
			this.historyList.style.display = 'none';
			return;
		}
		if (!this.history.length) {
			this.historyList.appendChild(el('div', { class: 'ai_history_empty', text: 'No prompts yet.' }));
		}
		for (const text of this.history) {
			const item = el('div', { class: 'ai_history_item', text, title: text });
			item.addEventListener('click', () => {
				this.prompt.value = text;
				save_state({ prompt: text });
				this.historyList.style.display = 'none';
				this.prompt.focus();
			});
			this.historyList.appendChild(item);
		}
		if (this.history.length) {
			const clear = el('div', { class: 'ai_history_item ai_history_clear', text: 'Clear history' });
			clear.addEventListener('click', () => {
				this.history = [];
				saveHistory(this.history);
				this.historyList.style.display = 'none';
			});
			this.historyList.appendChild(clear);
		}
		this.historyList.style.display = 'block';
	}

	remember_prompt(text) {
		this.history = pushPrompt(this.history, text);
		saveHistory(this.history);
		this.historyIndex = -1;
	}

	/** Ctrl+Enter anywhere runs the current verb; Ctrl+Shift+E jumps to Edit. Keys inside the panel are handled there. */
	add_global_shortcuts() {
		document.addEventListener('keydown', (e) => {
			if (this.root.contains(e.target)) return;
			const mod = e.ctrlKey || e.metaKey;
			if (!mod) return;
			const t = e.target;
			if (t && (this.Helper.is_input(t) || t.tagName === 'SELECT')) return;
			if (e.key === 'Enter') {
				e.preventDefault();
				this.show();
				this.run();
			} else if (e.shiftKey && e.key.toLowerCase() === 'e') {
				e.preventDefault();
				this.show();
				this.set_verb('edit');
				this.prompt.focus();
			}
		});
	}

	set_verb(verb, save = true) {
		if (!RUNNERS[verb]) verb = 'generate';
		this.verb = verb;
		if (save) save_state({ verb });
		this.refresh();
	}

	current_model() {
		const chosen = this.state.model[this.verb];
		if (chosen && MODEL_INFO[chosen] && modelsForVerb(this.verb).includes(chosen)) return chosen;
		const route = MODELS[this.verb];
		return route ? route[this.state.preset] || route.fast : null;
	}

	refresh() {
		for (const v of VERBS) this.verbButtons[v].classList.toggle('ai_active', v === this.verb);
		for (const p of Object.keys(this.presetButtons)) this.presetButtons[p].classList.toggle('ai_active', p === this.state.preset);
		this.runButton.textContent = this.running ? 'Working...' : 'Run ' + VERB_LABELS[this.verb];
		this.prompt.placeholder = {
			generate: 'Describe the image to generate. Ctrl+Enter to run.',
			inpaint: 'What should appear inside the selection?',
			edit: 'Describe the change, e.g. "make the jacket red".',
			outpaint: 'Optional: what the new border should show.',
			removeBg: 'No prompt needed.',
			upscale: 'No prompt needed.',
		}[this.verb];
		this.render_options();
		this.render_advanced();
	}

	row(label, control, value) {
		return el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: label }), control, value || null]);
	}

	render_options() {
		const o = this.options;
		o.innerHTML = '';
		if (this.verb === 'outpaint') {
			const px = el('input', { type: 'number', min: 64, max: 1024, step: 64, value: this.state.outpaintPx, 'data-ai': 'outpaint_px' });
			px.addEventListener('change', () => {
				this.state.outpaintPx = Math.max(1, parseInt(px.value, 10) || 256);
				this.save_opts();
			});
			o.appendChild(this.row('Pixels', px));
			const chips = ['top', 'right', 'bottom', 'left'].map((side) => {
				const b = el('button', { type: 'button', class: 'ai_chip' + (this.state.sides[side] ? ' ai_active' : ''), 'data-side': side, text: side[0].toUpperCase() + side.slice(1) });
				b.addEventListener('click', () => {
					this.state.sides = { ...this.state.sides, [side]: !this.state.sides[side] };
					b.classList.toggle('ai_active', !!this.state.sides[side]);
					this.save_opts();
				});
				return b;
			});
			o.appendChild(this.row('Sides', el('span', { class: 'ai_row' }, chips)));
		} else if (this.verb === 'upscale') {
			const chips = [2, 4].map((f) => {
				const b = el('button', { type: 'button', class: 'ai_chip' + (this.state.upscaleFactor === f ? ' ai_active' : ''), 'data-factor': f, text: f + 'x' });
				b.addEventListener('click', () => {
					this.state.upscaleFactor = f;
					this.save_opts();
					this.render_options();
				});
				return b;
			});
			o.appendChild(this.row('Factor', el('span', { class: 'ai_row' }, chips)));
			o.appendChild(el('div', { class: 'ai_session', text: 'Upscales the whole image. The canvas and all layers are scaled, and the result is added on top (one undo).' }));
		} else if (this.verb === 'removeBg') {
			const sel = el('select', { 'data-ai': 'removebg_source' }, [
				el('option', { value: 'layer', text: 'Active layer' }),
				el('option', { value: 'image', text: 'Whole image' }),
			]);
			sel.value = this.state.removeBgSource;
			sel.addEventListener('change', () => {
				this.state.removeBgSource = sel.value;
				this.save_opts();
			});
			o.appendChild(this.row('Source', sel));
		} else if (this.verb === 'inpaint') {
			o.appendChild(el('div', { class: 'ai_session', text: 'Uses the mask if there is one, otherwise the rectangle selection. Only that area changes.' }));
		} else if (this.verb === 'edit') {
			o.appendChild(el('div', { class: 'ai_session', text: 'With a selection, only that area changes; without one, the whole image is edited.' }));
		}
	}

	render_advanced() {
		const a = this.advanced;
		this.advancedToggle.textContent = (this.state.advanced ? 'v ' : '> ') + 'Advanced';
		a.classList.toggle('ai_hidden', !this.state.advanced);
		a.innerHTML = '';
		// Model dropdown filtered to models capable of this verb.
		const current = this.current_model();
		const select = el('select', { 'data-ai': 'model' }, [el('option', { value: '', text: 'Preset (' + (MODEL_INFO[MODELS[this.verb][this.state.preset]] || {}).label + ')' })].concat(
			modelsForVerb(this.verb).map((air) => el('option', { value: air, text: MODEL_INFO[air].label + ' (' + air + ')' }))
		));
		select.value = this.state.model[this.verb] && modelsForVerb(this.verb).includes(this.state.model[this.verb]) ? this.state.model[this.verb] : '';
		select.addEventListener('change', () => {
			this.state.model[this.verb] = select.value;
			this.save_opts();
		});
		a.appendChild(this.row('Model', select));
		const info = MODEL_INFO[current] || {};

		if (this.verb === 'inpaint' && info.supportsStrength) {
			const v = el('span', { class: 'ai_value', text: Number(this.state.strength).toFixed(2) });
			const r = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: this.state.strength, 'data-ai': 'strength' });
			r.addEventListener('input', () => {
				this.state.strength = parseFloat(r.value);
				v.textContent = this.state.strength.toFixed(2);
				this.save_opts();
			});
			a.appendChild(this.row('Strength', r, v));
		}
		if (SUPPORTS_VARIATIONS[this.verb]) {
			const c = el('select', { 'data-ai': 'count' }, [1, 2, 3, 4].map((n) => el('option', { value: n, text: n === 1 ? '1 result' : n + ' variations' })));
			c.value = String(this.state.count);
			c.addEventListener('change', () => {
				this.state.count = parseInt(c.value, 10) || 1;
				this.save_opts();
			});
			a.appendChild(this.row('Results', c));
		}
		if (this.verb === 'inpaint' || this.verb === 'edit') {
			const v = el('span', { class: 'ai_value', text: this.state.feather + ' px' });
			const r = el('input', { type: 'range', min: 0, max: 48, step: 1, value: this.state.feather, 'data-ai': 'feather' });
			r.addEventListener('input', () => {
				this.state.feather = parseInt(r.value, 10) || 0;
				v.textContent = this.state.feather + ' px';
				this.save_opts();
			});
			a.appendChild(this.row('Feather', r, v));
		}
		if (info.note) a.appendChild(el('div', { class: 'ai_session', text: info.note }));
	}

	/* ------------------------------------------------------------ status */

	set_status(text, { error = false, actions = [] } = {}) {
		this.status.textContent = text;
		this.status.classList.toggle('ai_error', !!error);
		for (const action of actions) {
			let node;
			if (action.href) {
				node = el('a', { class: 'ai_action', href: action.href, download: action.download || 'image.png', text: action.label });
			} else {
				node = el('button', { type: 'button', class: 'ai_action', text: action.label });
				node.addEventListener('click', async () => {
					node.disabled = true;
					try {
						await action.run();
					} catch (e) {}
				});
			}
			this.status.appendChild(node);
		}
	}

	update_session() {
		updateStatusChip(() => this.show(), this.running ? VERB_LABELS[this.verb] : null);
		this.sessionLine.textContent = 'Session: ' + formatCost(session.cost) + ' (' + session.generations + ' request' + (session.generations === 1 ? '' : 's') + ')';
	}

	set_running(running) {
		this.running = running;
		this.runButton.disabled = running;
		this.cancelButton.disabled = !running;
		for (const v of VERBS) this.verbButtons[v].disabled = running;
		this.runButton.textContent = running ? 'Working...' : 'Run ' + VERB_LABELS[this.verb];
		updateStatusChip(() => this.show(), running ? VERB_LABELS[this.verb] : null);
	}

	/* ------------------------------------------------------------ overlay */

	show_overlay(region) {
		this.hide_overlay();
		if (!region) return;
		this.overlayRegion = region;
		this.overlayEl = el('div', { class: 'ai_working_overlay', id: 'ai_working_overlay' });
		document.body.appendChild(this.overlayEl);
		const tick = () => {
			this.position_overlay();
			this.overlayRaf = requestAnimationFrame(tick);
		};
		tick();
	}

	position_overlay() {
		if (!this.overlayEl || !this.overlayRegion) return;
		const canvas = document.getElementById('canvas_minipaint');
		const wrapper = document.getElementById('main_wrapper');
		if (!canvas || !wrapper) return;
		const cr = canvas.getBoundingClientRect();
		const wr = wrapper.getBoundingClientRect();
		const r = this.overlayRegion;
		const a = zoomView.toScreen({ x: r.x, y: r.y });
		const b = zoomView.toScreen({ x: r.x + r.w, y: r.y + r.h });
		// Clip to the visible part of the editor.
		const left = Math.max(wr.left, cr.left + a.x);
		const top = Math.max(wr.top, cr.top + a.y);
		const right = Math.min(wr.right, cr.left + b.x);
		const bottom = Math.min(wr.bottom, cr.top + b.y);
		const s = this.overlayEl.style;
		if (right <= left || bottom <= top) {
			s.display = 'none';
			return;
		}
		s.display = 'block';
		s.left = left + 'px';
		s.top = top + 'px';
		s.width = (right - left) + 'px';
		s.height = (bottom - top) + 'px';
	}

	hide_overlay() {
		if (this.overlayRaf) cancelAnimationFrame(this.overlayRaf);
		this.overlayRaf = null;
		if (this.overlayEl && this.overlayEl.parentNode) this.overlayEl.parentNode.removeChild(this.overlayEl);
		this.overlayEl = null;
		this.overlayRegion = null;
	}

	/* ------------------------------------------------------------ run */

	cancel() {
		if (this.controller) this.controller.abort();
	}

	async run() {
		if (this.running) return;
		const verb = this.verb;
		const runner = RUNNERS[verb];
		// Capture the selection NOW (it is cleared on tool change, layer click and Escape).
		// A free-form mask (Phase 5) wins over the rectangle; its bounding box is the region.
		const maskSnap = maskStore.snapshot();
		const region = maskSnap ? maskSnap.region : getAiRegion();
		const opts = {
			prompt: this.prompt.value,
			preset: this.state.preset,
			model: this.state.model[verb] && modelsForVerb(verb).includes(this.state.model[verb]) ? this.state.model[verb] : null,
			strength: this.state.strength,
			count: this.state.count,
			feather: this.state.feather,
			outpaintPx: this.state.outpaintPx,
			sides: this.state.sides,
			factor: this.state.upscaleFactor,
			removeBgSource: this.state.removeBgSource,
		};
		if (PROMPT_REQUIRED[verb] && String(opts.prompt).trim().length < 2) {
			this.set_status(verb === 'inpaint' ? 'Type what should appear in the selection.' : verb === 'edit' ? 'Describe the edit first.' : 'Type a prompt first.', { error: true });
			this.prompt.focus();
			return;
		}

		this.remember_prompt(opts.prompt);
		this.thumbs.innerHTML = '';
		this.last = null;
		this.placed = new Set();
		this.controller = new AbortController();
		const signal = this.controller.signal;
		this.set_running(true);
		const started = performance.now();
		const timer = setInterval(() => {
			this.set_status(VERB_LABELS[verb] + ': working... ' + ((performance.now() - started) / 1000).toFixed(1) + ' s');
		}, 200);
		this.set_status(VERB_LABELS[verb] + ': working...');
		const overlayRegion = verb === 'inpaint' || (verb === 'edit' && region) ? region : { x: 0, y: 0, w: config.WIDTH, h: config.HEIGHT };
		if (verb !== 'inpaint' || region) this.show_overlay(overlayRegion);

		let result;
		try {
			result = await runner(opts, { region, signal, mask: maskSnap ? maskSnap.canvas : null });
		} catch (error) {
			clearInterval(timer);
			this.hide_overlay();
			this.set_running(false);
			this.controller = null;
			if (error instanceof RunwareError && error.cancelled) {
				this.set_status(VERB_LABELS[verb] + ' cancelled. Nothing was changed.');
				return;
			}
			const message = error && error.message ? error.message : String(error);
			this.set_status(message, { error: true });
			if (!(error instanceof AiUserError)) alertify.error(this.Helper.escapeHtml(message), 8);
			return;
		}
		clearInterval(timer);
		this.hide_overlay();
		const cancelledLate = signal.aborted;
		this.set_running(false);
		this.controller = null;
		session.cost += result.cost;
		session.generations += 1;
		this.update_session();
		if (cancelledLate) {
			this.set_status(VERB_LABELS[verb] + ' cancelled. Nothing was changed (' + formatCost(result.cost) + ' was still charged).');
			return;
		}

		const head = VERB_LABELS[verb] + ': ' + (result.ms / 1000).toFixed(1) + ' s, ' + formatCost(result.cost);
		const note = result.note ? ' ' + result.note : '';
		if (result.variations) {
			this.last = result;
			this.show_thumbs(result);
			this.set_status(head + '. ' + result.images.length + ' variations: click one to place it, or Place all.' + note);
			return;
		}
		try {
			await result.place();
		} catch (error) {
			this.set_status('Could not place the result: ' + (error.message || error), { error: true });
			return;
		}
		this.set_status(head + '.' + note, { actions: result.actions || [] });
	}

	show_thumbs(result) {
		this.thumbs.innerHTML = '';
		result.images.forEach((img, i) => {
			const b = el('button', { type: 'button', class: 'ai_thumb', title: 'Place variation ' + (i + 1), 'data-index': i }, [el('img', { src: img.dataURI || img.url, alt: 'Variation ' + (i + 1) })]);
			b.addEventListener('click', async () => {
				await result.place([i]);
				this.placed.add(i);
				b.classList.add('ai_placed');
				this.set_status('Placed variation ' + (i + 1) + '. Click another to add it too, or Ctrl+Z to undo.');
			});
			this.thumbs.appendChild(b);
		});
		const all = el('button', { type: 'button', class: 'button', 'data-ai': 'place_all', text: 'Place all' });
		all.addEventListener('click', async () => {
			await result.place();
			result.images.forEach((_, i) => this.placed.add(i));
			for (const t of this.thumbs.querySelectorAll('.ai_thumb')) t.classList.add('ai_placed');
			this.set_status('Placed all ' + result.images.length + ' variations as separate layers (one undo).');
		});
		const clear = el('button', { type: 'button', class: 'button', text: 'Discard' });
		clear.addEventListener('click', () => {
			this.thumbs.innerHTML = '';
			this.last = null;
			this.set_status('Variations discarded.');
		});
		this.thumbs.appendChild(el('div', { class: 'ai_thumbs_actions' }, [all, clear]));
	}
}

export default AI_panel_class;
