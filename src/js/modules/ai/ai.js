/*
 * miniPaint AI: thin module wrapper so menu targets 'ai/ai.<method>' resolve.
 * Base_gui_class.load_modules() instantiates every file under src/js/modules/, so this file
 * must stay a default-exported class with a no-argument constructor. Real code is in src/js/ai/.
 */

import AI_generate_class from './../../ai/ai-generate.js';
import AI_debug_class from './../../ai/ai-debug.js';
import AI_panel_class from './../../ai/ai-panel.js';
import * as canvas_io from './../../ai/canvas-io.js';

class AI_module_class {

	constructor() {
		this.AI_generate = new AI_generate_class();
		this.AI_debug = new AI_debug_class();
		this.AI_panel = new AI_panel_class();
		// Console and test access to the canvas I/O helpers and the panel.
		window.AI_canvas_io = canvas_io;
		window.AI_panel = this.AI_panel;
		// Modules are created before the GUI renders; build the panel once the page is ready.
		if (document.readyState === 'complete') {
			setTimeout(() => this.AI_panel.init(), 0);
		} else {
			window.addEventListener('load', () => setTimeout(() => this.AI_panel.init(), 0));
		}
	}

	panel() {
		this.AI_panel.init();
		this.AI_panel.toggle();
		if (this.AI_panel.open) this.AI_panel.set_collapsed(false);
	}

	generate() {
		this.AI_generate.show_generate();
	}

	settings() {
		this.AI_generate.show_settings();
	}

	diagnose() {
		return this.AI_generate.diagnose();
	}

	debug_export() {
		return this.AI_debug.export_region();
	}

	debug_place() {
		return this.AI_debug.place_test_result();
	}
}

export default AI_module_class;
