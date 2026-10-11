/*
 * miniPaint AI: prompt history. Pure list helpers (unit tested) plus localStorage load and save.
 */

export const HISTORY_KEY = 'minipaint_ai_prompt_history';
export const HISTORY_MAX = 30;

/** New list with `text` first, duplicates removed, capped at `max`. Ignores very short prompts. */
export function pushPrompt(list, text, max = HISTORY_MAX) {
	const t = String(text == null ? '' : text).trim();
	if (t.length < 2) return list.slice(0, max);
	return [t].concat(list.filter((p) => p !== t)).slice(0, max);
}

/**
 * Index to show when stepping through history with Alt+Up (dir -1, older) or Alt+Down (dir +1, newer).
 * `index` is -1 when the box shows something typed by the user. Returns -1 to go back to the draft.
 */
export function stepIndex(index, dir, length) {
	if (length === 0) return -1;
	if (dir < 0) return Math.min(length - 1, index + 1);
	return index <= 0 ? -1 : index - 1;
}

export function loadHistory() {
	try {
		const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
	} catch (e) {
		return [];
	}
}

export function saveHistory(list) {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
	} catch (e) {}
}
