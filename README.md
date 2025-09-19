# Image Stripper with AI Inpainting

This project removes upper-right watermarks or stickers from images by running a
local, browser-based LaMa inpainting model through `onnxruntime-web`.

## Getting started

1. Install the ONNX Runtime Web bundle into `libs/onnxruntime-web/`.
   - Follow the detailed instructions in `libs/onnxruntime-web/README.md` to
     copy `ort.min.js` and its WebAssembly binaries into the repository.
2. Download the LaMa ONNX weights and place them in `models/lama-inpaint-512.onnx`.
   - See `models/README.md` for vetted sources and checksum guidance.
3. Serve the project with any static file server, for example:
   ```bash
   npx serve .
   ```
4. Open the app in a modern browser. The UI will report the model status and
   automatically warm up the session before enabling the “Remove text” button.

All assets are loaded from the same origin—no external CDNs are required once
the files are in place.

## Development notes

- The `app.js` pipeline converts the masked region into model tensors, runs
  inference via `onnxruntime-web`, and composites the restored pixels on the
  main canvas.
- When sliders are adjusted, inference is re-run after the previous job
  completes to keep updates responsive without overwhelming the runtime.
- If the runtime or model is missing, the app surfaces guidance in the UI
  instead of failing silently.
