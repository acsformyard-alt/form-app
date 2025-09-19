# WebAssembly binaries

Place the WebAssembly files that ship with the `onnxruntime-web` distribution
in this folder. The application sets `ort.env.wasm.wasmPaths` to this directory
so that the runtime can resolve the binaries without reaching out to external
networks.

Required files:

- `ort-wasm.wasm`
- `ort-wasm-simd.wasm`
- `ort-wasm-threaded.wasm`
- `ort-wasm-simd-threaded.wasm`

These files are versioned alongside `ort.min.js`. Always copy the binaries from
the same release to avoid mismatches.
