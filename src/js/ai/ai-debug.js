/*
 * miniPaint AI: debug tools for canvas I/O (no Runware call).
 * - Export region + mask: shows exactly what an inpaint request would send.
 * - Place test result: inverts the exported region locally and runs placeResult, so the whole
 *   crop, scale, clip and place-back round trip can be checked by eye or by tests.
 */

import app from '../app.js';
import Dialog_class from '../libs/popup.js';
import alertify from '../../../node_modules/alertifyjs/build/alertify.min.js';
import {
	DEFAULTS, getAiRegion, fullCanvasRegion, buildRequestRegion, flattenToCanvas,
	exportRegionCanvas, buildMaskCanvas, placeResult,
} from './canvas-io.js';

/** Last request computed by a debug action (also handy from the console: window.AI_debug_last). */
let last = null;

function plan_request(opts = {}) {
	const selected = getAiRegion();
	const region = selected || fullCanvasRegion();
	const req = buildRequestRegion(region, opts);
	const flat = flattenToCanvas({ source: opts.source || 'visible' });
	last = { region, selected: !!selected, ...req };
	window.AI_debug_last = last;
	return { region, selected: !!selected, req, flat };
}

function scale_canvas(src, w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.drawImage(src, 0, 0, w, h);
	return c;
}

export class AI_debug_class {

	constructor() {
		this.POP = new Dialog_class();
	}

	/**
	 * Inserts the region (crop size) and its mask (scaled back to crop size) as two layers at
	 * crop.x / crop.y in one undo step, then offers both send-size PNGs for download.
	 */
	async export_region() {
		const { region, selected, req, flat } = plan_request();
		const regionCanvas = exportRegionCanvas(flat, req.crop, req.send);
		const maskCanvas = buildMaskCanvas(region, req.crop, req.send, { feather: DEFAULTS.maskFeather });
		const regionURI = regionCanvas.toDataURL('image/png');
		const maskURI = maskCanvas.toDataURL('image/png');

		// Region layer: the exact crop from the flattened canvas (pixel exact, for alignment checks).
		// Mask layer: the send-size mask scaled back to crop size. The send-size PNGs are offered
		// as downloads below.
		const crop_only = exportRegionCanvas(flat, req.crop, { w: req.crop.w, h: req.crop.h });
		const back = (c) => scale_canvas(c, req.crop.w, req.crop.h).toDataURL('image/png');
		const common = {
			type: 'image',
			x: req.crop.x,
			y: req.crop.y,
			width: req.crop.w,
			height: req.crop.h,
			width_original: req.crop.w,
			height_original: req.crop.h,
		};
		await app.State.do_action(
			new app.Actions.Bundle_action('ai_debug_export', 'AI Debug Export', [
				new app.Actions.Insert_layer_action({ ...common, name: 'AI debug: region', data: crop_only.toDataURL('image/png') }, false),
				new app.Actions.Insert_layer_action({ ...common, name: 'AI debug: mask', data: back(maskCanvas), opacity: 50 }, false),
			])
		);

		const info = (selected ? 'Selection' : 'No selection, whole canvas') + ': '
			+ region.w + 'x' + region.h + ' at ' + region.x + ',' + region.y
			+ '. Crop ' + req.crop.w + 'x' + req.crop.h + ' at ' + req.crop.x + ',' + req.crop.y
			+ '. Send ' + req.send.w + 'x' + req.send.h + ' (scale ' + req.scaleX.toFixed(3) + ' x ' + req.scaleY.toFixed(3) + ').';
		this.POP.show({
			title: 'AI Debug: region + mask',
			params: [
				{ title: 'Request:', html: '<span id="ai_debug_info">' + info + '</span>' },
				{ title: 'Download:', html: '<a href="' + regionURI + '" download="ai-region-' + req.send.w + 'x' + req.send.h + '.png" id="ai_debug_dl_region">region.png</a>'
					+ ' &nbsp; <a href="' + maskURI + '" download="ai-mask-' + req.send.w + 'x' + req.send.h + '.png" id="ai_debug_dl_mask">mask.png</a>' },
				{ title: '', html: '<span class="text_muted">Two layers were added at the crop position (mask at 50% opacity). One Ctrl+Z removes both.</span>' },
			],
		});
		return { region, ...req, regionURI, maskURI };
	}

	/**
	 * Stand-in AI result: inverts the region in send space, then runs placeResult with the
	 * default clip feather. Uses the current selection, or the whole canvas.
	 */
	async place_test_result(opts = {}) {
		const { region, selected, req, flat } = plan_request(opts);
		const send = exportRegionCanvas(flat, req.crop, req.send);
		const ctx = send.getContext('2d');
		const img = ctx.getImageData(0, 0, send.width, send.height);
		const d = img.data;
		for (let i = 0; i < d.length; i += 4) {
			d[i] = 255 - d[i];
			d[i + 1] = 255 - d[i + 1];
			d[i + 2] = 255 - d[i + 2];
			d[i + 3] = 255;
		}
		ctx.putImageData(img, 0, 0);
		const feather = opts.feather !== undefined ? opts.feather : DEFAULTS.clipFeather;
		const result = await placeResult(send, req.crop, selected ? region : null, { feather, name: 'AI: debug invert' });
		alertify.success('Placed test result: crop ' + req.crop.w + 'x' + req.crop.h + ', send ' + req.send.w + 'x' + req.send.h + '.', 5);
		return { region, selected, ...req, result };
	}
}

export default AI_debug_class;
