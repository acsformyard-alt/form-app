# Image Stripper with AI Inpainting

This repository hosts a static web application that removes upper-right watermarks
or stickers from images using a local LaMa inpainting model executed entirely in
the browser through `onnxruntime-web`.

## Prerequisites

- A static file server. Any option that can serve the contents of this folder
  works. Examples in this guide use `npx serve`, but you can substitute another
  static server (such as `python3 -m http.server`).
- A modern desktop browser with WebAssembly and WebGL support. Chrome/Edge 102+,
  Firefox 113+, and Safari 16.4+ have been tested with ONNX Runtime Web. Mobile
  browsers may work but are not officially supported.
- Local copies of the ONNX Runtime Web bundle and the LaMa ONNX weights as
  described below. The application only fetches assets from the same origin, so
  these files must exist before launching the UI.

## Required assets

### ONNX Runtime Web (`libs/onnxruntime-web/`)

Download the official `onnxruntime-web` release that you plan to use and place
the following files in the repository:

```
libs/
└── onnxruntime-web/
    ├── ort.min.js
    └── wasm/
        ├── ort-wasm.wasm
        ├── ort-wasm-simd.wasm
        ├── ort-wasm-threaded.wasm
        └── ort-wasm-simd-threaded.wasm
```

Steps to obtain the files:

1. Visit the [ONNX Runtime releases](https://github.com/microsoft/onnxruntime/releases)
   page and download the `ort-wasm` archive for your chosen version (for
   example, `ort-wasm-web-1.17.1.tgz`).
2. Extract the archive locally.
3. Copy `ort.min.js` into `libs/onnxruntime-web/`.
4. Copy the WebAssembly binaries from the archive into
   `libs/onnxruntime-web/wasm/`.

The placeholder files committed to this repository only log a warning so that
missing assets are obvious in development; they must be replaced with the real
runtime before the app can run inference.

### LaMa model weights (`models/lama-inpaint-512.onnx`)

The LaMa ONNX export is not bundled. Download the weights from a trusted source
(such as the [official LaMa project](https://github.com/saic-mdal/lama) or the
[Sanster/lama-cleaner release](https://huggingface.co/Sanster/lama-cleaner/tree/main/models/big-lama/512))
and place them at:

```
models/lama-inpaint-512.onnx
```

Rename the file if necessary so the path matches exactly. The application will
fail to initialize if this file is missing.

## Running the app locally

Once the runtime bundle and model weights are in place, serve the repository as a
static site.

```bash
# From the repository root
npx serve .
```

`serve` defaults to http://localhost:3000. If you prefer Python, run:

```bash
python3 -m http.server 8000
```

Then open the reported URL in your browser. Avoid loading the page directly from
`file://` because the browser will block the model fetch and the WebAssembly
assets.

## Using the UI

1. Wait for the status banner at the top of the page to report that the runtime
   and model are ready. The app automatically warms up the model on first load.
2. Upload one or more images. Each image appears with a before/after preview.
3. Adjust the removal width and height sliders to match the overlay you want to
   erase. Processing starts when you press **Remove text**.
4. Download the cleaned images using the link in each card.

If ONNX Runtime Web or the LaMa weights are missing, the status banner will show
an error explaining which asset to install.

## Troubleshooting and additional notes

- Threaded execution in ONNX Runtime Web requires cross-origin isolation. When
  served without the necessary headers the runtime automatically falls back to a
  single-threaded WebAssembly path, which is slower but still functional.
- Keep the ONNX Runtime bundle and its WebAssembly binaries from the same
  release to avoid version mismatches.
- The repository includes detailed setup notes in
  `libs/onnxruntime-web/README.md` and `models/README.md` if you need to revisit
  the asset preparation steps.
