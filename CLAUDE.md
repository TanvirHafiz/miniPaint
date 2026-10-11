# CLAUDE.md: miniPaint AI

Context for Claude Code. Read this first, then `plan.md` (the full plan and phase status) and `docs/ARCHITECTURE-NOTES.md` (how miniPaint works internally, with file and function names).

## What this project is

A fork of miniPaint (plain JavaScript, HTML5 canvas, webpack, jQuery) turned into a lightweight Photoshop-style editor with fast AI editing through the Runware API. Owner: Tanvir Hafiz. Not a goal: matching Photoshop's feature count.

## Current status

- Phases 0 to 6 are done (Phase 7 UI redesign has a first pass) (see `plan.md`, section 9). Each phase is on its own stacked branch: `phase-0-recon` -> `phase-1-runware` -> `phase-2-canvas-io` -> `phase-3-ai-panel` -> `phase-4-layer-effects` -> `phase-7-ui-redesign` -> `phase-5-selection` -> `phase-6-polish` -> `phase-7b-ui-polish`. The latest branch contains everything.
- Live with a real key, the owner has confirmed **Generate (text to image) works**.
- Image-input verbs (Inpaint, Edit, Outpaint, Remove BG, Upscale) are confirmed working live. Runware's REST docs put image inputs at the task root but the model schemas nest them under `inputs`; the client defaults to `inputs`, falls back once on a validation error and remembers the result in localStorage. **AI > Diagnose Request Format** re-checks it cheaply on a new machine.
- Phase 5 added the AI mask (`src/js/ai/mask*.js`): free-form selection tools that Inpaint and Edit use instead of the rectangle. Phase 7 first pass added `src/css/modern.css` (dark and light).
- Phase 6 added Ctrl+Enter and Ctrl+Shift+E shortcuts, prompt history and a session cost chip.
- Phase 7 is finished apart from small leftovers (see `plan.md`).
- Next: optional Select Subject, then new ideas from `plan.md` section 12. Release v0.1.0 and the Pages demo are live.

## Run it

```
npm install
# put the key in server/.env (gitignored):  RUNWARE_API_KEY=...
npm run start:ai            # proxy on 127.0.0.1:8787 + dev server on :8080
npm run start:ai -- --mock  # no key, zero cost, fake results for every verb
npm run test:ai             # node --test unit tests (size, region math, client fallback)
npm run build               # production bundle
```

`npm run package` builds the portable zip in `release/` (see README, Try it); `node server/serve.js` serves the built app plus proxy on one port.

Do not use `npm run server` (it passes `--open`). Open http://localhost:8080.

## Where things are

- `server/index.js`: Express proxy. `POST /api/runware` forwards task arrays to Runware with the key from `RUNWARE_API_KEY` env or `server/.env`. `GET /api/health`. Never logs the key or image bodies. `server/mock.js`: mock results. `server/start-ai.js`: runs proxy + dev server.
- `webpack.config.js`: dev server proxies `/api` and 404s private paths (`.git`, `server`, `node_modules`, `docs`, dotfiles, `plan.md`, `package*.json`). Keep this.
- `src/js/ai/`:
  - `runware-client.js`: request building, `buildInputs()` (the only place that decides input style), fallback, cancel, cost.
  - `models.js`: verb to model routing (Fast / Quality), size rules, Kontext size presets, task type notes.
  - `size.js`, `region-math.js`: pure math, unit tested.
  - `canvas-io.js`: flatten, capture selection, crop + snap, mask, place result as new layer, outpaint canvas growth.
  - `ai-panel.js` + `ai-panel.css`: floating AI panel. `ai-verbs.js`: the six verbs. `ai-generate.js`: quick Generate and settings dialogs. `ai-debug.js`: debug menu items.
- `src/js/modules/ai/ai.js`: thin wrapper wiring the above into miniPaint's module system. Menu entries are in `src/js/config-menu.js`.

- Live test (2026-10, real key, about $0.01 total): Generate, Inpaint, Edit, Outpaint, Remove BG and Upscale all work. FLUX Fill (`runware:102@1`) needs `CFGScale` 20 and `strength` 1 for inpaint, otherwise it ignores the prompt and keeps the old pixels (now the defaults).

## Rules

- Keep new code in `src/js/ai/`, `src/js/layer-effects/` and `server/`. Touch core miniPaint files only with small, commented hooks.
- AI results never overwrite pixels: always a new layer named `AI <verb>: <prompt>`, one undo step (`Bundle_action`).
- Always send `includeCost: true` and show the cost after every generation.
- Respect each model's size rules from `models.js` (FLUX Fill: multiples of 64, 128 to 2048; klein: multiples of 16; Kontext: fixed presets).
- Never put the API key in frontend code, URLs, logs or commits. `server/.env` stays gitignored.
- Verify Runware model IDs and parameters against current docs or schemas before using new ones. Do not guess.
- miniPaint gotchas (details in ARCHITECTURE-NOTES): selection is a rectangle only and is cleared by Escape, tool change and layer click, so capture it before opening dialogs; unknown layer keys throw in `insert-layer.js` unless added to defaults or prefixed with `_`; double-click on a layer already means rename.
- `npm run build` rewrites tracked `dist/bundle.js`. Do not commit `dist/` changes unless releasing.
- Work on a new branch per phase (e.g. `phase-4-layer-effects` off `phase-3-ai-panel`), commit after each phase, keep the app runnable at every commit.
- Writing style: no em dashes anywhere (UI text, docs, comments, commit messages).

## Testing

- Run `npm run test:ai` and `npm run build` before every commit.
- For UI work, test in the real browser against `--mock` first, then with the real key. Keep live tests cheap (Fast models, small images, 1 result).
- Pixel-level checks matter: pixels outside a selection must be unchanged, results must line up with the selection, and one Ctrl+Z must remove a result.
