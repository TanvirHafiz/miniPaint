/*
 * miniPaint AI: thin module wrapper so menu targets 'ai/ai.<method>' resolve.
 * Base_gui_class.load_modules() instantiates every file under src/js/modules/, so this file
 * must stay a default-exported class with a no-argument constructor. Real code is in src/js/ai/.
 */

import AI_generate_class from './../../ai/ai-generate.js';

class AI_module_class {

	constructor() {
		this.AI_generate = new AI_generate_class();
	}

	generate() {
		this.AI_generate.show_generate();
	}

	settings() {
		this.AI_generate.show_settings();
	}
}

export default AI_module_class;
