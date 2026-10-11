/*
 * miniPaint redesign: View > Toggle Light / Dark Theme. Styles live in src/css/modern.css.
 */

import Base_gui_class from './../../core/base-gui.js';
import Tools_settings_class from './../tools/settings.js';

class View_theme_class {

	constructor() {
		this.Base_gui = new Base_gui_class();
		this.Tools_settings = new Tools_settings_class();
	}

	toggle() {
		const dark = !document.body.classList.contains('theme-light');
		const next = dark ? 'light' : 'dark';
		this.Base_gui.change_theme(next);
		this.Tools_settings.save_setting('theme', next);
	}
}

export default View_theme_class;
