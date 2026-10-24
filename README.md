# Eye Photo Sorter

A web app that sorts a folder of photos into receipts, screenshots, documents, people, pets, blurry shots, closed eyes, duplicates and best shots, entirely in your browser. Drop a folder on the page and watch it work, with live speed numbers. No photo is uploaded.

It's built on [**Eye**](https://desertant.com/models/eye/), the on-device image classification model from [Desert Ant Labs](https://desertant.com/), running on Google's [LiteRT.js](https://ai.google.dev/edge/litert/web).

## What it does

- **Input**: drag and drop a folder (subfolders included), or use the Choose folder / Choose files buttons.
- **Model**: `@desert-ant-labs/eye` 4.1 on `@litertjs/core` 2.6. It runs on the GPU through **WebGPU** where the browser has it and falls back to **WebAssembly** otherwise. The model starts downloading when the page opens and is warmed up before your first photo.
- **Categories**:

  | Category | Rule |
  |---|---|
  | Receipts | Photo type is `receipt` |
  | Screenshots | Photo type is `screenshot` |
  | Documents | `document`, `whiteboard` or `id_card` |
  | People | Faces detected or the `people` tag (camera photos only) |
  | Pets | Pets detected or the `pet` tag |
  | Blurry | `blurry` tag |
  | Eyes closed | `eyes_closed` confidence ≥ 0.75 |
  | Duplicates | `Eye.duplicates()` on camera photos |
  | Best shots | Highest aesthetic scores, excluding blurry, eyes-closed and extra duplicates |
  | Safe to delete | Blurry photos plus every burst frame except the best one |

- **Detail panel**: click any photo to see its type, latency, face count, aesthetic and keeper scores and its top tags.
- **Speed metrics**: photos done, elapsed time, photos per second, time per photo, a live photos-per-second chart, a pipeline chart with one row per photo in flight, and a summary with a projection for 10,000 photos.

Eye only knows *what kind* of photo something is: it tags receipts but doesn't read them (no OCR).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

Use a recent Chrome or Edge for WebGPU. URL options:

- `?lanes=N` — how many photos are analysed at once (default 6; `?lanes=1` for one at a time)
- `?backend=wasm` or `?backend=webgpu` — force a backend

To try it, drop the included `sample-photos/` folder on the page.

## Performance

Measured on an Apple Silicon Mac in Chrome with WebGPU, running all four analysis parts (photo, layout, faces, sharpness) on every photo:

| Setup | Result |
|---|---|
| One full analysis, 1024 px input | ~140–290 ms |
| 1 photo at a time (`?lanes=1`) | ~3 photos/s |
| 6 photos at a time (default) | ~6.5–8 photos/s |
| 105-photo sample set | ~13–16 s |

What makes it fast:

- **Smaller input**: photos are scaled to 1024 px on the long side before analysis.
- **Parallel lanes**: several photos in flight keep the GPU busy (~2.5× faster than one at a time).
- **Cross-origin isolation**: COOP/COEP headers let LiteRT.js use threaded WebAssembly when it falls back to the CPU.

Desert Ant Labs quotes 41 ms per photo with WebGPU in Chrome on an M6 Mac for a single analysis; this app runs the full analysis on every photo, so its numbers are higher.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout: drop zone, counters, charts, fact strip, category buttons, detail panel |
| `src/main.js` | Model loading, file intake, parallel pipeline, categories, charts, summary |
| `src/style.css` | Dark theme |
| `vite.config.js` | Keeps the Eye SDK out of Vite's pre-bundling and adds the COOP/COEP headers |
| `scripts/copy-litert.js` | Copies LiteRT.js's WebAssembly runtime into `public/litert/` on dev and build |
| `sample-photos/` | 105 freely licensed demo photos, including deliberate blurry shots and burst sequences |
| `sample-photos-CREDITS.md` | Source, author and license for every sample photo |

## Sample photo credits

The sample photos come from Wikimedia Commons and StockSnap: 91 are CC0, 8 are public domain and 6 are CC BY. Burst frames and blurred shots were derived locally from the listed originals. Full credits are in [`sample-photos-CREDITS.md`](sample-photos-CREDITS.md). The CC BY photos:

- `coffee-kitchen.jpg` — Shixart1985, CC BY 2.0
- `receipt-pay-the-bill.jpg` — Benreis, CC BY 3.0
- `receipt-restaurant-02.jpg` — Chainwit., CC BY 4.0
- `doc-telegram-form.jpg` — EnglishEnigma1, CC BY 4.0
- `doc-field-notebook.jpg` — Sherwin Carlquist, CC BY 4.0
- `screenshot-gnome-desktop.png` — The GNOME Project and Nyarch Linux developers, CC BY 4.0

## License

The app code in this repository is provided as a demo. **Eye** and the Desert Ant SDK are under the [Desert Ant Labs Source-Available License](https://license.desertant.com/) (not open source): free below 100,000 monthly active devices per platform, with unlimited inference, and it asks you to credit Desert Ant Labs in your app. The SDK sends usage telemetry to Desert Ant's license server; photos never leave your machine.
