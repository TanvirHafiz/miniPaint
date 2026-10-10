/*
 * miniPaint AI: thin module wrapper so menu targets 'ai/ai.<method>' resolve.
 * Base_gui_class.load_modules() instantiates every file under src/js/modules/, so this file
 * must stay a default-exported class with a no-argument constructor. Real code is in src/js/ai/.
 */

import AI_generate_class from './../../ai/ai-generate.js';
import AI_debug_class from './../../ai/ai-debug.js';
import * as canvas_io from './../../ai/canvas-io.js';

class AI_module_class {

	constructor() {
		this.AI_generate = new AI_generate_class();
		this.AI_debug = new AI_debug_class();
		// Console and test access to the canvas I/O helpers.
		window.AI_canvas_io = canvas_io;
	}

	generate() {
		this.AI_generate.show_generate();
	}

	settings() {
		this.AI_generate.show_settings();
	}

	debug_export() {
		return this.AI_debug.export_region();
	}

	debug_place() {
		return this.AI_debug.place_test_result();
	}
}

export default AI_module_class;
