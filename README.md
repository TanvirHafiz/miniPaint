# miniPaint

Online image editor lets you create and edit images using HTML5 technologies. No need to buy, download, install, or have outdated flash. No ads. Key features: layers, filters, open source Photoshop alternative.

miniPaint operates directly in the browser. You can create images by pasting from the clipboard (ctrl+v) or uploading from the computer (_using menu or drag & drop_). Nothing will be sent to any server. Everything stays in your browser. 

## URL:
**https://viliusle.github.io/miniPaint/**

## Preview:
![miniPaint](https://raw.githubusercontent.com/viliusle/miniPaint/master/images/preview.gif)
(generated using miniPaint)

**Change log:** [/miniPaint/releases](https://github.com/viliusle/miniPaint/releases)

## Browser Support
- Chrome
- Firefox
- Opera
- Edge
- Safari
- Yandex

## Features

**Files**: open images, directories, URLs, data URLs, drag and drop, save (PNG, JPG, BMP, WEBP, animated GIF, TIFF, JSON (layers data), print.

**Edit**: undo, cut, copy, paste, selection, paste from the clipboard.

**Image**: information, EXIF, trim, zoom, resize (Hermite resample, default resize), rotate, flip, color corrections (brightness, contrast, hue, saturation, luminance), automatic color adjustment, grid, histogram, negative.

**Layers**: multi-layer system, differences, merging, flattening, transparency support.

**Effects**: black and white, blur (box, gaussian, stack, zoom), bulge/pinch, denoise, desaturation, dither, dot screen, edge, emboss, enrich, gamma, grains, grayscale, heatmap, jpg compression, mosaic, oil, sepia, sharpen, solarize, tilt shift, vignette, vibrance, vintage, blueprint, night vision, pencil, also instagram filters: 1977, aden, clarendon, gingham, inkwell, lo-fi, toaster, valencia, x-pro ii.

**Tools**: pencil, brush, magic wand, eraser, fill, color picker, letter, crop, blur, sharpener, desaturation, clone, borders, sprites, keypoints, color zoom, change color, restore transparency, content fill. 

**Help**: keyboard shortcuts, translation.

## Embed
To embed this app on another page, use the following HTML code:

    <iframe style="box-sizing:border-box; width:100%; height:100vh;" id="miniPaint" src="https://viliusle.github.io/miniPaint/" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## Build instructions
See [Wiki > Build instructions](https://github.com/viliusle/miniPaint/wiki/Build-instructions)

## AI features (Runware)
This fork adds AI image generation through the [Runware](https://runware.ai) API. The browser never sees the API key: a small local proxy in `server/` adds it to each request.

**1. Provide the key** (one of):
- GitHub Codespaces: add a Codespaces secret named `RUNWARE_API_KEY` (GitHub > Settings > Codespaces > Secrets, allow this repository), then rebuild or restart the Codespace.
- Local: `cp server/.env.example server/.env` and set `RUNWARE_API_KEY=...` (the file is gitignored). An environment variable wins over the file.

**2. Run**
```
npm install
npm run start:ai        # proxy (port 8787) + dev server (port 8080) together
# or in two terminals:
npm run proxy
npx webpack serve --mode development --env development --no-open
```
Open http://localhost:8080 (in Codespaces, open the forwarded port 8080). The dev server forwards `/api/*` to the proxy.

**3. Use** the **AI** menu: *Runware Settings / Test Connection* checks the proxy and whether a key is present; *Generate...* takes a prompt, Fast/Quality, size (snapped to what the model accepts) and 1 to 4 results. Each result becomes a new layer named `AI: <prompt>`; one Ctrl+Z removes the whole batch. Every request asks Runware for its cost, and the toast shows the cost and a session total.

**Mock mode** (no key, no network): `npm run proxy:mock` or `npm run start:ai -- --mock` returns placeholder PNGs with cost 0. Add `RUNWARE_MOCK_DELAY_MS=3000` to test the loading and cancel (Escape) states.

**Debug**: *AI > Debug: Export Region + Mask* adds the crop and mask that an inpaint request would send as layers (and offers the PNGs); *AI > Debug: Place Test Result* inverts the region locally and places it back like an AI result. Both use the current rectangle selection, or the whole canvas.

**Tests**: `npm run test:ai` (size and region math, `node --test`).

Project plan: `plan.md`. Code map: `docs/ARCHITECTURE-NOTES.md`.

## Wiki
See [Wiki](https://github.com/viliusle/miniPaint/wiki)

## Contributors
<a align="center" href="https://github.com/viliusle/miniPaint/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=viliusle/miniPaint" />
</a>

## License
MIT License

## Support
Please use the GitHub issues for support, feature requests and bug reports, or contact us by sending an email to www.viliusl@gmail.com.
