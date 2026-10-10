# miniPaint AI: Architecture Notes (Phase 0)

Based on miniPaint 4.14.3 (commit `a79733e`), read from `src/js`. All paths are relative to the repo root. Function and class names are quoted from the code as read. Nothing here was changed in the app.

## 0. Setup and build results

| Item | Result |
|---|---|
| Node / npm | Node v22.22.0, npm 10.9.4 |
| Install | `npm install` exit 0. It rewrote `package-lock.json`; that change was reverted and is not committed. |
| Production build | `npm run build` (runs `webpack --mode production`) exit 0, about 19 s, writes `dist/bundle.js` (1.29 MiB minified). |
| Build warnings | 3 warnings, all performance advice, no errors: "asset size limit" (bundle.js 1.29 MiB over 244 KiB), "entrypoint size limit", "webpack performance recommendations". |
| Dev server | `npx webpack serve --mode development --env development --no-open` compiled successfully in about 10 s. `curl http://localhost:8080/` returned 200 (4689 bytes), `curl http://localhost:8080/dist/bundle.js` returned 200 (3.2 MB, in-memory dev bundle). |
| `npm run server` | Is `webpack serve ... --open`. Do not use it here (no browser); use the `--no-open` command above. |
| `dist/` is tracked | `dist/bundle.js`, `bundle.js.LICENSE.txt`, `bundle.js.map` are committed in git. `npm run build` modifies `dist/bundle.js`. Restore with `git checkout -- dist` before committing (the dev server serves from memory and does not touch `dist/`). |

Dev server security observation (checked with curl against the running dev server): `devServer.static.directory` is the repo root, so the whole repo is served. `/package.json`, `/plan.md`, `/docs/` and `/.git/config` returned 200; `/.babelrc` and `/.gitignore` returned 404. See Risks, item 1.

There is no test runner in `package.json` (no jest, mocha, vitest). No lint script.

## 1. Layer data model

### Where layers live
- `src/js/config.js`: `config.layers = []` (array of layer objects) and `config.layer = null` (the active layer object, same reference as an element of `config.layers`).
- `src/js/core/base-layers.js`: `Base_layers_class` (singleton, exposed as `app.Layers` and `window.Layers`). `get_layer(id)`, `get_layers()`, `get_sorted_layers()`, `auto_increment`.
- `src/js/app.js` exports the `app` object holding singletons: `app.GUI`, `app.Layers`, `app.State`, `app.Actions`, `app.Config`, `app.FileOpen`, `app.FileSave`, `app.Tools`. They are assigned in `src/js/main.js` on `window.load`.

### Layer fields
Default object built in `Insert_layer_action.do()` (`src/js/actions/insert-layer.js`), and documented at the top of `base-layers.js`:

```js
{
  id, parent_id: 0, name, type: null, link: null,
  x: 0, y: 0, width: null, width_original: null, height: null, height_original: null,
  visible: true, is_vector: false, hide_selection_if_active: false,
  opacity: 100,            // 0 to 100, not 0 to 1
  order,                   // z-order, higher is on top
  composition: 'source-over',
  rotate: 0,               // degrees
  data: null, params: {}, status: null, color: config.COLOR,
  filters: [],             // live filters, see section 2
  render_function: null    // [tool_module_key, method_name] for non-image layers
}
```

- `type` is `null` (empty layer), `'image'`, `'text'`, or a shape/tool name (`'rectangle'`, `'ellipse'`, `'line'`, ...).
- For `type: 'image'`, `link` is an `HTMLImageElement` (raster pixels). `width`/`height` are the displayed size, `width_original`/`height_original` are the natural pixel size. `x`,`y` are in canvas coordinates (top left of layer).
- For non-image layers `render_function` is e.g. `['text','render']`; `data` holds type-specific data (for text: lines/spans array); `params` holds tool parameters.
- Keys starting with `_` are private runtime keys and are allowed through `Insert_layer_action` without error (for example `_link_database_id`, `_needs_update_data`). `link_canvas` is a temporary canvas used by the selection tool while moving pixels.
- `Insert_layer_action` rejects unknown keys: `if (typeof layer[i] == "undefined" && !i.startsWith('_')) alertify.error('Error: wrong key: ' + i)`. Any new persistent field (such as `effects`) must be added to the default object in `insert-layer.js`, or it will error on JSON load and on programmatic insert.

### Inserting a layer programmatically
Facade: `app.Layers.insert(settings, can_automate = true)` calls `app.State.do_action(new app.Actions.Insert_layer_action(settings, can_automate))`.

Real examples: paste in `modules/file/open.js` `on_paste()`, and "New from Selection" in `modules/layer/new.js`:

```js
await app.State.do_action(
  new app.Actions.Insert_layer_action({
    name: 'AI: sunset',
    type: 'image',
    data: dataUri,                      // PNG data URI string
    x: 0, y: 0,
    width: w, height: h,                // displayed size
    width_original: w, height_original: h  // natural size, always pass explicitly
  }, false)                             // can_automate = false
);
```

Behavior worth knowing (all in `insert-layer.js`):
- With a string `data`, a new `Image` is created and `layer.link.src = layer.data`; the action awaits `onload`, then sets `width`/`height` from the image if null, and `width_original`/`height_original` from `width`/`height` **if null**. If you pass `width` different from the natural size and omit `width_original`, `width_original` is wrongly set to your `width`. Always pass both pairs.
- With an `HTMLImageElement`/canvas-like object in `data`, it uses `data.cloneNode(true)` and always autoresizes with `can_automate = true` (hardcoded `[w, h, null, true, true]`). Prefer the data URI string path.
- If `config.layers.length == 1` and the only layer is empty (width/height null/0, `data == null`), then for `type == 'image'` that empty layer is deleted first (`Delete_layer_action(..., true)`). For a non-image type with `can_automate !== false`, the empty layer is updated in place via `Update_layer_action` instead of a new one being created.
- New layer gets `id = app.Layers.auto_increment` and `order = auto_increment`, so it lands on top. `config.layer` is set to the new layer (it becomes active).
- `Autoresize_canvas_action` runs after load: it grows the canvas (`config.WIDTH/HEIGHT`) if the layer is larger and the "Enable autoresize" setting is on; it shrinks only when there is one layer and `can_automate !== false`. Pass `can_automate = false` for AI result layers so the canvas never shrinks. Quirk: in its `do()`, the comparison is `new_config_height !== height` (compares to the layer height argument, not `config.HEIGHT`), so it can resize or fail to abort when it should not. Test outpaint paths explicitly.
- Layer names are free text (`name`); "AI: <short prompt>" can be passed directly. The layer list HTML escapes names (`Helper.escapeHtml` in `core/gui/gui-layers.js`).

Other ways pixels change: `app.Layers.update_layer_image(canvas, layer_id)` wraps `Update_layer_image_action` (`actions/update-layer-image.js`). It only replaces `layer.link.src`; it does **not** update `width_original`/`height_original`. It throws unless `layer.type == 'image'`.

## 2. Compositing and render loop

### Loop
`Base_layers_class.render(force)` in `core/base-layers.js`:
- `render(false/undefined)` only sets `config.need_render = true` and returns. `init()` calls `this.render(true)` once, which then runs a self-scheduling `requestAnimationFrame` loop. The loop draws only when `config.need_render` is true.
- Per frame: `pre_render()` (save, `zoomView.canvasDefault()`, clearRect) then `zoomView.apply()` (sets the zoom/pan matrix on the main ctx) then `render_objects(this.ctx, newCanvas, layers_sorted, ...)` then `Base_gui.draw_grid`, `draw_guides`, `Base_selection.draw_selection()` (handles for the active layer), `render_overlay()` (active tool's `render_overlay`), `render_preview(layers_sorted)` (draws the whole stack again to the small preview canvas), `after_render()`.
- Consequence: **every layer is drawn twice per frame** (main canvas and preview thumbnail). Anything expensive (effects) must be cached.

### Per-layer drawing
- `render_objects(ctx, tempCanvas, layers, prepare, shouldSkip)` iterates `for (i = layers.length - 1; i >= 0; i--)` over layers sorted by `order` descending, so the lowest layer is drawn first. For each layer it sets `ctx.globalAlpha = layer.opacity / 100` and `ctx.globalCompositeOperation = layer.composition`, then calls `render_object(ctx, layer)`.
- Layers with `composition === 'source-atop'` (clipping mask pairs) are rendered through a temporary canvas (`tempCtx`). That path strips the `shadow` filter from the clipped layer.
- `render_object(ctx, object, is_preview)`:
  1. returns early if `object.visible == false || object.type == null`
  2. `pre_render_object(ctx, object)` (applies filters, see below)
  3. if `type == 'image'`: `ctx.translate(x + width/2, y + height/2); ctx.rotate(rotate*PI/180); ctx.drawImage(object.link_canvas != null ? object.link_canvas : object.link, -width/2, -height/2, width, height)`
  4. else calls `this.Base_gui.GUI_tools.tools_modules[render_function[0]].object[render_function[1]](ctx, object, is_preview)`
  5. `after_render_object(ctx, object)`

### Existing layer "filters" (live, non-destructive)
- Stored as `layer.filters = [{ id, name, params }]`. Added by `Add_layer_filter_action` (`actions/add-layer-filter.js`; id is `Math.floor(Math.random()*999999999)+1`), removed by `Delete_layer_filter_action`.
- Rendering: `pre_render_object` and `after_render_object` loop over `object.filters`, find the module in `this.Base_gui.modules` whose key contains `effects`, is not `abstract`, and whose basename equals `filter.name`, then call `render_pre(ctx, filter, object)` / `render_post(ctx, filter, object)`.
- Modules implementing live filters (the ones that define `render_pre`, found by grep) are `modules/effects/borders.js` and those under `modules/effects/common/` (blur, brightness, contrast, grayscale, hue-rotate, invert, saturate, sepia, shadow). The common ones each extend `modules/effects/abstract/css.js` (`Effects_common_class`, provides `show_dialog` and `save`). `render_pre` sets `ctx.filter` (CSS filter string, e.g. `drop-shadow(10px 10px 5px #000000)` in `effects/common/shadow.js`), `render_post` resets `ctx.filter = 'none'`. `borders.js` is a live rectangular border: its `render_post` strokes the layer's x/y/width/height rectangle (with rotation), not the alpha silhouette, so it is not a substitute for Stroke. Everything else in `modules/effects/*.js` (box_blur, emboss, vintage, instagram/*, ...) is destructive and goes through `Update_layer_image_action`.
- Filter UI: filters are listed under their layer in `core/gui/gui-layers.js` `render_layers()`; clicking a filter name re-opens its dialog; the dialog (`Effects_common_class.show_dialog`) uses the popup library with `preview: true`.
- Limits for our plan: the existing "shadow" filter is a plain CSS `drop-shadow` on the whole draw call. It does not handle inner shadow, stroke, glow separately from shadow, or bevel; it depends on `CanvasRenderingContext2D.filter` support (verify in Safari before relying on it); and it applies to whatever `render_object` draws, so for text layers it also applies per draw call.
- Bug to avoid copying: `Add_layer_filter_action.undo()` always does `this.reference_layer.filters.pop()`, even when `do()` replaced an existing filter (update branch). Undoing a filter edit removes the wrong filter. Do not reuse this action for layer effects.

### Where non-destructive layer effects should hook
Best single place: inside `render_object()` in `core/base-layers.js`, between `pre_render_object` and `after_render_object`, guarded by `object.effects && object.effects.length`. A small hook there (a call into `src/js/layer-effects/effects.js`) covers the main canvas, the preview, `convert_layers_to_canvas` (export/flatten/save-as-PNG), `merge`, and `flatten` (`modules/layer/flatten.js` and `merge.js` both call `Base_layers.render_object`). Effects must render under the layer's own opacity/composition, which are already set on `ctx` before `render_object` is called, so draw the effect pass into an offscreen canvas and composite it with the ctx state intact.

Details for the hook:
- Offscreen canvas size is the layer bounding box plus effect padding (shadow distance + blur + stroke size), not `config.WIDTH x HEIGHT`.
- The layer silhouette comes from rendering the layer itself into that offscreen canvas (`render_object` recursion with effects disabled) so text, shapes and rotated images all work. Do not rely on `layer.link`, since non-image layers have none.
- Cache key: layer `id` plus a hash of `{x,y,width,height,rotate,params,data/link.src or a version counter,effects}`. There is already `config.need_render_changed_params` that flags param-driven changes, but no per-layer dirty flag, so add a `_fx_version` private counter bumped by the actions you add. Private `_` keys are not saved.
- The cache must be invalidated on `layer.link.src` changes (done asynchronously by `Update_layer_image_action`; the `Image` fires `onload` again, so also listen to it or compare `link.src` length/hash).

## 3. Selection storage

There are two separate things called selection.

1. **Rectangular canvas selection** (the "Selection" tool, `src/js/tools/selection.js`, class `Selection_class`):
   - Stored on the tool instance as `this.selection = { x, y, width, height }` (all `null` when empty). Coordinates are canvas ("world") coordinates, not relative to the active layer, and are not clamped to the canvas.
   - Created in `mousedown`/`mousemove`/`mouseup`: during drag `width`/`height` may be negative; on `mouseup` they are normalized and committed via `Set_selection_action(x, y, width, height, old)`.
   - Coordinates come from `Base_tools.get_mouse_info` and `get_mouse_coordinates_from_event`, which map page coordinates through `zoomView.toWorld`. They are **not rounded**, so at zoom other than 100% they are fractional. Round before use.
   - Only works when `config.layer.type == 'image'`; otherwise `mousedown` shows "This layer must contain an image. Please convert it to raster to apply this tool." A text layer or an empty layer blocks making a selection.
   - Reliable way to read it from code: `app.GUI.GUI_tools.tools_modules.selection.object.selection` (tool modules are registered by `GUI_tools_class.load_plugins()` in `core/gui/gui-tools.js`, keyed by filename).
   - Trap: `app.Layers.Base_selection.get_selection()` is tool-dependent. `Base_selection_class.find_settings()` picks the settings registered under the key equal to `config.TOOL.name`; with any other tool active it falls back to the `'main'` settings whose `data_function` returns `config.layer`. So with the Brush tool active, `get_selection()` returns the active layer object, not the user's selection.
   - Selection lifetime: `Reset_selection_action` is triggered by `Select_layer_action` (selecting another layer clears it), by Escape, by `Selection_class.on_leave()` (declared as `on_leave: 'on_leave'` in `config.TOOLS`, called by `Activate_tool_action` when switching tools), and by `delete_selection`. Capture the selection at click time in the AI panel; do not assume it survives a tool switch or layer click.
   - Rotation is not supported for this selection; "New from Selection" (`modules/layer/new.js` `new_selection()`) ignores layer rotation and maps the selection through `layer.width / layer.width_original` ratios and `layer.x/y`.

2. **Per-layer selection box** (`core/base-selection.js`, `Base_selection_class`): the draggable box with handles around the active layer, driven by `data_function: () => config.layer`. This is layer bounds editing, not a pixel selection.

There is **no** non-rectangular selection, no mask, no alpha channel for selections. grep for `wand`, `lasso`, `feather` in `src/js` finds nothing. Plan.md section 2 says miniPaint already has "magic wand"; it does not. There is `tools/magic_erase.js` (deletes similar pixels) and `tools/fill.js` (flood fill with `power`/`contiguous`), but neither produces a selection.

Other actions: `Set_selection_action`, `Reset_selection_action` (`actions/`). Both mutate the `Base_selection` settings data via `app.Layers.Base_selection.find_settings()`, which is again tool-keyed. Their undo restores old values with `JSON.parse(JSON.stringify(...))` snapshots.

## 4. Menus and dialogs

### Menu registration
- `src/js/config-menu.js` exports `menuDefinition`, a nested array: `{ name, children: [...] }` at the top level; leaves are `{ name, target: 'folder/file.method', shortcut?, ellipsis?, parameter? }`, `{ divider: true }`, or `{ name, href }` for external links.
- `core/gui/gui-menu.js` (`GUI_menu_class`) renders it (`render_main`, `create_dropdown`). On click, `trigger_link` emits `select_target` with `definition.target`.
- `core/base-gui.js` `set_events()` handles it: splits `'file/save.export'` into module `'file/save'` and method `'export'`, then calls `this.modules[module][function_name](param)` where `param = object.parameter ??= null`. Errors "Modules class not found" / "Module function not found" are shown via alertify if the name is wrong.
- Module registry: `Base_gui_class.load_modules()` uses `require.context("./../modules/", true, /\.js$/)` and does `new classObj.default()` for **every** file under `src/js/modules/`, keyed by path without `.js`. So a menu target `ai/panel.show` needs a file `src/js/modules/ai/panel.js` with a default-exported class having a no-argument constructor. Files outside `src/js/modules/` (such as the plan's `src/js/ai/`) are not auto-instantiated; they must be imported by something that is.
- Recommended pattern: keep the real code in `src/js/ai/*` and add a tiny wrapper `src/js/modules/ai/ai.js` (default export class, constructor imports and creates the panel) plus a menu entry. Keep it minimal so upstream merges stay trivial.
- Tools menu currently ends with `Search` and `Settings` (`tools/search.search`, `tools/settings.settings`). Menu strings pass through `Tools_translate` (`class="trn"`); untranslated names simply remain in English.
- Keyboard shortcuts are done ad hoc: each module registers its own `document.addEventListener('keydown', ...)` and bails out with `this.Helper.is_input(event.target)`. Used letters include N (new layer), D (duplicate), T (trim), O (open), S / Shift+S (export/save), Ctrl+Z / Ctrl+Y, Ctrl+C / Ctrl+V, Ctrl+A. No handler uses E, so Ctrl+Shift+E and Ctrl+Enter are free. `Helper.is_input()` returns true for `INPUT` and textarea-type elements but **not** `SELECT` or `BUTTON`; a focused `<select>` in the AI panel will still trigger single-letter shortcuts.

### Popup dialogs (`src/js/libs/popup.js`, `Dialog_class`)
```js
this.POP = new Dialog_class();
this.POP.show({
  title: 'Settings',
  params: [ {name, title, value, type?, values?, range?, step?, placeholder?, html?, function?, comment?} ],
  preview: false,           // true shows left/right preview canvases of the active layer
  on_load(params, popup) {}, on_change(params, ctx, w, h) {}, on_finish(params) {}, on_cancel(params) {},
  className: ''
});
```
- Param rendering rules in `generateParamsHtml()`: `values` array longer than 10 or `type: 'select'` gives a `<select>`; `values` otherwise gives radio buttons; `range: [min,max]` gives a slider; `type: 'color'` uses `uiColorInput`; boolean `value` gives a checkbox; number `value` gives a number input; `type: 'textarea'` gives a textarea; `html:` inserts raw HTML in a row (escape user content yourself); `function:` calls a function that returns HTML.
- `get_params()` reads back inputs whose id starts with `pop_data_`. Enter in a text input saves (`onkeyup`); inputs with `data-prevent-submission` do not.
- One instance renders at most one dialog at a time for that instance (`show()` hides the active one first). The dialog DOM is appended to `#popups`.
- Dialogs are modal-ish forms with OK/Cancel only. For a Layer Style dialog with live preview use `preview: true` and `on_change`, but the preview shows a 225x200 snapshot of the active layer made by `convert_layer_to_canvas()` and an effect-specific callback, which does not match the effects renderer. For a richer dialog, build your own DOM in `#popups` with the same CSS classes (`src/css/popup.css`).

### Docked panel / sidebar
- Static layout is `index.html`: `.wrapper` is a CSS grid (`src/css/layout.css`) with areas `submenu`, `sidebar_left` (`#tools_container`), main (`#middle_area`), `sidebar_right`. Right sidebar blocks are plain markup: `<div class="block"><h2 class="trn toggle" data-target="toggle_x">Title</h2><div class="content" id="toggle_x"></div></div>`. Blocks present: Preview, Colors, Information, Layer details, Layers (`.layers`, `flex: 1`).
- Collapsing is generic: any `h2.toggle[data-target]` toggles `.hidden` on its target and stores state in the settings cookie (`Base_gui_class.set_events` / `load_saved_changes`).
- Sidebar width is fixed: `.sidebar_right { width: 200px; overflow-y: scroll; }`. That is narrow for a prompt box plus verb buttons plus variations thumbnails.
- To add a panel: add a block to `index.html` (small change) or create it from JS at init and `insertBefore` the Layers block, then render content into it. Use theme CSS variables (`--block-background-color`, `--header-background-color`, `--border-color`, `--text-color`) so the existing `theme-dark|light|green` classes apply. A floating panel on `#popups`/`body`, or widening the sidebar, are alternatives.
- The top submenu bar (`#action_attributes`) shows tool attributes generated from `config.TOOLS[].attributes` by `GUI_tools.show_action_attributes()`. Not suited for a prompt UI.

## 5. Undo / redo (actions and state)

### System
- `core/base-state.js` `Base_state_class` (`app.State`): `action_history` array (max `action_history_max = 50`), `action_history_index`. Ctrl+Z / Ctrl+Y handled there (ignored when `Helper.is_input(event.target)`), plus `modules/edit/undo.js` and `redo.js` for the menu.
- `do_action(action, options = {})`: awaits `action.do()`; if it throws, returns `{ status: 'aborted', reason }` and nothing is recorded (that is how "expected" aborts work). On success it truncates redo history (calling `free()` on dropped actions), pushes the action, and when over 50 entries shifts and `free()`s the oldest. `options.merge_with_history` (action_id string or array) wraps the last and new action in a `Bundle_action` if the last action's id matches.
- Undo: `undo_action()` decrements the index and calls `undo()`. Redo: `redo_action()` calls `do()` again on the same action object, so `do()` must be re-runnable and `undo()` must restore exactly.
- There is no global state snapshot. Every change that should be undoable must be an action object. Old code comments referencing `State.save()` are dead; `State.save()` now only alerts.

### Defining an action
`actions/base.js`:
```js
export class Base_action {
  constructor(action_id, action_description) { ...; this.memory_estimate = 0; this.database_estimate = 0; }
  do() { this.is_done = true; }
  undo() { this.is_done = false; }
  free() {}
}
```
Subclasses are in `actions/*.js` and re-exported from `actions/index.js` (`export { Insert_layer_action } from './insert-layer.js';`). `main.js` does `import * as Actions from './actions/index.js'` and `app.Actions = Actions`, so new actions are used as `new app.Actions.My_action(...)` and must be added to `actions/index.js` (a one-line core edit), or you can import them directly from your module.

Conventions: `do()` and `undo()` are `async`, `do()` throws an `Error('Aborted - ...')` to cancel cleanly, store `old_*` values in `do()` for `undo()`, set `config.need_render = true`, call `app.GUI.GUI_layers.render_layers()` if the layer list changed, and release memory in `free()`.

### Bundling
`actions/bundle.js` `Bundle_action(bundle_id, bundle_name, actions_to_do)`: runs actions in order; if one throws, undoes the earlier ones and rethrows; `undo()` runs them in reverse. Usage example from `modules/layer/new.js`:
```js
app.State.do_action(new app.Actions.Bundle_action('new_layer', 'New Layer', [
  new app.Actions.Insert_layer_action(params, false),
  ...this.Selection.on_leave(),
  new app.Actions.Activate_tool_action('select')
]));
```

### What an "add AI result layer" action should look like
Smallest correct version, no new action class needed:

```js
// Phase 3 sketch (not implemented)
await app.State.do_action(
  new app.Actions.Bundle_action('ai_result', 'AI: ' + shortPrompt, [
    new app.Actions.Insert_layer_action({
      name: 'AI: ' + shortPrompt,
      type: 'image',
      data: resultDataUri,                 // already cropped/feathered PNG, see risks
      x: cropX, y: cropY,
      width: cropW, height: cropH,
      width_original: resultW, height_original: resultH,
    }, false)
    // optional extra: a Set_object_property_action or Update_layer_action for metadata
  ])
);
```
- One `do_action` call is one undo step, which satisfies "every AI result is one undo step".
- `Insert_layer_action.undo()` pops the last layer (`config.layers.pop()`), restores `auto_increment` and the previous active layer, and undoes any autoresize.
- Memory: `Insert_layer_action` keeps `this.settings`, including the whole `data` URI string, for redo. History holds up to 50 actions, so several large PNG data URIs can stay in memory. For variations, only insert the picked one; keep unpicked results outside the history. Consider a custom `Ai_result_layer_action extends Base_action` only if you need to free the string in `free()` or to store cost/prompt metadata.
- Store AI metadata in a private key (for example `_ai: { prompt, model, cost }`) only if you do not want it saved; a non-underscore key needs a default added to `insert-layer.js` and will be written to JSON.
- Other available actions: `Update_layer_action(layer_id, settings)` (generic property update; its header comment warns to pass new or cloned objects, not mutated existing ones), `Set_object_property_action`, `Update_config_action`, `Prepare_canvas_action`, `Delete_layer_action`, `Reorder_layer_action`, `Select_layer_action` (also resets selection), `Activate_tool_action`.
- Undo stores replaced image pixels in IndexedDB through `actions/store/image-store.js` (database `undoHistoryImageStore`, deleted on next load if no other tab pinged). That only applies to `Update_layer_image_action`, not to `Insert_layer_action`.

## 6. JSON save / load

### Save
`modules/file/save.js` `File_save_class`:
- "Save As" (`save()`, shortcut Shift+S) offers only the JSON type; "Export" (`export()`, shortcut S) offers PNG/JPG/WEBP/GIF/BMP/TIFF. Both go through `save_general()` then `save_action()`; JSON uses `export_as_json()`.
- `export_as_json()` builds:
  ```js
  { info: { width, height, about, date, version: VERSION, layer_active, guides },
    user_fonts,
    layers: [ ...every key of each layer except keys starting with '_' and 'link_canvas' ],
    data:   [ { id, data: <PNG data URI> } for each layer with type == 'image' ] }
  ```
  then `JSON.stringify(export_data, null, "\t")`.
- `layers[i].link` is an `HTMLImageElement`; `JSON.stringify` turns it into `{}`, so it is harmless; the pixels are stored separately in `data[]` (drawn from `link` at `width_original x height_original`). `VERSION` is injected by webpack `DefinePlugin` from `package.json` version.
- Therefore **any extra enumerable field on a layer object whose name does not start with `_` is saved automatically**. An `effects` array of plain JSON objects will be written into `layers[i].effects` with no change to `save.js`. Functions or DOM objects would not round-trip (the `{}` problem), so effects must be pure data.

### Load
`modules/file/open.js` `load_json(data)`:
- Parses, runs version migrations with `semver_compare(json.info.version, ...)` (for < 4.0.0, 4.5.0, 4.8.0, 4.11.0), then builds one `Bundle_action('open_json_file', ...)` of: `Refresh_action_attributes_action`, `Prepare_canvas_action`, `Update_config_action({ZOOM:1, WIDTH, HEIGHT, user_fonts})`, `Reset_layers_action`, then for each layer `new app.Actions.Insert_layer_action(value, false)` (image layers get `value.link = null` and `value.data = <matching json.data[].data>`), `Select_layer_action(layer_active)`, `Set_object_property_action(Base_layers, 'auto_increment', max_id_order + 1)`, final `Update_config_action` and `Prepare_canvas_action`.
- Round trip for `effects`: save writes it. Load passes it to `Insert_layer_action`, which accepts it **only if `effects` exists in the default layer object**; otherwise `alertify.error('Error: wrong key: effects')` appears for every layer that has the key and the field is dropped (the loop `continue`s without assigning). Fix is one line: add `effects: [],` to the defaults in `actions/insert-layer.js`. Older files without the key load fine because the default `[]` applies.
- Duplicate layer (`modules/layer/duplicate.js`) deep-copies via `JSON.parse(JSON.stringify(config.layer))`, so `effects` duplicates automatically once it is a default key (and `_`-prefixed caches are stripped there).
- Other places that copy layer fields: `Update_layer_action` copies any key given. `modules/layer/raster.js`, `merge.js`, `flatten.js` create fresh layers from a canvas, so effects get baked in by `render_object` (desired) and the new layer has `effects: []`.
- File version: `info.version` is the app version. Bump `package.json` version (or add a `info.effects_version`) if you want a migration hook later.

## 7. Settings storage

- `modules/tools/settings.js` `Tools_settings_class`. `settings()` builds a popup (`Dialog_class`) from a hard-coded param list (transparency, theme, units, resolution, snap, guides, safe_search, exit_confirm, thick_guides, enable_autoresize). `save_values(params)` calls `save_setting(key, value)` for each, and `get_setting(key)` reads with defaults.
- Storage is **one cookie** named `config` holding a JSON object, via `Helper.getCookie(name)` / `setCookie(name, value)` (`libs/helpers.js`): `document.cookie = 'config=' + JSON.stringify(obj) + '; expires=...'` (180 days). Booleans are stored as 1/0 and converted back in `get_setting`. Not URL-encoded. Cookies are limited to about 4 KB per cookie and are sent to the server on every request to the same origin (including to the planned local proxy).
- `config.js` holds runtime defaults (`config.TRANSPARENCY`, `config.SNAP`, `config.enable_autoresize_by_default`, `config.themes`, ...). Note `config.pixabay_key` and `config.google_webfonts_key` are already hardcoded upstream there; do not follow that pattern for Runware.
- For a "Runware" section:
  - The API key must not be here (plan rule: it stays in `server/.env`). The browser only needs the proxy base URL and non-secret preferences (default Fast/Quality, variations count, strength, last model).
  - Use `localStorage` (key like `minipaint_ai_settings`) for these, or add keys to the cookie via `save_setting`. `localStorage` avoids the cookie size limit and avoids sending data to the proxy on each request. If you do reuse the cookie, add defaults in `get_setting`'s `default_values` map.
  - Either extend `settings()` params and `save_values()` (core edit in a shared file, higher merge-conflict risk) or add a separate "AI Settings" popup from your own module (recommended). A "Test connection" button can be a `{ html: '<button id="ai_test">...' }` param plus a click handler attached in `on_load`.

## 8. Build system

- `package.json`: `webpack ^5.106.2`, `webpack-cli ^7.0.2`, `webpack-dev-server ^5.2.3`, `babel-loader ^8`, `@babel/preset-env`, `css-loader`/`style-loader`. Scripts: `server` (`webpack serve --mode development --env development --open`), `dev` (`webpack --mode development`), `build` (`webpack --mode production`).
- `webpack.config.js`: single entry `./src/js/main.js`, output `dist/bundle.js` with `publicPath: '/dist/'`; rules: `.css` via `style-loader` + `css-loader` (`url: false`), `.js` via `babel-loader` (excluding `node_modules`); plugins: `ProvidePlugin` for `$`, `jQuery`, `window.jQuery` (jQuery is available as a global in module code), `DefinePlugin({ VERSION })`; `devtool: "cheap-module-source-map"`; `devServer.static.directory` = repo root.
- `.babelrc`: `@babel/preset-env` plus `@babel/plugin-transform-runtime` (regenerator on), so `async/await` works.
- New folders under `src/js/` such as `src/js/ai/` and `src/js/layer-effects/` are bundled automatically as soon as something imports them; webpack follows `import` statements from `main.js`. There is no glob include. Only two directories are pulled in by `require.context`: `src/js/modules/` (all files instantiated, see section 4) and `src/js/tools/` (all files instantiated as tools, constructor receives the main ctx). Do not place helper files under `modules/` or `tools/` unless they are meant to be auto-instantiated (a helper without a default-exported class constructor will throw at startup).
- CSS: imported from `src/js/main.js` (`./../css/*.css`), and `libs/popup.js` imports `./../../css/popup.css`. A new stylesheet is added by `import` in your module; `style-loader` injects it at runtime.
- `index.html` loads `dist/bundle.js` with a plain script tag in `<head>` (not deferred), and `main.js` waits for `window.load`.
- Node server code under `/server` is outside this pipeline (it needs its own `package.json` or shared root dependencies). `express` is not currently a dependency. `uuid ^8.3.2` is already a runtime dependency (used in `actions/store/image-store.js` with `import { v4 as uuidv4 } from 'uuid'`) and can generate `taskUUID` in the browser; `crypto.randomUUID()` is the alternative.
- Node v22 is installed here, so `node --test` is available for Phase 2 unit tests. `package.json` has no `"type"` field (CommonJS default), so write the size math as a dependency-free module with no `alertify`, CSS or DOM imports and give it an `.mjs` extension (webpack resolves `.mjs` imports when the extension is written explicitly), or set `--experimental-default-type=module` for the test run. Decide in Phase 2.

## Risks and recommendations for Phases 1 to 4

Ordered by how soon they bite.

1. **Dev server serves the whole repo root, including `/server`.** With `devServer.static.directory` = repo root, `curl` shows `/.git/config`, `/package.json`, `/plan.md`, `/docs/` return 200 while `/.babelrc` and `/.gitignore` return 404. A `server/server.js` and any non-dot file under `server/` would be served to the browser; `server/.env` is probably blocked as a dotfile like `.babelrc`, but verify before Phase 1 and do not rely on it. Recommendations: (a) keep `.env` only in `server/`, never copy it into `dist/` or the root; (b) add `devServer.setupMiddlewares` that returns 404 for `/server`, `/.git`, `/node_modules` (or set `static: { directory: path.resolve(__dirname, 'public') }` and move static assets, which is a bigger core change); (c) in production let the Express proxy serve `index.html`, `dist/`, `images/` itself and deny everything else. Also note the proxy and the dev server are different origins, so decide: webpack `devServer.proxy` for `/api` to Express (no CORS, same origin, recommended) or enable CORS on Express restricted to `http://localhost:8080`.
2. **Layer model has no `effects` field and the loader rejects unknown keys.** Add `effects: []` to the defaults in `actions/insert-layer.js` (the one unavoidable core edit for Phase 4). JSON save already serializes it, and duplicate already deep copies it. Add it in Phase 1 or 2 as a no-op to keep later phases mergeable.
3. **Selection is a single axis-aligned rectangle with fractional coordinates, in canvas space, and is cleared often.** There is no mask, no lasso, no wand-selection, no feather. For Phases 2 to 3 (rectangle inpaint) this works if you: read `tools_modules.selection.object.selection` (not `Base_selection.get_selection()`), `Math.round/floor/ceil` it, clamp it to `0..config.WIDTH/HEIGHT`, and snapshot it when the user clicks Run. Selection is lost on tool change, layer click and Escape, and it cannot be made on a non-image layer. For Phase 5 plan a new `src/js/ai/mask.js` that owns a mask canvas (`config.WIDTH x config.HEIGHT`, white = edit) and renders its own overlay through the active tool's `render_overlay` hook or an extra draw call after `render_objects`. Do not try to extend `Base_selection_class` for non-rect shapes. Plan.md section 7 step 1 ("rect, ellipse, lasso, magic wand, or mask brush") is only rect in Phases 2 to 4; adjust wording: ellipse/lasso/wand/brush all belong to Phase 5.
4. **Plan.md assumes a magic wand exists; it does not.** Section 2 "What miniPaint already gives us" lists "magic wand". Only `magic_erase` and `fill` exist. Move "magic wand selection" into Phase 5 explicitly (flood-fill on flattened image into the mask canvas is easy once mask.js exists).
5. **Exporting a flattened image and a region crop.** Do not read `canvas_minipaint` (the on-screen canvas): it has the zoom/pan transform and is only the visible size (`prepare_canvas()` sets `canvas.width = Math.min(Math.ceil(WIDTH*ZOOM), page_w)`). Use the same technique as export (`modules/file/save.js`): create an offscreen canvas of `config.WIDTH x config.HEIGHT`, then `app.Layers.convert_layers_to_canvas(ctx, null /* or layer_id */, false)`. This honors visibility, opacity, composition, rotation, filters and (after the Phase 4 hook) effects. Gotchas: it calls `ctx.save()` in `prepare` without a matching `restore`, and leaves `globalAlpha` and `globalCompositeOperation` at the last layer's values, so reset both (`ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'`) before drawing anything else on that canvas; export code sets `'destination-over'` explicitly for the white background. Transparency: the offscreen canvas is transparent where no layer paints; Runware `seedImage` as PNG data URI keeps alpha, but many models want opaque input, so composite on white or neutral grey for inpaint if needed. Region crop: `ctx.drawImage(flat, sx, sy, sw, sh, 0, 0, dw, dh)` or `getImageData`. For "active layer only" use `convert_layers_to_canvas(ctx, config.layer.id, false)` (it filters by `layer_id`). Do not use `convert_layer_to_canvas()` for AI input: it trims transparent borders and returns `canvas.dataset.x/y` offsets, and `actual_area` mode ignores layer position and scale.
6. **Coordinate and scale gotchas for placing results.** Layer `x,y,width,height` are canvas pixels; for image layers, `width != width_original` when a layer was resized, and `rotate` is applied about the layer center. The result layer from the inpaint pipeline should be inserted with `x = cropX, y = cropY, width = cropW, height = cropH` (crop size in canvas pixels) and `width_original/height_original` = actual returned pixel size (if the crop was scaled to a multiple of 64 and back, either rescale the result to crop size first with `drawImage`, or keep natural size and set display `width/height` to the crop size; the second preserves detail and is simpler). Keep every number an integer (`Math.round`). Layers can extend outside the canvas and selections can too; clamp crops to the canvas before computing the 64-snapped size, or the padding region will include transparent area. `Autoresize_canvas_action` grows the canvas automatically for layers bigger than the canvas (setting "Enable autoresize" on by default via `config.enable_autoresize_by_default`); pass `can_automate=false` and ensure the result fits to avoid surprise canvas growth, and note the `height` comparison quirk in `autoresize-canvas.js`.
7. **Soft-edge clip of the inpaint result without layer masks.** miniPaint has no layer mask, so plan.md section 7 step 5 ("clipped to the original selection with a soft edge") must be implemented by baking the alpha into the result image before insertion: draw the result onto a canvas, then multiply by the feathered mask using `globalCompositeOperation = 'destination-in'` with a blurred white-on-transparent selection shape. The layer stays non-destructive relative to the base image (it is still a separate layer). Real layer masks would be a bigger project and are not required for the stated goals; mark this as a deliberate deviation.
8. **Outpaint and canvas resize.** `Image > Canvas Size` (`modules/image/size.js` `size_handler`) only changes `config.WIDTH/HEIGHT` via `Update_config_action` and does not move layers, so growing on the left or top needs every existing layer shifted by `+left, +top` (one `Update_layer_action(layer.id, {x, y})` per layer in the same `Bundle_action`, plus `Prepare_canvas_action('undo'|'do')` around `Update_config_action`, exactly as `size_handler` does). Write one `Ai_outpaint_action` (or a Bundle built in `canvas-io.js`) so the canvas growth, the layer shift and the result layer are a single undo step. Also zoom: after growing, call the same zoom refresh other flows use (`app.GUI.GUI_preview.zoom_auto()`).
9. **Effects hooks and caching (Phase 4).** Hook inside `Base_layers_class.render_object` as described in section 2; both the main canvas and the preview thumbnail call it every frame, so a per-layer offscreen cache is mandatory or the editor will lag with a few blurred shadows. The preview canvas is scaled by `ctx.scale(w / WIDTH, h / HEIGHT)` before `render_objects`, so effect sizes (blur, distance) are in canvas pixels and scale with the matrix automatically if you draw the cached offscreen bitmap with `drawImage` at layer coordinates; do not pre-multiply by zoom. Existing live filters (`ctx.filter` CSS filters) run in the same `render_object` window; decide the order (suggest effects pass first, then existing filters) or leave both and document it. Text layers (`tools/text.js` `render`) draw straight to the context each frame and have no bitmap, so the silhouette must come from an offscreen render of the layer; also text uses `layer._needs_update_data`, so include it in the cache key. Clip-mask pairs (`source-atop`) go through a different branch in `render_objects` that already strips `shadow` filters; effects need the same handling or they will draw outside the clipped area. Existing `shadow` live filter and a new `dropShadow` effect would double up; hide/rename or document.
10. **Layer Style dialog.** `Dialog_class` (popup.js) is OK for the controls (sliders via `range`, colors via `type: 'color'`, selects), but its built-in `preview: true` shows a snapshot of the current layer through a user callback on a 225x200 canvas, not the live canvas. For live preview, mutate the layer's `effects` immediately in `on_change` (set a private `_fx_version++` and `config.need_render = true`), and on Cancel restore the old array; on OK commit with a single `Update_layer_action(layer.id, { effects: clonedArray })` so it is one undo step. Do not use `Add_layer_filter_action` (undo bug, section 2). Double-click on a layer in the list currently triggers rename (`gui-layers.js` `dblclick` handler on `#layer_name` calls `Layer_rename.rename`), which conflicts with "Layer Style on double click" in plan.md section 8. Suggest: double-click on the layer thumbnail area or an "fx" button next to the name, or a Layer menu entry "Layer Style...".
11. **Settings and the API key.** Settings are one cookie (`config`, about 4 KB, plain JSON, sent with every request to the same host). Keep the key only in `server/.env`. Store UI preferences in `localStorage`. The proxy should bind to `127.0.0.1` only, never log request bodies or headers, and not echo the key back (including in error messages). Because the editor sends data-URI images (multi-MB) the Express JSON body limit must be raised (`express.json({ limit: '50mb' })`) or requests will fail with 413; keep an upper bound. Add a short timeout/abort path (cancel button maps to `AbortController` in the browser and request abort in Node).
12. **Memory and undo.** `Insert_layer_action` retains the full `data` URI in `this.settings` for redo, and up to 50 actions are kept. A 2048 px PNG data URI can be several MB; 4 variations generated and a few accepted results can use tens of MB. Keep variations as `ImageBitmap`/Blob URLs in the panel, and pass only the chosen result as `data`. Consider `Ai_result_layer_action` with a `free()` that drops the string, or accept the cost and document it.
13. **Keyboard handling.** Existing single-letter shortcuts are bound on `document` and only skip when `Helper.is_input(event.target)` is true for `INPUT`/textarea. A prompt `<textarea>` is fine; `<select>` and `<button>` are not covered, so pressing letters while a select has focus can create layers (N), duplicate (D) or trigger save (S). Add `stopPropagation` on keydown inside the AI panel container, or extend `is_input` for `SELECT` (small core edit). Ctrl+Enter and Ctrl+Shift+E are unused.
14. **Panel width and layout.** Right sidebar is 200 px wide and scrolls vertically. For prompt, verb buttons, strength, variations and cost, plan a wider panel (for example 280 px, applied via CSS variable or a class on `.wrapper` grid column) or a collapsible block above Layers. On narrow screens `.sidebar_right` is a slide-in (`active` class, `mobile_menu` buttons); test the panel there or declare it desktop first.
15. **Plan.md Phase 0 and 1 conflicts and adjustments.**
    - Section 2 "magic wand" does not exist (see item 4).
    - Section 7 step 5 implies layer masks; bake into pixels (item 7).
    - Section 8 says to save effects in miniPaint's JSON format; works with one line in `insert-layer.js` (item 2), plus an optional `info` version note.
    - Section 8 "double-click a layer" conflicts with rename (item 10).
    - Section 10 "Touch core miniPaint files only where needed": the minimal expected core touch points are (a) `actions/insert-layer.js` default `effects: []`, (b) `core/base-layers.js` `render_object` effects hook, (c) `config-menu.js` menu entries, (d) `index.html` or JS-injected panel container, (e) optional `actions/index.js` export if you add actions to `app.Actions`, (f) `webpack.config.js` `devServer` hardening. Everything else stays in the new folders.
    - Section 9 Phase 2 says "Unit-test the size math". There is no test runner; Node 22 is available, so write size math as a dependency-free ES module and test with `node --test` (no new npm dependency). Mind the CommonJS default (`package.json` has no `"type"`).
    - Runware model IDs and task names in plan.md section 5 and 6 are unverified here by design; Phase 1 must verify them (the Runware MCP/docs), including task types for background removal and upscaling.
    - Section 4 puts `models.js` in `src/js/ai/` as ES module `export const MODELS`; fine for webpack. Keep it data-only so the Node proxy can also import or duplicate it deliberately.
16. **Repo hygiene.** `dist/` is tracked and `npm install` rewrites `package-lock.json`. Add a note in the README or a pre-commit habit: restore `dist/` and the lockfile unless the change is intended. Commit after each phase as plan.md says, but never commit rebuilt `dist/bundle.js` unless publishing a release. Be aware that webpack `devServer.static` serves `.git/config`; make sure the clone remote URL never embeds a token.

### Suggested small adjustments to the plan
- Phase 1: also add dev-server hardening and `express.json({ limit })` to the proxy checklist; use `devServer.proxy` for `/api`.
- Phase 1: add `effects: []` default now (zero risk) so JSON files saved by later phases open without errors in earlier builds.
- Phase 2: define a single "AI region" object `{ x, y, w, h, source: 'selection'|'full' }` captured at click time; later phases (mask brush, lasso) only need to produce a mask canvas plus its bounding box, so the rest of the pipeline stays unchanged.
- Phase 3: insert results through `Bundle_action` + `Insert_layer_action(..., false)`; add outpaint as one bundle that also shifts layers.
- Phase 4: implement effects as a pure function `renderLayerWithEffects(ctx, layer, drawLayerFn)` in `src/js/layer-effects/effects.js` so it is testable and the `render_object` hook is a 3-line call.
- Phase 5: move "magic wand" and "ellipse selection" here, owned by `ai/mask.js`.

## Phase 1 additions (status)

- Risk 1 addressed: `webpack.config.js` devServer now proxies `/api` to `http://127.0.0.1:8787` (`AI_PROXY_PORT`) and a `setupMiddlewares` hook returns 404 for `/.git`, `/.env`, `/server`, `/node_modules`, `/docs`, any dotfile, `plan.md` and `package*.json` (paths are decoded and normalized first, so `%2Egit` and `../` tricks are blocked too).
- Proxy: `server/index.js` (Express, `express.json({ limit: '50mb' })`, binds 127.0.0.1). Mock mode in `server/mock.js`. Combined runner `server/start-ai.js`.
- New code: `src/js/ai/` (`runware-client.js`, `models.js`, `size.js`, `ai-generate.js`, `__tests__/size.test.mjs`) plus the thin wrapper `src/js/modules/ai/ai.js` (menu targets `ai/ai.generate`, `ai/ai.settings`).
- Core files touched: `config-menu.js` (AI menu), `webpack.config.js` (devServer), `package.json` (scripts, express). No changes to layer, render or undo code yet.
- AI results use `Bundle_action('ai_generate', ...)` of `Insert_layer_action(..., false)` with explicit `width_original/height_original`, so a batch is one undo step (verified in a headless browser: Ctrl+Z removes all, Ctrl+Y restores).
- The Generate dialog reuses `Dialog_class` but replaces the OK button's listener (clone and swap) so the dialog stays open while the request runs, and stops keydown propagation so editor shortcuts do not fire while typing.

## AI canvas I/O (Phase 2)

Files: `src/js/ai/canvas-io.js` (browser, uses `app`/`config`), `src/js/ai/region-math.js` (pure math, `node --test`), `src/js/ai/ai-debug.js` (debug menu actions). The helpers are also exposed as `window.AI_canvas_io` for the console and tests.

Pipeline for an inpaint request:
1. `getAiRegion()` reads `tools_modules.selection.object.selection` and normalizes it with `normalizeRect` (fix negative sizes, round edges, clamp to canvas, reject < 8 px). Call it when the user starts the action. `fullCanvasRegion()` is the fallback.
2. `buildRequestRegion(region)` pads by 25% of the region's longer side, clamps to the canvas, picks a scale (long side >= 512, short side >= 128, nothing over 2048), snaps the send size to multiples of 64, then grows the crop (never shrinks it) toward the send aspect ratio so x and y scale almost the same.
3. `flattenToCanvas({source})` renders all visible layers (or one layer) into a `config.WIDTH x config.HEIGHT` canvas through `convert_layers_to_canvas`, then restores ctx state. No selection overlay, grid, guides or rulers; zoom has no effect.
4. `exportRegion(canvas, crop, send)` crops and scales to a PNG data URI. `buildMask(region, crop, send, {feather})` makes an opaque black PNG with the selection white in send space, using per-pixel coverage for anti-aliased edges; `feather` adds an outward ramp.
5. `placeResult(image, crop, region, {feather, name})` scales the result back to crop size, bakes an inward soft clip (default 8 px, no feather on sides touching the canvas edge, capped at 1/4 of the short side) with `destination-in`, and inserts one layer at `crop.x, crop.y` in a `Bundle_action('ai_place_result')`.

Outpaint: `computeOutpaint({top,right,bottom,left})` (canvas px) returns `seed` (snapped, scaled canvas), `outpaint` (send px, multiples of 64), `final` (= seed + outpaint, <= 2048), `ext` (canvas px actually added) and `newCanvas`. Send `exportOutpaintSeed(plan)` with `width/height = plan.final` and `outpaint = plan.outpaint`. `applyOutpaintCanvas(plan, result, {placement, blend})` is one `Bundle_action('ai_outpaint')`: `Prepare_canvas_action('undo')`, `Update_config_action({WIDTH, HEIGHT})`, one `Update_layer_action` per layer to shift x/y by `ext.left/ext.top`, `Prepare_canvas_action('do')`, then `Insert_layer_action` for the result. Growing through `Update_config_action` (the Image > Canvas Size pattern) skips `Autoresize_canvas_action` entirely, and the inserted layer matches the new canvas size, so the autoresize quirk never applies.

Layering choice for outpaint: the result goes on top, masked to the new border plus a 24 px soft blend band into the original. Originals keep every pixel; hiding the AI layer shows the plain original on a bigger canvas. `placement: 'bottom'` instead puts the unmasked result under everything.

Gotchas found while testing:
- Escape in a popup also reaches the Selection tool's own document keydown handler, which clears the selection and records a `clear_selection` history step. Phase 3 should capture the region before opening any dialog and should not rely on the selection surviving Escape.
- Resampling to the send size and back blurs 1 px detail (for example grid lines) in the placed result: well inside the selection the inverted test result had median error 0 and p95 about 29/255, all of it on grid lines. This is inherent to scaling; the crop pixels themselves export exactly (max diff 0).
- The Information panel only refreshes the canvas size on mousemove (upstream behavior). `applyOutpaintCanvas` calls `show_size()` after applying.

## AI panel and verbs (Phase 3)

Files: `src/js/ai/ai-panel.js` + `ai-panel.css` (floating panel, created on window load by the module wrapper, exposed as `window.AI_panel`), `src/js/ai/ai-verbs.js` (one runner per verb: prepare pixels, call Runware, return a result whose `place()` is a single undo step), `runware-client.js` (request format fallback, diagnose, injectable transport for tests), `server/mock.js` (PNG decode/encode with zlib, per-task fake results).

- Verbs and models: Generate (runware:400@2 fast / 101@1 quality, canvas size snapped), Inpaint (runware:102@1, `inputs.seedImage` + `inputs.maskImage`, strength, `maskMargin: 64` when the selection is under 40% of the send image), Edit (runware:400@2 with `inputs.referenceImages`, size multiple of 16 / runware:106@1 with a fixed size preset), Outpaint (runware:102@1, `outpaint {top,right,bottom,left,blur}`), Remove BG (runware:112@5 / bria:2@1, `inputs.image`), Upscale (runware:504@1 / bria:52@1, `inputs.image`, `upscaleFactor` 2 or 4).
- Placement: `placeResults` (canvas-io) bakes the soft clip and inserts N layers in one `Bundle_action('ai_place_result')`; `applyOutpaintCanvas` and the new `applyUpscaleCanvas` resize the canvas through `Update_config_action` and update every layer with `Update_layer_action` inside the same bundle.
- Request format: `getRequestFormat()` returns `{imageInference: {style}, utility: {style, taskTypes}}` from localStorage key `minipaint_ai_request_format`. `run_with_fallback` retries once with the other style (and, for utility tasks, the other task type name) only when `classifyFormatError` says the error points at inputs or taskType; content errors (credits, sizes) are never retried.
- Panel keyboard isolation: the panel root stops propagation of keydown/keyup/keypress/mousedown/touchstart/wheel so document handlers (tool shortcuts, Selection tool Escape, Base_selection drag) never see them.
- miniPaint CSS hides every `button:disabled` (`visibility: hidden` in reset.css); the panel overrides that inside `.ai_panel`.
- Panel state keys: `minipaint_ai_panel` (position, open, collapsed, verb, prompt, options).
