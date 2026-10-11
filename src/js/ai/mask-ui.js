/*
 * miniPaint AI: "Mask" section of the AI panel (tool buttons, mode, options and mask operations).
 * Built with plain DOM like the rest of the panel; styles are in ai-panel.css.
 */

import { mask as store } from './mask.js';
import { editor, TOOLS } from './mask-editor.js';
import { getAiRegion } from './canvas-io.js';

const KEY = 'minipaint_ai_mask_ui';

function load() {
	try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
}
function save(patch) {
	try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch })); } catch (e) {}
}

function el(tag, attrs = {}, children = []) {
	const n = document.createElement(tag);
	for (const k of Object.keys(attrs)) {
		if (k === 'class') n.className = attrs[k];
		else if (k === 'text') n.textContent = attrs[k];
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
		else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
	}
	for (const c of [].concat(children)) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	return n;
}

export function build_mask_section() {
	const saved = load();
	let open = saved.open === true;
	if (saved.brushSize) editor.brushSize = saved.brushSize;
	if (saved.tolerance != null) editor.tolerance = saved.tolerance;
	let amount = saved.amount || 8;

	const toolButtons = {};
	const modeButtons = {};
	const status = el('span', { class: 'ai_mask_status', text: 'Empty' });

	const title = el('span', { class: 'ai_mask_title', text: 'Mask' });
	const header = el('div', { class: 'ai_mask_header' }, [title, status]);

	const tools = el('div', { class: 'ai_mask_tools' }, TOOLS.map(([id, label, tip]) => {
		const b = el('button', { type: 'button', class: 'ai_chip', text: label, title: tip, 'data-tool': id });
		b.addEventListener('click', () => editor.set_tool(id));
		toolButtons[id] = b;
		return b;
	}));

	const modes = el('div', { class: 'ai_row' }, [
		el('label', { class: 'ai_label', text: 'Mode' }),
		...[['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract']].map(([id, label]) => {
			const tip = id === 'add' ? 'Add to the mask (or hold Shift)' : id === 'subtract' ? 'Subtract from the mask (or hold Alt)' : 'Replace the mask';
			const b = el('button', { type: 'button', class: 'ai_chip', text: label, title: tip });
			b.addEventListener('click', () => { editor.mode = id; editor.emit(); });
			modeButtons[id] = b;
			return b;
		}),
	]);

	function slider(label, min, max, get, set, unit) {
		const input = el('input', { type: 'range', min, max, step: 1 });
		const out = el('span', { class: 'ai_value' });
		const sync = () => { input.value = get(); out.textContent = get() + unit; };
		input.addEventListener('input', () => { set(Number(input.value)); sync(); });
		const row = el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: label }), input, out]);
		row.sync = sync;
		return row;
	}
	const sizeRow = slider('Brush size', 2, 300, () => editor.brushSize, (v) => { editor.brushSize = v; save({ brushSize: v }); }, ' px');
	const tolRow = slider('Tolerance', 0, 255, () => editor.tolerance, (v) => { editor.tolerance = v; save({ tolerance: v }); }, '');
	const contig = el('input', { type: 'checkbox' });
	contig.checked = editor.contiguous;
	contig.addEventListener('change', () => { editor.contiguous = contig.checked; });
	const contigRow = el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: 'Contiguous' }), contig]);

	const amountInput = el('input', { type: 'number', min: 1, max: 300, value: amount, class: 'ai_mask_amount' });
	amountInput.addEventListener('input', () => {
		amount = Math.max(1, Math.min(300, parseInt(amountInput.value, 10) || 1));
		save({ amount });
	});
	const act = (label, tip, fn) => {
		const b = el('button', { type: 'button', class: 'ai_chip', text: label, title: tip });
		b.addEventListener('click', () => fn());
		return b;
	};
	const actions = el('div', { class: 'ai_mask_tools' }, [
		act('Invert', 'Swap inside and outside', () => store.invert()),
		act('Feather', 'Soften the edge by Amount px', () => store.feather(amount)),
		act('Grow', 'Expand by Amount px', () => store.grow(amount)),
		act('Shrink', 'Contract by Amount px', () => store.shrink(amount)),
		act('Clear', 'Remove the mask', () => store.clear()),
		act('From select', 'Turn the Select tool rectangle into a mask', () => {
			const r = getAiRegion(1);
			if (r) store.from_rect(r, editor.mode);
		}),
		act('Undo', 'Undo the last mask edit', () => store.undo()),
	]);
	const amountRow = el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: 'Amount' }), amountInput, el('span', { class: 'ai_value', text: 'px' })]);
	const eye = el('input', { type: 'checkbox' });
	eye.checked = editor.show;
	eye.addEventListener('change', () => editor.set_show(eye.checked));
	const eyeRow = el('div', { class: 'ai_row' }, [el('label', { class: 'ai_label', text: 'Show mask' }), eye]);
	const hint = el('div', { class: 'ai_mask_hint', text: 'With a mask, Inpaint and Edit use it instead of the rectangle.' });

	const body = el('div', { class: 'ai_mask_body' }, [tools, modes, sizeRow, tolRow, contigRow, actions, amountRow, eyeRow, hint]);

	const root = el('div', { class: 'ai_mask' }, [header, body]);
	header.addEventListener('click', () => {
		open = !open;
		save({ open });
		refresh();
	});

	function refresh() {
		title.textContent = (open ? 'v ' : '> ') + 'Mask';
		body.style.display = open ? '' : 'none';
		for (const id of Object.keys(toolButtons)) toolButtons[id].classList.toggle('ai_active', editor.tool === id);
		for (const id of Object.keys(modeButtons)) modeButtons[id].classList.toggle('ai_active', editor.mode === id);
		sizeRow.style.display = editor.tool === 'brush' || editor.tool === 'eraser' ? '' : 'none';
		tolRow.style.display = contigRow.style.display = editor.tool === 'wand' ? '' : 'none';
		sizeRow.sync();
		tolRow.sync();
		eye.checked = editor.show;
		const b = store.bounds();
		status.textContent = b ? b.w + ' x ' + b.h + ' px, ' + Math.round(store.coverage() * 100) + '%' : 'Empty';
		root.classList.toggle('ai_mask_has', !!b);
	}
	editor.on_change(refresh);
	refresh();
	root.refresh = refresh;
	return root;
}
