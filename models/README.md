# LaMa ONNX Weights

The application expects the LaMa inpainting model weights to be available as
`models/lama-inpaint-512.onnx`. The ONNX export is open-source and can be
obtained from the [LaMa project](https://github.com/saic-mdal/lama) or the
[Sanster/lama-cleaner](https://github.com/Sanster/lama-cleaner) distribution.

## Download instructions

1. Download the `lama-inpaint-512.onnx` (or an equivalent LaMa export) from a
   trusted source such as the official GitHub release or the
   [`big-lama` weights on Hugging Face](https://huggingface.co/Sanster/lama-cleaner/tree/main/models/big-lama/512).
2. Place the ONNX file in this directory and rename it to
   `lama-inpaint-512.onnx` if necessary.
3. (Optional) Verify integrity with a checksum, for example:
   ```bash
   shasum -a 256 lama-inpaint-512.onnx
   ```

The initialization code fetches the model via `fetch()` from the same origin. If
this file is missing, the UI will surface guidance instead of attempting to
reach external services.
