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
- Selection, magic wand, crop, clone, fill, brush, eraser, text ("letter")
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
- **Mask convention:** white = area to edit, black = keep.
- `width` / `height`: 128 to 2048, **divisible by 64**.
- `outpaint`: `{ top, right, bottom, left, blur }`. Each side a **multiple of 64**. Final `width`/`height` must equal original size plus extensions.
- `maskMargin` (32 to 128) zooms into the masked area for sharper inpaint detail. Use it for small selections.
- `strength` (0 to 1, default 0.8) controls how far the result drifts from the original.
- `referenceImages` is used by instruction-edit models (FLUX Kontext style).
- `numberResults` 1 to 20. We use 1 to 4 for a variations picker.
- `outputFormat: "PNG"`, `outputType: "dataURI"` or `"URL"`.
- **Always send `includeCost: true`** and show the `cost` (USD) after every generation.
- Background removal and upscaling are separate task types. Claude Code must confirm the current task names and parameters in the Runware docs before implementing them.

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

Do **not** hardcode guessed model IDs. In Phase 1, Claude Code looks up current AIR IDs using the Runware model search (docs or the Runware MCP) and fills this table. Known from the docs as a starting point (verify first):

- `runware:102@1` is FLUX Fill (inpaint / outpaint candidate)
- `runware:106@1` appears in the docs' FLUX Kontext reference-image example (edit candidate)

```js
// models.js shape
export const MODELS = {
  generate: { fast: "<AIR>", quality: "<AIR>" },
  inpaint:  { fast: "<AIR>", quality: "<AIR>" },
  edit:     { fast: "<AIR>", quality: "<AIR>" },
  outpaint: { fast: "<AIR>", quality: "<AIR>" },
};
```

---

## 7. The inpaint pipeline (most important flow)

1. User makes a selection (rect, ellipse, lasso, magic wand, or mask brush).
2. `canvas-io.js`:
   - flattens visible layers to an image (option: "active layer only")
   - computes the selection bounding box, adds padding (about 25%), crops that region
   - scales the crop so both sides are multiples of 64 and within 2048
   - builds a matching black/white mask (white = selection), with optional feather
3. `runware-client.js` sends `seedImage` + `maskImage` + prompt + `strength` + `includeCost: true` (+ `maskMargin` for small selections).
4. Result comes back, gets scaled back to the crop size and placed at the crop position on a **new layer**.
5. That new layer is clipped to the original selection with a soft edge, so only the edited area shows.
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

Cache each layer's rendered effects and only re-render when the layer or its effects change. Add a "Layer Style" dialog (double-click a layer) with live preview, plus "copy style / paste style".

---

## 9. Phases

### Phase 0: Setup and recon
- Fork `viliusle/miniPaint` to my GitHub, clone locally.
- `npm install`, then read `package.json` scripts and the repo Wiki "Build instructions" to get dev server and build working.
- Claude Code maps the codebase and writes `docs/ARCHITECTURE-NOTES.md`: where layers live, how compositing works, how selection is stored, how menus/dialogs are registered, how undo state is captured, how JSON save/load works.
- **Done when:** dev server runs and the notes file exists.

### Phase 1: Proxy + Runware client
- `/server` Express proxy, `.env` with `RUNWARE_API_KEY`, `.env.example` committed, `.env` gitignored.
- `runware-client.js` with a "Test connection" button in Settings.
- Look up and fill `models.js`.
- **Done when:** a Generate call from the UI places an image on a new layer and shows its cost.

### Phase 2: Canvas I/O
- Flatten, crop with padding, size snapping to 64, selection to mask, feather, place result back.
- Unit-test the size math (snapping, outpaint dimensions).
- **Done when:** a debug button exports image + mask PNGs that line up perfectly.

### Phase 3: AI panel
- Docked panel: prompt box, verb buttons, Fast/Quality toggle, strength slider, variations count, model dropdown.
- Inpaint, Edit, Outpaint, then Remove BG and Upscale.
- Variations picker (thumbnails, click to place).
- Loading state on the canvas area being edited, cancel button, clear error messages.
- Every AI result is one undo step.
- **Done when:** select, prompt, Enter, result layer appears, cost shown.

### Phase 4: Layer effects
- Effects data model, renderer, cache, Layer Style dialog, copy/paste style, save/load in JSON.
- **Done when:** a text layer with drop shadow + stroke + bevel looks right, saves and reloads.

### Phase 5: Selection upgrades
- Lasso and polygonal lasso if missing or weak.
- Mask brush (paint the AI edit area, with a red overlay like Quick Mask).
- Feather / expand / contract.
- Optional: "Select Subject" using Runware background removal output as a mask.

### Phase 6: Polish
- Keyboard shortcuts: Ctrl+Enter to run AI, Ctrl+Shift+E for Edit.
- Session cost counter in the status bar.
- Prompt history dropdown.
- Clean dark theme.
- README with setup steps and screenshots.

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
