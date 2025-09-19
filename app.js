(function () {
  const input = document.getElementById("imageInput");
  const widthSlider = document.getElementById("widthSlider");
  const heightSlider = document.getElementById("heightSlider");
  const widthValue = document.getElementById("widthValue");
  const heightValue = document.getElementById("heightValue");
  const processButton = document.getElementById("processButton");
  const originalPreview = document.getElementById("originalPreview");
  const resultPreview = document.getElementById("resultPreview");
  const downloadLink = document.getElementById("downloadLink");
  const modelStatus = document.getElementById("modelStatus");
  const canvas = document.getElementById("workCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const MODEL_PATH = "models/lama-inpaint-512.onnx";
  const ORT_BASE_PATH = "libs/onnxruntime-web";
  const WARMUP_SIZE = { width: 512, height: 512 };

  const modelState = {
    session: null,
    imageInputName: null,
    maskInputName: null,
    outputName: null,
    ready: false,
    error: null,
  };

  let loadedImage = null;
  let isProcessing = false;
  let pendingAutoUpdate = false;
  let modelLoadingPromise = null;

  function clearPreview(container) {
    container.innerHTML = "";
  }

  function setPlaceholder(container, message) {
    container.innerHTML = `<p class="placeholder">${message}</p>`;
  }

  function setModelStatus(message, state) {
    if (!modelStatus) {
      return;
    }

    modelStatus.textContent = message;
    modelStatus.setAttribute("data-state", state);
    modelStatus.classList.remove(
      "status--loading",
      "status--ready",
      "status--error"
    );

    if (state === "loading") {
      modelStatus.classList.add("status--loading");
    } else if (state === "ready") {
      modelStatus.classList.add("status--ready");
    } else if (state === "error") {
      modelStatus.classList.add("status--error");
    }
  }

  function updateSliderLabels() {
    widthValue.textContent = widthSlider.value;
    heightValue.textContent = heightSlider.value;
  }

  function displayImage(container, src, alt) {
    clearPreview(container);
    const img = document.createElement("img");
    img.src = src;
    img.alt = alt;
    container.appendChild(img);
  }

  function disableControls() {
    processButton.disabled = true;
    downloadLink.classList.remove("is-active");
    downloadLink.removeAttribute("href");
  }

  function updateProcessButtonState() {
    const canProcess = Boolean(loadedImage) && modelState.ready && !isProcessing;
    processButton.disabled = !canProcess;
  }

  function loadFromFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        loadedImage = img;
        displayImage(
          originalPreview,
          img.src,
          "Uploaded image preview ready for processing"
        );
        setPlaceholder(
          resultPreview,
          modelState.ready
            ? "After processing, the cleaned image will appear here."
            : "The AI model is still preparing. Processing will start once it's ready."
        );
        updateProcessButtonState();
      };
      img.onerror = () => {
        loadedImage = null;
        setPlaceholder(
          originalPreview,
          "We couldn't load that image. Please try another file."
        );
        disableControls();
        updateProcessButtonState();
      };
      img.src = event.target.result;
    };
    reader.onerror = () => {
      setPlaceholder(
        originalPreview,
        "There was a problem reading the file. Please try again."
      );
      disableControls();
      updateProcessButtonState();
    };
    reader.readAsDataURL(file);
  }

  function normalizePixel(value) {
    return (value / 255) * 2 - 1;
  }

  function denormalizePixel(value) {
    const scaled = Math.round(((value + 1) / 2) * 255);
    return Math.min(255, Math.max(0, scaled));
  }

  function prepareInpaintingInputs(
    imageData,
    width,
    height,
    startX,
    regionHeight
  ) {
    const pixelCount = width * height;
    const channelSize = pixelCount;
    const imageTensorData = new Float32Array(channelSize * 3);
    const maskTensorData = new Float32Array(pixelCount);
    const maskBinary = new Uint8Array(pixelCount);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const dataIndex = pixelIndex * 4;
        const masked = x >= startX && y < regionHeight;

        imageTensorData[pixelIndex] = normalizePixel(imageData.data[dataIndex]);
        imageTensorData[channelSize + pixelIndex] = normalizePixel(
          imageData.data[dataIndex + 1]
        );
        imageTensorData[channelSize * 2 + pixelIndex] = normalizePixel(
          imageData.data[dataIndex + 2]
        );

        if (masked) {
          maskTensorData[pixelIndex] = 1;
          maskBinary[pixelIndex] = 1;
        }
      }
    }

    return { imageTensorData, maskTensorData, maskBinary };
  }

  function compositeInpaintedPixels(
    originalData,
    outputTensor,
    maskBinary,
    width,
    height
  ) {
    const updatedData = new Uint8ClampedArray(originalData);
    const channelSize = width * height;

    for (let i = 0; i < channelSize; i += 1) {
      if (!maskBinary[i]) {
        continue;
      }

      const red = denormalizePixel(outputTensor[i]);
      const green = denormalizePixel(outputTensor[channelSize + i]);
      const blue = denormalizePixel(outputTensor[channelSize * 2 + i]);
      const baseIndex = i * 4;

      updatedData[baseIndex] = red;
      updatedData[baseIndex + 1] = green;
      updatedData[baseIndex + 2] = blue;
      updatedData[baseIndex + 3] = 255;
    }

    return updatedData;
  }

  async function ensureModelReady() {
    if (modelState.ready || modelState.error) {
      return;
    }

    if (modelLoadingPromise) {
      await modelLoadingPromise;
      return;
    }

    if (!window.ort || !window.ort.InferenceSession) {
      modelState.error = new Error(
        "onnxruntime-web is not available. Follow the asset setup guide."
      );
      setModelStatus(
        "ONNX Runtime Web is missing. Install the local runtime assets to enable AI cleanup.",
        "error"
      );
      updateProcessButtonState();
      return;
    }

    modelLoadingPromise = (async () => {
      try {
        setModelStatus("Loading inpainting runtime…", "loading");

        ort.env.wasm.wasmPaths = `${ORT_BASE_PATH}/wasm`;
        if (typeof navigator.hardwareConcurrency === "number") {
          ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency);
        }

        const response = await fetch(MODEL_PATH);
        if (!response.ok) {
          throw new Error(
            "The LaMa ONNX weights were not found. Place them in the models directory."
          );
        }

        const modelBuffer = await response.arrayBuffer();
        const sessionOptions = {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        };
        const session = await ort.InferenceSession.create(
          new Uint8Array(modelBuffer),
          sessionOptions
        );

        const [imageInputName, maskInputName] = session.inputNames;
        if (!imageInputName || !maskInputName) {
          throw new Error(
            "Unexpected model signature. Expected image and mask inputs."
          );
        }

        const [outputName] = session.outputNames;
        if (!outputName) {
          throw new Error(
            "Unexpected model signature. Expected one output tensor."
          );
        }

        modelState.session = session;
        modelState.imageInputName = imageInputName;
        modelState.maskInputName = maskInputName;
        modelState.outputName = outputName;

        const warmupImage = new ort.Tensor(
          "float32",
          new Float32Array(WARMUP_SIZE.width * WARMUP_SIZE.height * 3),
          [1, 3, WARMUP_SIZE.height, WARMUP_SIZE.width]
        );
        const warmupMask = new ort.Tensor(
          "float32",
          new Float32Array(WARMUP_SIZE.width * WARMUP_SIZE.height),
          [1, 1, WARMUP_SIZE.height, WARMUP_SIZE.width]
        );

        await session.run({
          [imageInputName]: warmupImage,
          [maskInputName]: warmupMask,
        });

        modelState.ready = true;
        modelState.error = null;
        setModelStatus("Inpainting model ready.", "ready");
      } catch (error) {
        console.error("Failed to initialize the inpainting model", error);
        modelState.error = error;
        setModelStatus(
          "Inpainting model unavailable. Follow the setup guide to install the weights.",
          "error"
        );
      } finally {
        modelLoadingPromise = null;
        updateProcessButtonState();
      }
    })();

    await modelLoadingPromise;
  }

  async function removeUpperRightText() {
    if (!loadedImage) {
      pendingAutoUpdate = false;
      return;
    }

    if (isProcessing) {
      pendingAutoUpdate = true;
      return;
    }

    if (!modelState.ready) {
      await ensureModelReady();
      if (!modelState.ready) {
        pendingAutoUpdate = false;
        setPlaceholder(
          resultPreview,
          "The AI model is not ready. Check the setup instructions to continue."
        );
        return;
      }
    }

    isProcessing = true;
    updateProcessButtonState();
    setPlaceholder(resultPreview, "Running the inpainting model…");
    downloadLink.classList.remove("is-active");
    downloadLink.removeAttribute("href");

    const widthPercent = Number(widthSlider.value) / 100;
    const heightPercent = Number(heightSlider.value) / 100;

    const imgWidth = loadedImage.naturalWidth || loadedImage.width;
    const imgHeight = loadedImage.naturalHeight || loadedImage.height;
    const regionWidth = Math.round(imgWidth * widthPercent);
    const regionHeight = Math.round(imgHeight * heightPercent);

    canvas.width = imgWidth;
    canvas.height = imgHeight;
    ctx.drawImage(loadedImage, 0, 0);

    const startX = Math.max(imgWidth - regionWidth, 0);
    const imageData = ctx.getImageData(0, 0, imgWidth, imgHeight);

    try {
      const { imageTensorData, maskTensorData, maskBinary } = prepareInpaintingInputs(
        imageData,
        imgWidth,
        imgHeight,
        startX,
        regionHeight
      );

      const feeds = {
        [modelState.imageInputName]: new ort.Tensor(
          "float32",
          imageTensorData,
          [1, 3, imgHeight, imgWidth]
        ),
        [modelState.maskInputName]: new ort.Tensor(
          "float32",
          maskTensorData,
          [1, 1, imgHeight, imgWidth]
        ),
      };

      const output = await modelState.session.run(feeds);
      const outputTensor = output[modelState.outputName];

      if (!outputTensor) {
        throw new Error("Model inference returned an empty result.");
      }

      if (
        outputTensor.dims[2] !== imgHeight ||
        outputTensor.dims[3] !== imgWidth
      ) {
        throw new Error(
          `Model output size mismatch. Expected ${imgWidth}x${imgHeight}, got ${outputTensor.dims[3]}x${outputTensor.dims[2]}.`
        );
      }

      const updatedPixels = compositeInpaintedPixels(
        imageData.data,
        outputTensor.data,
        maskBinary,
        imgWidth,
        imgHeight
      );

      const updatedImageData = new ImageData(updatedPixels, imgWidth, imgHeight);
      ctx.putImageData(updatedImageData, 0, 0);

      const cleanedUrl = canvas.toDataURL("image/png");
      displayImage(resultPreview, cleanedUrl, "Image with upper-right text removed");
      downloadLink.href = cleanedUrl;
      downloadLink.classList.add("is-active");
    } catch (error) {
      console.error("Inpainting failed", error);
      setPlaceholder(
        resultPreview,
        "We couldn't run the AI cleanup. Confirm the model assets are installed."
      );
    } finally {
      isProcessing = false;
      updateProcessButtonState();

      if (pendingAutoUpdate) {
        pendingAutoUpdate = false;
        removeUpperRightText();
      }
    }
  }

  input.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      loadedImage = null;
      setPlaceholder(
        originalPreview,
        "Choose an image to begin removing the upper-right text."
      );
      disableControls();
      return;
    }

    disableControls();
    updateProcessButtonState();
    loadFromFile(file);
  });

  processButton.addEventListener("click", () => {
    removeUpperRightText();
  });
  widthSlider.addEventListener("input", () => {
    updateSliderLabels();
    pendingAutoUpdate = true;
    removeUpperRightText();
  });
  heightSlider.addEventListener("input", () => {
    updateSliderLabels();
    pendingAutoUpdate = true;
    removeUpperRightText();
  });

  updateSliderLabels();
  setPlaceholder(
    originalPreview,
    "Choose an image to begin removing the upper-right text."
  );
  setPlaceholder(
    resultPreview,
    "After processing, the cleaned image will appear here."
  );
  ensureModelReady();
})();
