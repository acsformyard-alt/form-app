# ONNX Runtime Web Assets

This folder must contain the official production build of
[`onnxruntime-web`](https://github.com/microsoft/onnxruntime) so the app can run
LaMa inpainting entirely in the browser. Replace the placeholder `ort.min.js`
with the upstream bundle and copy the accompanying WebAssembly binaries into the
`wasm/` subfolder.

## Required files

Download the matching versions of the following files and place them next to
this README:

- `ort.min.js`
- `wasm/ort-wasm.wasm`
- `wasm/ort-wasm-simd.wasm`
- `wasm/ort-wasm-threaded.wasm`
- `wasm/ort-wasm-simd-threaded.wasm`

The placeholder script that ships with the repository only logs a warning so
that missing assets are easy to spot during development. The application code
checks for the runtime and surfaces a friendly error message until the genuine
files are present.

## Suggested download approach

1. Visit the [ONNX Runtime release page](https://github.com/microsoft/onnxruntime/releases)
   that matches the version you intend to use.
2. Download the `ort-wasm` archive for that release (for example,
   `ort-wasm-web-1.17.1.tgz`).
3. Extract the archive locally and copy the files listed above into this
   directory.
4. Optionally verify file integrity with `shasum -a 256 <filename>` before
   serving the app.

All assets are loaded from the same origin as the application so no external CDNs
are involved at runtime.
