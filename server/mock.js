/*
 * Mock Runware responses for offline testing (RUNWARE_MOCK=1).
 * Builds simple PNGs with zlib (no extra dependencies) and returns them in the same shape
 * Runware uses: { data: [ { taskType, taskUUID, imageUUID, imageDataURI | imageURL, seed, cost } ] }.
 */

const zlib = require('zlib');
const crypto = require('crypto');

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td), 0);
	return Buffer.concat([len, td, crc]);
}

/**
 * Creates an RGB PNG: a vertical gradient from color a to color b with a darker diagonal
 * stripe, so placement and orientation are visible in the editor.
 */
function makePng(width, height, a, b) {
	const rowLen = width * 3 + 1;
	const raw = Buffer.alloc(rowLen * height);
	for (let y = 0; y < height; y++) {
		const t = height > 1 ? y / (height - 1) : 0;
		const r = Math.round(a[0] + (b[0] - a[0]) * t);
		const g = Math.round(a[1] + (b[1] - a[1]) * t);
		const bl = Math.round(a[2] + (b[2] - a[2]) * t);
		const off = y * rowLen;
		raw[off] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const p = off + 1 + x * 3;
			const stripe = Math.abs(((x + y) % 128) - 64) < 6;
			raw[p] = stripe ? r >> 1 : r;
			raw[p + 1] = stripe ? g >> 1 : g;
			raw[p + 2] = stripe ? bl >> 1 : bl;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type RGB
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function clampSize(v, fallback) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(16, Math.min(2048, n));
}

function colorFromSeed(seed) {
	return [(seed * 97) % 200 + 40, (seed * 57) % 200 + 40, (seed * 31) % 200 + 40];
}

function mockResponse(tasks) {
	const data = [];
	for (const task of tasks) {
		const n = Math.max(1, Math.min(20, parseInt(task.numberResults, 10) || 1));
		const width = clampSize(task.width, 512);
		const height = clampSize(task.height, 512);
		for (let i = 0; i < n; i++) {
			const seed = crypto.randomInt(0, 2 ** 31);
			const png = makePng(width, height, colorFromSeed(seed), colorFromSeed(seed + 7));
			const imageUUID = crypto.randomUUID();
			const item = {
				taskType: task.taskType,
				taskUUID: task.taskUUID,
				imageUUID,
				seed,
				cost: 0,
			};
			const b64 = png.toString('base64');
			if (task.outputType === 'dataURI') item.imageDataURI = 'data:image/png;base64,' + b64;
			else if (task.outputType === 'base64Data') item.imageBase64Data = b64;
			else item.imageDataURI = 'data:image/png;base64,' + b64; // URL mode: no host to serve from, so fall back to a data URI
			data.push(item);
		}
	}
	return { data };
}

module.exports = { mockResponse, makePng };
