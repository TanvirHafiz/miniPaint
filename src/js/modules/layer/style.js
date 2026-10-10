/*
 * miniPaint layer effects: thin module wrapper so menu targets 'layer/style.<method>' resolve.
 * Real code is in src/js/layer-effects/.
 */

import Layer_style_class from './../../layer-effects/layer-style.js';

class Layer_style_module_class {

	constructor() {
		this.style = new Layer_style_class();
		window.AI_layer_style = this.style; // console and test access
	}

	open() {
		this.style.open();
	}

	copy() {
		this.style.copy();
	}

	paste() {
		this.style.paste();
	}

	clear() {
		this.style.clear();
	}
}

export default Layer_style_module_class;
