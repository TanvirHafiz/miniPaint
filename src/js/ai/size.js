/*
 * miniPaint AI: size math for Runware requests.
 * Dependency free (no DOM, no imports) so it can be unit tested with `node --test`.
 */

/**
 * Rounds a value to the nearest multiple, clamped to [min, max] where min and max
 * are themselves rounded inward to multiples.
 */
export function snapValue(value, multiple = 64, min = 128, max = 2048) {
	if (!(multiple > 0)) throw new Error('multiple must be > 0');
	const lo = Math.ceil(min / multiple) * multiple;
	const hi = Math.floor(max / multiple) * multiple;
	if (lo > hi) throw new Error('no multiple of ' + multiple + ' inside [' + min + ', ' + max + ']');
	let v = Math.round(Number(value) / multiple) * multiple;
	if (!Number.isFinite(v)) v = lo;
	return Math.min(hi, Math.max(lo, v));
}

/**
 * Snaps width and height to multiples of `multiple` inside [min, max] while preserving
 * the aspect ratio as closely as possible.
 *
 * Steps:
 * 1. If either side is above max, scale both down so the longer side fits max.
 * 2. If either side is below min, scale both up so the shorter side reaches min
 *    (unless that would push the longer side past max, then the longer side wins).
 * 3. Round each side to the nearest multiple and clamp to the range.
 *
 * Returns { width, height, scale } where scale is the factor applied before rounding
 * (useful for mapping a result back to the source size).
 */
export function snapSize(width, height, multiple = 64, min = 128, max = 2048) {
	width = Number(width);
	height = Number(height);
	if (!(width > 0) || !(height > 0)) throw new Error('width and height must be > 0');

	let scale = 1;
	const longer = Math.max(width, height);
	const shorter = Math.min(width, height);
	if (longer * scale > max) {
		scale = max / longer;
	}
	if (shorter * scale < min) {
		scale = Math.min(min / shorter, max / longer);
	}
	return {
		width: snapValue(width * scale, multiple, min, max),
		height: snapValue(height * scale, multiple, min, max),
		scale,
	};
}

/**
 * Outpaint dimension check: Runware requires each extension to be a multiple of 64 and the
 * final size to equal original + extensions. Rounds each side up to the next multiple.
 */
export function outpaintSize(width, height, ext = {}, multiple = 64) {
	const up = (v) => Math.ceil(Math.max(0, Number(v) || 0) / multiple) * multiple;
	const e = { top: up(ext.top), right: up(ext.right), bottom: up(ext.bottom), left: up(ext.left) };
	return {
		outpaint: e,
		width: width + e.left + e.right,
		height: height + e.top + e.bottom,
	};
}
