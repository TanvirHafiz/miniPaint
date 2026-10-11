/*
 * miniPaint AI: small status chip in the bottom left corner of the editor with the session cost
 * (and a working indicator). Clicking it shows the AI panel. The miniPaint layout has no status bar,
 * so this is a fixed element and does not change the grid.
 */

import { formatCost } from './runware-client.js';
import { session } from './ai-generate.js';

let chip = null;

function ensure(onClick) {
	if (chip) return chip;
	chip = document.createElement('div');
	chip.id = 'ai_status_chip';
	chip.className = 'ai_status_chip';
	chip.title = 'AI session cost. Click to show the AI panel.';
	chip.addEventListener('click', () => onClick && onClick());
	document.body.appendChild(chip);
	return chip;
}

/** Updates the chip text. `working` is a verb label while a request runs, otherwise null. */
export function updateStatusChip(onClick, working = null) {
	const c = ensure(onClick);
	const n = session.generations;
	const base = 'AI ' + formatCost(session.cost) + ' this session' + (n ? ' (' + n + ' request' + (n === 1 ? '' : 's') + ')' : '');
	c.textContent = working ? working + '... | ' + base : base;
	c.classList.toggle('ai_working', !!working);
}
