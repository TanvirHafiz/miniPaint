/*
 * Mock Runware responses for offline testing (RUNWARE_MOCK=1). No extra dependencies:
 * PNGs are decoded and encoded with zlib.
 *
 * Plausible results per task:
 * - imageInference, text only:          gradient with a diagonal stripe at width x height
 * - imageInference + seedImage + mask:  seed resized to width x height, color channels rotated
 *                                       (inpaint stand-in; the client clips it to the selection)
 * - imageInference + outpaint:          final size, warm gradient border, seed pasted at (left, top)
 * - imageInference + referenceImages:   first reference resized to width x height, channels rotated
 * - background removal:                 input with a transparent border (12% per side)
 * - upscale:                            input scaled by upscaleFactor (nearest neighbor)
 *
 * Both request formats are accepted ('inputs' object or task root, either task type name).
 * RUNWARE_MOCK_REJECT_STYLE=inputs|root makes the mock reject that format with a Runware-like
 * validation error, to exercise the client's automatic fallback.
 * Response shape: { data: [ { taskType, taskUUID, imageUUID, imageDataURI, seed, cost } ] }.
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

/* ------------------------------------------------------------------ RGBA images */

/** @returns {{width:number, height:number, data:Buffer}} RGBA8 */
function makeImage(width, height) {
	return { width, height, data: Buffer.alloc(width * height * 4) };
}

/** Encodes RGBA8 (color type 6). */
function encodePng(img) {
	const { width, height, data } = img;
	const rowLen = width * 4 + 1;
	const raw = Buffer.alloc(rowLen * height);
	for (let y = 0; y < height; y++) {
		raw[y * rowLen] = 0;
		data.copy(raw, y * rowLen + 1, y * width * 4, (y + 1) * width * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Decodes 8-bit, non-interlaced PNGs with color type 0, 2, 4 or 6 (what browsers produce from
 * canvas.toDataURL). Returns RGBA8 or null if unsupported.
 */
function decodePng(buf) {
	if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
	let pos = 8;
	let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
	const idat = [];
	while (pos + 8 <= buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString('ascii', pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8];
			color = body[9];
			interlace = body[12];
		} else if (type === 'IDAT') {
			idat.push(body);
		} else if (type === 'IEND') {
			break;
		}
		pos += 12 + len;
	}
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
	if (depth !== 8 || interlace !== 0 || !channels || !width || !height) return null;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const v = raw[src + x];
			const a = x >= channels ? pixels[dst + x - channels] : 0;
			const b = y > 0 ? pixels[dst + x - stride] : 0;
			const c = x >= channels && y > 0 ? pixels[dst + x - stride - channels] : 0;
			let out;
			switch (filter) {
				case 1: out = v + a; break;
				case 2: out = v + b; break;
				case 3: out = v + ((a + b) >> 1); break;
				case 4: out = v + paeth(a, b, c); break;
				default: out = v;
			}
			pixels[dst + x] = out & 0xff;
		}
	}
	const img = makeImage(width, height);
	for (let i = 0, j = 0; i < width * height; i++, j += channels) {
		const o = i * 4;
		if (channels === 4) {
			img.data[o] = pixels[j]; img.data[o + 1] = pixels[j + 1]; img.data[o + 2] = pixels[j + 2]; img.data[o + 3] = pixels[j + 3];
		} else if (channels === 3) {
			img.data[o] = pixels[j]; img.data[o + 1] = pixels[j + 1]; img.data[o + 2] = pixels[j + 2]; img.data[o + 3] = 255;
		} else if (channels === 2) {
			img.data[o] = img.data[o + 1] = img.data[o + 2] = pixels[j]; img.data[o + 3] = pixels[j + 1];
		} else {
			img.data[o] = img.data[o + 1] = img.data[o + 2] = pixels[j]; img.data[o + 3] = 255;
		}
	}
	return img;
}

/** Image from a data URI, raw base64 or null (URLs and UUIDs are not resolvable offline). */
function imageFromInput(value) {
	if (typeof value !== 'string' || value.length === 0) return null;
	let b64 = value;
	const m = /^data:image\/[a-zA-Z]+;base64,(.*)$/.exec(value);
	if (m) b64 = m[1];
	else if (!/^[A-Za-z0-9+/=]+$/.test(value)) return null;
	try {
		return decodePng(Buffer.from(b64, 'base64'));
	} catch (e) {
		return null;
	}
}

function resize(src, width, height) {
	const out = makeImage(width, height);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * src.height / height));
		for (let x = 0; x < width; x++) {
			const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * src.width / width));
			src.data.copy(out.data, (y * width + x) * 4, (sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4);
		}
	}
	return out;
}

/** Rotates RGB channels (r <- g, g <- b, b <- r) and forces alpha 255: an obvious "edit". */
function colorShift(img) {
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		const r = d[i];
		d[i] = d[i + 1];
		d[i + 1] = d[i + 2];
		d[i + 2] = r;
		d[i + 3] = 255;
	}
	return img;
}

function gradient(width, height, seed) {
	const a = [(seed * 97) % 200 + 40, (seed * 57) % 200 + 40, (seed * 31) % 200 + 40];
	const b = [((seed + 7) * 97) % 200 + 40, ((seed + 7) * 57) % 200 + 40, ((seed + 7) * 31) % 200 + 40];
	const img = makeImage(width, height);
	for (let y = 0; y < height; y++) {
		const t = height > 1 ? y / (height - 1) : 0;
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const stripe = Math.abs(((x + y) % 128) - 64) < 6;
			for (let k = 0; k < 3; k++) {
				const v = Math.round(a[k] + (b[k] - a[k]) * t);
				img.data[o + k] = stripe ? v >> 1 : v;
			}
			img.data[o + 3] = 255;
		}
	}
	return img;
}

function paste(dst, src, ox, oy) {
	for (let y = 0; y < src.height; y++) {
		const ty = y + oy;
		if (ty < 0 || ty >= dst.height) continue;
		for (let x = 0; x < src.width; x++) {
			const tx = x + ox;
			if (tx < 0 || tx >= dst.width) continue;
			src.data.copy(dst.data, (ty * dst.width + tx) * 4, (y * src.width + x) * 4, (y * src.width + x) * 4 + 4);
		}
	}
}

/** Kept for backward compatibility (Phase 1 tests): RGB gradient PNG buffer. */
function makePng(width, height) {
	return encodePng(gradient(width, height, 1));
}

/* ------------------------------------------------------------------ tasks */

function clampSize(v, fallback) {
	const n = parseInt(v, 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.max(16, Math.min(8192, n));
}

/** Reads image inputs in either format. */
function readInputs(task) {
	const inp = task.inputs && typeof task.inputs === 'object' ? task.inputs : {};
	return {
		seedImage: inp.seedImage || task.seedImage,
		maskImage: inp.maskImage || task.maskImage,
		referenceImages: inp.referenceImages || task.referenceImages,
		image: inp.image || task.inputImage,
		style: task.inputs ? 'inputs' : (task.seedImage || task.maskImage || task.referenceImages || task.inputImage ? 'root' : null),
	};
}

const UTILITY_TYPES = {
	removeBackground: 'imageBackgroundRemoval',
	imageBackgroundRemoval: 'imageBackgroundRemoval',
	upscale: 'imageUpscale',
	imageUpscale: 'imageUpscale',
};

function mockOne(task, seed) {
	const inp = readInputs(task);
	const kind = UTILITY_TYPES[task.taskType];
	if (kind === 'imageBackgroundRemoval') {
		const src = imageFromInput(inp.image) || gradient(256, 256, seed);
		const bx = Math.round(src.width * 0.12);
		const by = Math.round(src.height * 0.12);
		for (let y = 0; y < src.height; y++) {
			for (let x = 0; x < src.width; x++) {
				if (x < bx || x >= src.width - bx || y < by || y >= src.height - by) src.data[(y * src.width + x) * 4 + 3] = 0;
			}
		}
		return { img: src, taskType: kind };
	}
	if (kind === 'imageUpscale') {
		const src = imageFromInput(inp.image) || gradient(256, 256, seed);
		const f = parseInt(task.upscaleFactor, 10) === 4 ? 4 : 2;
		return { img: resize(src, src.width * f, src.height * f), taskType: kind };
	}

	const width = clampSize(task.width, 512);
	const height = clampSize(task.height, 512);
	const seedImg = imageFromInput(inp.seedImage);
	if (task.outpaint && seedImg) {
		const o = task.outpaint;
		const out = gradient(width, height, seed);
		const sw = width - (o.left || 0) - (o.right || 0);
		const sh = height - (o.top || 0) - (o.bottom || 0);
		paste(out, resize(seedImg, Math.max(1, sw), Math.max(1, sh)), o.left || 0, o.top || 0);
		return { img: out, taskType: task.taskType };
	}
	if (seedImg) {
		return { img: colorShift(resize(seedImg, width, height)), taskType: task.taskType };
	}
	const refs = Array.isArray(inp.referenceImages) ? inp.referenceImages : [];
	const ref = refs.length ? imageFromInput(refs[0]) : null;
	if (ref) {
		const w = task.width ? width : ref.width;
		const h = task.height ? height : ref.height;
		return { img: colorShift(resize(ref, w, h)), taskType: task.taskType };
	}
	return { img: gradient(width, height, seed), taskType: task.taskType };
}

/**
 * @returns {{status:number, body:object}}
 */
function mockHandle(tasks) {
	const reject = (process.env.RUNWARE_MOCK_REJECT_STYLE || '').trim();
	const data = [];
	for (const task of tasks) {
		const inp = readInputs(task);
		if (reject && inp.style === reject) {
			const param = reject === 'inputs' ? 'inputs' : (task.inputImage ? 'inputImage' : 'seedImage');
			return { status: 400, body: { errors: [{ code: 'invalidParameter', parameter: param, message: 'Mock: unsupported parameter ' + param + ' (RUNWARE_MOCK_REJECT_STYLE=' + reject + ')', taskUUID: task.taskUUID }] } };
		}
		const n = UTILITY_TYPES[task.taskType] ? 1 : Math.max(1, Math.min(20, parseInt(task.numberResults, 10) || 1));
		for (let i = 0; i < n; i++) {
			const seed = crypto.randomInt(0, 2 ** 31);
			const { img, taskType } = mockOne(task, seed + i * 13);
			const b64 = encodePng(img).toString('base64');
			const item = { taskType, taskUUID: task.taskUUID, imageUUID: crypto.randomUUID(), seed, cost: 0 };
			if (task.outputType === 'base64Data') item.imageBase64Data = b64;
			else item.imageDataURI = 'data:image/png;base64,' + b64;
			data.push(item);
		}
	}
	return { status: 200, body: { data } };
}

/** Backward compatible: returns the body only. */
function mockResponse(tasks) {
	return mockHandle(tasks).body;
}

module.exports = { mockResponse, mockHandle, makePng, decodePng, encodePng };
