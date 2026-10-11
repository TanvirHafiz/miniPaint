# plan.md: miniPaint + Runware AI Image Editor

Working title: **miniPaint AI** (rename later)
Owner: Tanvir Hafiz
Builder: Claude Code
Base repo: https://github.com/viliusle/miniPaint (MIT license, plain JavaScript, HTML5 canvas, webpack)

---

## 1. Goal

A lightweight, browser-based, Photoshop-style image editor with fast AI editing powered by the Runware API.

It should feel like a small Photoshop: layers, selections, layer effects (shadow, glow, stroke, bevel), basic adjustments. The headline feature is AI editing on the canvas: select an area, type a prompt, get the result back as a new layer in seconds.

**Not a goal:** matching Photoshop's feature count. Keep the interface clean and the AI loop fast.

---

## 2. What miniPaint already gives us

- Multi-layer system with merge, flatten, transparency
- Rectangular selection, crop, clone, fill, magic eraser, brush, eraser, text
- Note (Phase 0): there is no magic wand, lasso or ellipse selection and no masks. Selection is one axis-aligned rectangle (see docs/ARCHITECTURE-NOTES.md section 3).
- Color corrections, filters, effects, Instagram-style filters
- Undo, clipboard paste, drag and drop, save as PNG/JPG/WEBP/JSON (layers)
- Runs fully in the browser, no backend

## 3. What we add

1. **Runware AI panel** (the core of the project)
2. **Real layer effects**: Drop Shadow, Inner Shadow, Outer Glow, Stroke, Bevel & Emboss (non-destructive, editable, stored on the layer)
3. **Better selection to mask tools**: lasso, a "mask brush" for painting AI edit areas, feather
4. **A tiny local proxy** so the Runware API key never reaches the browser

---

## 4. Architecture

```
Browser (miniPaint + AI panel)
   |
   |  fetch / WebSocket  (no API key in the browser)
   v
Local proxy (Node, Express)  <-- reads RUNWARE_API_KEY from .env
   |
   v
Runware API  (https://api.runware.ai/v1  or  wss://ws-api.runware.ai/v1)
```

New code lives in its own folders so upstream miniPaint updates stay mergeable:

```
/server/                  Node proxy (Express), .env, start script
/src/js/ai/
   runware-client.js      calls the proxy, builds task payloads, handles responses
   models.js              verb -> model routing table (Fast / Quality presets)
   canvas-io.js           export image, selection -> mask, crop + margin, size snapping
   ai-panel.js            UI: prompt box, verb buttons, variations picker, cost display
/src/js/layer-effects/
   effects.js             effect definitions + renderer
   effects-dialog.js      Layer Style dialog UI
```

---

## 5. Runware API facts the code must respect

- One task type, `imageInference`, covers text-to-image, image-to-image, inpainting and outpainting. The workflow is chosen by which parameters are sent.
- Every task needs a unique `taskUUID` (UUID v4). Requests are an **array** of task objects.
- `seedImage` and `maskImage` accept a UUID of an uploaded image, a data URI, raw base64, or a public URL. Data URIs are simplest for us.
- **Input shape (checked in Phase 1):** the public REST docs put `seedImage`, `maskImage`, `referenceImages` (and `inputImage` for utilities) at the task root, but the current per-model schemas and Runware's own example requests nest them under `inputs` (`inputs.seedImage`, `inputs.maskImage`, `inputs.referenceImages`, `inputs.image`) with `additionalProperties: false`. The client defaults to the `inputs` style; `buildInputs()` in `runware-client.js` is the only place that knows the shape, and `INPUT_STYLE` in `models.js` flips it.
- **Mask convention:** white = area to edit, black = keep.
- `width` / `height`: 128 to 2048, **divisible by 64**.
- `outpaint`: `{ top, right, bottom, left, blur }`. Each side a **multiple of 64**. Final `width`/`height` must equal original size plus extensions.
- `maskMargin` (32 to 128) zooms into the masked area for sharper inpaint detail. Use it for small selections.
- `strength` (0 to 1, default 0.8) controls how far the result drifts from the original.
- `referenceImages` is used by instruction-edit models (FLUX Kontext style).
- `numberResults` 1 to 20. We use 1 to 4 for a variations picker.
- `outputFormat: "PNG"`, `outputType: "dataURI"` or `"URL"`.
- **Always send `includeCost: true`** and show the `cost` (USD) after every generation.
- Background removal and upscaling are separate task types. REST docs: `imageBackgroundRemoval` / `imageUpscale` with root `inputImage`. Current model examples: `removeBackground` / `upscale` with `inputs.image` (responses echo `imageBackgroundRemoval` / `imageUpscale`). Recorded in `models.js`; verify with a live key before shipping Remove BG / Upscale (Phase 3).

Docs: https://runware.ai/docs/en/image-inference/api-reference

---

## 6. AI verbs (what the user sees)

| Verb | Needs | Runware call | Result |
|---|---|---|---|
| **Generate** | prompt, canvas size | text-to-image | new layer |
| **Inpaint** | selection + prompt | `seedImage` + `maskImage` + `strength` | new layer, masked to selection |
| **Edit** | prompt only, whole image or selection | instruction-edit model with `referenceImages` / `seedImage` | new layer |
| **Outpaint** | direction + pixels | `outpaint` object | canvas expands, result as new layer |
| **Remove BG** | active layer | background removal task | new layer with transparency |
| **Upscale** | active layer | upscale task | new document or replaced layer |
| **Variations** | any of the above | `numberResults: 4` | thumbnail picker, click to place |

**Golden rule:** AI results never overwrite pixels. They always arrive as a new layer named `AI: <short prompt>`, so the user can toggle, mask, erase or delete them.

### Model routing (`models.js`)

Each verb gets a **Fast** and a **Quality** model, plus an "Advanced" dropdown to pick any model.

Filled in Phase 1 from Runware's curated catalog (see `src/js/ai/models.js` for labels, capability flags and size rules):

```js
export const MODELS = {
  generate: { fast: "runware:400@2" /* FLUX.2 klein 9B, multiple of 16 */, quality: "runware:101@1" /* FLUX.1 dev */ },
  edit:     { fast: "runware:400@2" /* inputs.referenceImages, up to 4 */, quality: "runware:106@1" /* FLUX.1 Kontext dev */ },
  inpaint:  { fast: "runware:102@1", quality: "runware:102@1" },   // FLUX.1 Fill
  outpaint: { fast: "runware:102@1", quality: "runware:102@1" },
  removeBg: { fast: "runware:112@5" /* BiRefNet */, quality: "bria:2@1" },
  upscale:  { fast: "runware:504@1" /* Real-ESRGAN x2/x4 */, quality: "bria:52@1" },
  erase:    { fast: "runware:300@1", quality: "bfl:flux@erase" },  // later
};
```

---

## 7. The inpaint pipeline (most important flow)

1. User makes a selection. Phases 2 to 4: the existing rectangle only, captured at click time as an "AI region" (selection is cleared on tool change, layer click and Escape). Ellipse, lasso, magic wand and mask brush arrive in Phase 5 as a mask canvas plus bounding box, so the rest of this pipeline does not change.
2. `canvas-io.js`:
   - flattens visible layers to an image (option: "active layer only")
   - computes the selection bounding box, adds padding (about 25%), crops that region
   - scales the crop so both sides are multiples of 64 and within 2048
   - builds a matching black/white mask (white = selection), with optional feather
3. `runware-client.js` sends `seedImage` + `maskImage` + prompt + `strength` + `includeCost: true` (+ `maskMargin` for small selections).
4. Result comes back, gets scaled back to the crop size and placed at the crop position on a **new layer**.
5. That new layer is clipped to the original selection with a soft edge, so only the edited area shows. miniPaint has no layer masks, so the soft edge is **baked into the result layer's alpha** (`destination-in` with a feathered mask) before insertion. The base image is untouched because the result is still its own layer.
6. Status bar shows: time taken and `$cost`.

Small crops sent to the API = faster and cheaper than sending the full image every time. This is where the "fast" feeling comes from.

---

## 8. Layer effects (non-destructive)

Store an `effects` array on each layer object, saved in miniPaint's JSON format:

```js
layer.effects = [
  { type: "dropShadow", enabled: true, color: "#000", opacity: 0.6, angle: 120, distance: 8, size: 12 },
  { type: "stroke", enabled: true, color: "#fff", size: 3, position: "outside" },
  { type: "bevel", enabled: true, depth: 100, size: 6, angle: 120, altitude: 30, highlight: "#fff", shadow: "#000" }
];
```

Render effects at composite time (not baked into pixels):

- **Drop Shadow / Outer Glow:** draw the layer's alpha as a silhouette with canvas `shadowBlur` / `shadowColor`, offset by angle and distance.
- **Inner Shadow:** invert the alpha, blur, clip to the layer.
- **Stroke:** dilate the alpha mask (outside), erode (inside), or both (center).
- **Bevel & Emboss:** treat a blurred alpha as a height map, compute a simple light direction from angle/altitude, paint highlights and shadows, clip to the layer.

Cache each layer's rendered effects and only re-render when the layer or its effects change (every layer is drawn twice per frame: canvas and preview). Add a "Layer Style" dialog with live preview, plus "copy style / paste style". Trigger: an "fx" button on the layer row and a Layer menu entry, **not** double-click (double-click already renames a layer).

Phase 0 findings for this section: hook the renderer inside `Base_layers_class.render_object` (covers canvas, preview, export, merge, flatten); add `effects: []` to the layer defaults in `actions/insert-layer.js` so JSON load accepts it (save already serializes it); commit edits with one `Update_layer_action` (do not reuse `Add_layer_filter_action`, its undo pops the wrong filter).

---

## 9. Phases

### Phase 0: Setup and recon (DONE, branch phase-0-recon)
- Fork `viliusle/miniPaint` to my GitHub, clone locally.
- `npm install`, then read `package.json` scripts and the repo Wiki "Build instructions" to get dev server and build working.
- Claude Code maps the codebase and writes `docs/ARCHITECTURE-NOTES.md`: where layers live, how compositing works, how selection is stored, how menus/dialogs are registered, how undo state is captured, how JSON save/load works.
- **Done when:** dev server runs and the notes file exists. Done: build and dev server verified, notes in `docs/ARCHITECTURE-NOTES.md`.

### Phase 1: Proxy + Runware client (DONE, branch phase-1-runware)
- `/server` Express proxy, `.env` with `RUNWARE_API_KEY`, `.env.example` committed, `.env` gitignored.
- `runware-client.js` with a "Test connection" button in Settings.
- Look up and fill `models.js`.
- Dev server forwards `/api` to the proxy and blocks `/.git`, `/server`, `/node_modules`, `/docs`, `plan.md`, `package*.json` and dotfiles.
- **Done when:** a Generate call from the UI places an image on a new layer and shows its cost. Done in mock mode (`RUNWARE_MOCK=1`); a live call needs a real key (see README "AI features").

### Phase 2: Canvas I/O (DONE, branch phase-2-canvas-io)
- Flatten, crop with padding, size snapping to 64, selection to mask, feather, place result back.
- Unit-test the size math (snapping, outpaint dimensions).
- **Done when:** a debug button exports image + mask PNGs that line up perfectly. Done: AI > Debug: Export Region + Mask and Debug: Place Test Result; verified in headless Chromium on a 1013x771 document at 100% and 300% zoom (mask within 1 px of the selection, region pixels exact, outside pixels unchanged, one undo).
- Decisions: padding 25% of the region's longer side; small crops upscaled so the long side is at least 512; send size snapped to 64 inside 128..2048 with the crop grown toward the send aspect; mask hard by default (feather option, outward); result clip feather 8 px inward (none on canvas edges); outpaint result on top masked to the new border plus a 24 px blend band, canvas growth via Update_config_action so Autoresize_canvas_action is not involved.
- Code: `src/js/ai/canvas-io.js`, `region-math.js` (+ tests), `ai-debug.js`.

### Phase 3: AI panel (DONE, branch phase-3-ai-panel)
- Docked panel: prompt box, verb buttons, Fast/Quality toggle, strength slider, variations count, model dropdown. The right sidebar is only 200 px wide; give the AI panel its own wider column (about 280 px) or a collapsible block, and stop keydown propagation inside it so editor shortcuts (N, D, S) do not fire.
- Outpaint must be one undo step that grows the canvas, shifts every existing layer by the left/top extension, and inserts the result.
- Inpaint, Edit, Outpaint, then Remove BG and Upscale.
- Variations picker (thumbnails, click to place).
- Loading state on the canvas area being edited, cancel button, clear error messages.
- Every AI result is one undo step.
- **Done when:** select, prompt, Enter, result layer appears, cost shown. Done in mock mode (headless Chromium, 43 checks); live check list in README.
- UX decisions:
  - Floating 320 px panel (draggable, collapsible, hideable; state in localStorage), open by default, toggled by an AI button in the top bar and AI > Show / Hide AI Panel. Verb tabs plus one Run button (Ctrl+Enter) so verb options are visible before running.
  - Keyboard inside the panel never reaches editor shortcuts; Escape in the panel cancels or blurs and keeps the canvas selection.
  - Selection captured on Run; dashed animated overlay on the working region; Cancel aborts (nothing is placed even if a late response arrives; the cost is still counted).
  - Variations (2 to 4) for Generate, Inpaint, Edit: thumbnails, click to place one (one undo each), Place all (one undo).
  - Edit without a selection works on the whole image (full-canvas result layer). Kontext [dev] only accepts fixed sizes, so it uses the preset closest to the crop aspect.
  - Remove BG works on the active layer by default (or Whole image), never hides anything automatically, offers "Hide original".
  - Upscale: the document is upscaled in one undo step (canvas x factor, every layer's position and size x factor, upscaled image as a new top layer) plus a Download PNG link. Inputs over 4096 px are refused, outputs over 8000 px ask for confirmation. Known limit: text font sizes and vector stroke widths are not scaled, only the layer boxes.
  - Request format safety: automatic one-time fallback between 'inputs' and 'root' image placement and between the two task type names, remembered per task kind; AI > Diagnose Request Format probes both with the cheapest task.

### Phase 4: Layer effects
- Effects data model, renderer, cache, Layer Style dialog, copy/paste style, save/load in JSON.
- **Done when:** a text layer with drop shadow + stroke + bevel looks right, saves and reloads. **DONE** (branch phase-4-layer-effects).
- Built: `src/js/layer-effects/` (`effects-math.js` pure + tested, `effects.js` renderer with per-layer cache, `layer-style.js` + `.css` dialog), `modules/layer/style.js` menu wrapper. Effects: drop shadow, outer glow, inner shadow, stroke (outside/inside/center), bevel and emboss. Layer > Layer Style..., Copy / Paste / Clear Layer Style, and an fx button on each layer row (lit when effects exist). One undo step per dialog OK.
- Core hooks (small, commented): `render_object` in `core/base-layers.js`, `effects: []` default in `actions/insert-layer.js`, `Update_layer_action` refreshes the layer list when `effects` changes, fx button in `gui-layers.js`, menu entries in `config-menu.js`.
- Verified in headless pane: pixel checks for stroke, shadow direction, bevel light side on image and text layers, JSON save then load gives identical pixels, undo/redo/cancel. Known limits: effects are cached at document resolution (soft at high zoom); no knock-out, no gradient or pattern fills, fixed effect order; effects on layers over 6000 px are skipped.

### Phase 5: Selection upgrades
- Lasso and polygonal lasso (missing), ellipse selection, magic wand selection (missing; only magic eraser exists). Owned by a new `src/js/ai/mask.js` mask canvas.
- Mask brush (paint the AI edit area, with a red overlay like Quick Mask).
- Feather / expand / contract.
- Optional: "Select Subject" using Runware background removal output as a mask.

**Phase 5 status: DONE (branch phase-5-selection), except optional Select Subject.**
- Built a separate AI mask instead of extending miniPaint's rectangle selection (its tool system clears selection on tool or layer change): `src/js/ai/mask-math.js` (pure, unit tested: bbox, combine, magic wand flood fill, exact euclidean grow and shrink, feather), `mask.js` (document sized alpha store with its own 20 step undo, wand on the flattened image, from rectangle, to canvas, snapshot), `mask-editor.js` (red overlay at 45% and tools: rect, lasso, polygonal lasso, ellipse, magic wand with tolerance and contiguous, brush, eraser; modes New, Add, Subtract, Shift adds, Alt subtracts; [ and ] resize the brush; Ctrl+Z undoes the mask while a mask tool is active), `mask-ui.js` (collapsible Mask section in the AI panel: tools, mode, brush size, tolerance, Invert, Feather, Grow, Shrink, Clear, From select, Undo, Amount, Show mask).
- When a mask exists, Inpaint and Edit use it instead of the rectangle: its bounding box is the region, the inpaint mask sent to Runware is the mask itself (soft edges kept), and the result layer is clipped to the mask. Verified in mock mode: result alpha is 255 inside the mask, 0 in a carved hole and outside, one undo removes the result.
- Limits: the mask is cleared when the document size changes (resize, outpaint, upscale); mask edits are not in the document undo history; Outpaint, Remove BG and Upscale ignore the mask.

### Phase 6: Polish
- Keyboard shortcuts: Ctrl+Enter to run AI, Ctrl+Shift+E for Edit.
- Session cost counter in the status bar.
- Prompt history dropdown.
- Clean dark theme.
- README with setup steps and screenshots.

**Phase 6 status: DONE (branch phase-6-polish).** Global Ctrl+Enter (run) and Ctrl+Shift+E (Edit), prompt history (last 30, Recent button, Alt+Up/Down; `ai-history.js`, unit tested), session cost chip in the bottom left (`ai-status.js`; the layout has no status bar so it is a fixed chip), README updated for mask tools, effects, themes and shortcuts. The dark theme item moved to Phase 7. README screenshots were added later in `docs/screenshots/` (made with headless Chrome against the live API).

### Phase 7: Modern UI redesign (requested, do after Phase 6)
- Redesign the whole editor interface to look modern: new theme tokens (CSS variables) with dark and light modes, refreshed top menu, toolbar icons, sidebar panels, dialogs, layer list and the AI panel and Layer Style dialog, consistent spacing, type and motion.
- Approach: first write a short design brief (look, palette, density) and get the owner's sign-off, then restyle through CSS variables with minimal core markup changes so upstream merges stay possible.
- Replaces the "Clean dark theme" item in Phase 6.
- **Done when:** every screen and dialog uses the new theme in both modes, and nothing functional regressed.
- **Direction chosen: A, Studio** (charcoal, indigo accent, 8 to 12px corners, floating panels), dark default plus a light mode. Status: first pass DONE on branch phase-7-ui-redesign: `src/css/modern.css` (loaded last; overrides the existing theme variables for dark and light, restyles menu bar, dropdowns, tool strip, right panels, layer list, dialogs, AI panel, Layer Style), View > Toggle Light / Dark Theme (`modules/view/theme.js`, saved to the theme setting). The green theme still works and gets the new shapes. Checked: dark and light, menus, Resize dialog, AI panel, Layer Style, layer list.
- **Phase 7 second pass: DONE (branch phase-7b-ui-polish).** New consistent stroke icon set for all 19 tools (`images/icons-studio/*.svg`, 24px, follows the theme through the existing icon filter), restyled option bar, button groups, number inputs, range sliders, color picker, preview block controls, remaining dialog elements (inputs, selection cards, pagination, buttons), alertify notifications and dialogs, `color-scheme` per theme, and small-screen fixes (the 700px slide-in sidebars and mobile menu keep working, checked at 375 px). Not done: the 17 or so less common dialogs were not each opened and inspected; expect small leftovers. The upstream icons in `images/icons/` are untouched (menu and layer icons still use them).

---

### Distribution (DONE, branch release-packaging)
- Portable zip: `npm run package` (`tools/package.js`) stages the built editor, `server/` (index.js, mock.js, serve.js, .env.example), Express in `node_modules`, `start.bat`, `start.sh` and a README, then zips it. Users only need Node 18+. `server/serve.js` serves the editor and the proxy on one port and only exposes `index.html`, `dist/` and `images/`.
- Release workflow `.github/workflows/release.yml`: pushing a `v*` tag runs the tests, builds the zip and creates the GitHub release.
- Static demo `.github/workflows/pages.yml`: pushes to `master` deploy the editor to GitHub Pages. The AI client uses relative `api/...` URLs and the panel shows a notice when no proxy answers, so the demo says AI is off instead of failing.
- Not done: a bundled Node binary (zip stays small), an Electron or Tauri app (section 12).

---

## 10. Rules for Claude Code

- Keep new code in `/src/js/ai/`, `/src/js/layer-effects/` and `/server/`. Touch core miniPaint files only where needed, with small, commented hooks.
- Never put the API key in frontend code, URLs, or logs.
- Never overwrite user pixels with AI output. Always a new layer.
- Always request `includeCost: true` and display the cost.
- Snap all sizes sent to Runware to multiples of 64, max 2048.
- Verify Runware task names and model IDs against current docs before coding them. Do not guess.
- Commit after each phase with a clear message. Keep the app runnable at every commit.
- No em dashes in UI text, docs, or comments.

---

## 11. Kickoff prompt to paste into Claude Code

> Read plan.md in this repo. Start with Phase 0: get the dev server running, then explore the codebase and write docs/ARCHITECTURE-NOTES.md covering layers, compositing, selection storage, menus and dialogs, undo, and JSON save/load. Stop after Phase 0 and summarize what you found and any risks for Phases 1 to 4 before writing feature code.

---

## 12. Later ideas (not now)

- ComfyUI as a second provider behind the same client interface
- Electron or Tauri wrapper for a desktop app
- Hosted version with user accounts and per-user keys (proxy already makes this possible)
- Prompt presets tuned per model
