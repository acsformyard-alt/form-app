(function () {
  const input = document.getElementById("imageInput");
  const widthSlider = document.getElementById("widthSlider");
  const heightSlider = document.getElementById("heightSlider");
  const widthValue = document.getElementById("widthValue");
  const heightValue = document.getElementById("heightValue");
  const processButton = document.getElementById("processButton");
  const modelStatus = document.getElementById("modelStatus");
  const gallery = document.getElementById("gallery");
  const galleryStatus = document.getElementById("galleryStatus");
  const batchProgress = document.getElementById("batchProgress");
  const canvas = document.getElementById("workCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const defaultProcessLabel = processButton.textContent;

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

  let jobs = [];
  let jobCounter = 0;
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

  function setGalleryStatus(message) {
    if (galleryStatus) {
      galleryStatus.textContent = message;
    }
  }

  function setBatchProgress(message) {
    if (batchProgress) {
      batchProgress.textContent = message;
    }
  }

  function resetBatchProgress() {
    setBatchProgress("");
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

  function setInteractiveState(isInteractive) {
    input.disabled = !isInteractive;
    widthSlider.disabled = !isInteractive;
    heightSlider.disabled = !isInteractive;
  }

  function resetJobs() {
    jobs.forEach((job) => {
      if (job.image) {
        job.image.src = "";
      }
    });

    jobs = [];
    jobCounter = 0;

    if (gallery) {
      gallery.innerHTML = "";
    }

    resetBatchProgress();
    updateGalleryPreparationStatus();
    updateProcessButtonState();
  }

  function createDownloadName(filename) {
    if (!filename) {
      return "cleaned-image.png";
    }

    const lastDot = filename.lastIndexOf(".");
    const baseName = lastDot > 0 ? filename.slice(0, lastDot) : filename;
    const safeBase = baseName.trim() || "cleaned-image";

    return `${safeBase}-cleaned.png`;
  }

  function createJob(file) {
    const job = {
      id: `job-${Date.now()}-${jobCounter}`,
      file,
      status: "loading",
      needsProcessing: false,
      originalUrl: null,
      cleanedUrl: null,
      image: null,
      elements: null,
    };

    jobCounter += 1;
    return job;
  }

  function createJobCard(job) {
    if (!gallery) {
      return;
    }

    const card = document.createElement("article");
    card.className = "card preview-card";
    card.setAttribute("role", "listitem");

    const heading = document.createElement("h3");
    heading.textContent = job.file.name;

    const previewPair = document.createElement("div");
    previewPair.className = "preview-pair";

    const originalWrapper = document.createElement("div");
    originalWrapper.className = "preview";
    setPlaceholder(originalWrapper, "Loading original preview…");

    const resultWrapper = document.createElement("div");
    resultWrapper.className = "preview";
    setPlaceholder(
      resultWrapper,
      modelState.ready
        ? "After processing, the cleaned image will appear here."
        : "The AI model is still preparing. Processing will start once it's ready."
    );

    previewPair.append(originalWrapper, resultWrapper);

    const statusText = document.createElement("p");
    statusText.className = "preview-status";
    statusText.textContent = "Loading image…";

    const downloadLink = document.createElement("a");
    downloadLink.className = "download";
    downloadLink.download = createDownloadName(job.file.name);
    downloadLink.textContent = "Download cleaned image";
    downloadLink.classList.remove("is-active");
    downloadLink.removeAttribute("href");

    card.append(heading, previewPair, statusText, downloadLink);
    gallery.appendChild(card);

    job.elements = {
      card,
      originalWrapper,
      resultWrapper,
      statusText,
      downloadLink,
    };
  }

  function updateGalleryPreparationStatus() {
    if (!jobs.length) {
      setGalleryStatus(
        "Choose one or more images to begin removing the upper-right text."
      );
      return;
    }

    const readyCount = jobs.filter(
      (job) => job.image && job.status !== "error"
    ).length;

    if (readyCount === 0) {
      setGalleryStatus(
        `Preparing ${jobs.length} image${jobs.length === 1 ? "" : "s"} for cleanup…`
      );
    } else if (readyCount < jobs.length) {
      setGalleryStatus(
        `${readyCount} of ${jobs.length} image${jobs.length === 1 ? "" : "s"} ready for processing.`
      );
    } else {
      setGalleryStatus(
        `${jobs.length} image${jobs.length === 1 ? " is" : "s are"} ready. Use “Remove text” to run the cleanup.`
      );
    }
  }

  function loadJob(job) {
    const reader = new FileReader();

    reader.onload = (event) => {
      const dataUrl = event.target.result;
      job.originalUrl = dataUrl;

      if (job.elements) {
        displayImage(
          job.elements.originalWrapper,
          dataUrl,
          `Original preview for ${job.file.name}`
        );
      }

      const image = new Image();
      image.onload = () => {
        job.image = image;
        job.status = "ready";
        job.needsProcessing = true;
        if (job.elements) {
          job.elements.statusText.textContent =
            "Ready for processing. Use the Remove text button to begin.";
        }
        updateGalleryPreparationStatus();
        updateProcessButtonState();
      };
      image.onerror = () => {
        job.image = null;
        job.status = "error";
        job.needsProcessing = false;
        if (job.elements) {
          setPlaceholder(
            job.elements.originalWrapper,
            "We couldn't load that image. Please try another file."
          );
          job.elements.statusText.textContent =
            "We couldn't load that image. Please try another file.";
        }
        updateGalleryPreparationStatus();
        updateProcessButtonState();
      };
      image.src = dataUrl;
    };

    reader.onerror = () => {
      job.image = null;
      job.status = "error";
      job.needsProcessing = false;
      if (job.elements) {
        setPlaceholder(
          job.elements.originalWrapper,
          "There was a problem reading the file. Please try again."
        );
        job.elements.statusText.textContent =
          "There was a problem reading the file. Please try again.";
      }
      updateGalleryPreparationStatus();
      updateProcessButtonState();
    };

    reader.readAsDataURL(job.file);
  }

  function updateProcessButtonState() {
    const hasProcessableJob = jobs.some(
      (job) => job.image && job.needsProcessing
    );

    processButton.disabled =
      !modelState.ready || !hasProcessableJob || isProcessing;
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

  function getProcessableJobs() {
    return jobs.filter((job) => job.image && job.needsProcessing);
  }

  async function runInpainting(job) {
    const widthPercent = Number(widthSlider.value) / 100;
    const heightPercent = Number(heightSlider.value) / 100;

    const imgWidth = job.image.naturalWidth || job.image.width;
    const imgHeight = job.image.naturalHeight || job.image.height;
    const regionWidth = Math.round(imgWidth * widthPercent);
    const regionHeight = Math.round(imgHeight * heightPercent);

    canvas.width = imgWidth;
    canvas.height = imgHeight;
    ctx.drawImage(job.image, 0, 0);

    const startX = Math.max(imgWidth - regionWidth, 0);
    const imageData = ctx.getImageData(0, 0, imgWidth, imgHeight);

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

    return canvas.toDataURL("image/png");
  }

  async function processJobs() {
    const jobsToProcess = getProcessableJobs();
    if (!jobsToProcess.length) {
      return;
    }

    if (!modelState.ready) {
      await ensureModelReady();
    }

    if (!modelState.ready) {
      setBatchProgress(
        "The AI model is not ready. Check the setup instructions to continue."
      );
      jobsToProcess.forEach((job) => {
        if (job.elements) {
          job.elements.statusText.textContent =
            "The AI model is not ready. Check the setup instructions to continue.";
        }
      });
      updateProcessButtonState();
      return;
    }

    isProcessing = true;
    setInteractiveState(false);
    processButton.textContent = "Processing…";
    updateProcessButtonState();

    try {
      setBatchProgress(
        `Processing ${jobsToProcess.length} image${
          jobsToProcess.length === 1 ? "" : "s"
        }…`
      );
      setGalleryStatus(
        `Running AI cleanup for ${jobsToProcess.length} image${
          jobsToProcess.length === 1 ? "" : "s"
        }…`
      );

      for (let index = 0; index < jobsToProcess.length; index += 1) {
        const job = jobsToProcess[index];
        job.status = "processing";
        setBatchProgress(
          `Processing image ${index + 1} of ${jobsToProcess.length}…`
        );

        if (job.elements) {
          setPlaceholder(
            job.elements.resultWrapper,
            "Running the inpainting model…"
          );
          job.elements.downloadLink.classList.remove("is-active");
          job.elements.downloadLink.removeAttribute("href");
          job.elements.statusText.textContent = "Running the inpainting model…";
        }

        try {
          const cleanedUrl = await runInpainting(job);
          job.cleanedUrl = cleanedUrl;
          job.needsProcessing = pendingAutoUpdate;
          job.status = "complete";

          if (job.elements) {
            displayImage(
              job.elements.resultWrapper,
              cleanedUrl,
              `Image ${job.file.name} with upper-right text removed`
            );
            job.elements.downloadLink.href = cleanedUrl;
            job.elements.downloadLink.classList.add("is-active");
            job.elements.statusText.textContent = "Cleanup complete.";
          }
        } catch (error) {
          console.error("Inpainting failed", error);
          job.needsProcessing = pendingAutoUpdate;
          job.status = "error";

          if (job.elements) {
            setPlaceholder(
              job.elements.resultWrapper,
              "We couldn't run the AI cleanup. Confirm the model assets are installed."
            );
            job.elements.statusText.textContent =
              "We couldn't run the AI cleanup. Confirm the model assets are installed.";
          }
        }
      }

      setBatchProgress("Processing complete.");
      setGalleryStatus(
        "Batch processing finished. Adjust the sliders or add more images to continue."
      );
    } finally {
      isProcessing = false;
      setInteractiveState(true);
      processButton.textContent = defaultProcessLabel;
      updateProcessButtonState();

      if (pendingAutoUpdate) {
        pendingAutoUpdate = false;
        processJobs();
      }
    }
  }

  input.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);

    resetJobs();

    if (!files.length) {
      updateGalleryPreparationStatus();
      return;
    }

    setGalleryStatus(
      `Preparing ${files.length} image${files.length === 1 ? "" : "s"} for cleanup…`
    );

    files.forEach((file) => {
      const job = createJob(file);
      jobs.push(job);
      createJobCard(job);
      loadJob(job);
    });

    updateProcessButtonState();
  });

  processButton.addEventListener("click", () => {
    processJobs();
  });

  function handleSliderChange() {
    updateSliderLabels();

    const hasEligibleJobs = jobs.some((job) => job.image);
    if (!hasEligibleJobs) {
      return;
    }

    jobs.forEach((job) => {
      if (job.image) {
        job.needsProcessing = true;
      }
    });

    updateProcessButtonState();
    setGalleryStatus(
      "Removal area updated. The batch will be processed with the new settings."
    );

    if (isProcessing) {
      pendingAutoUpdate = true;
      setBatchProgress(
        "Settings updated. Reprocessing will begin after the current batch."
      );
      return;
    }

    processJobs();
  }

  widthSlider.addEventListener("input", handleSliderChange);
  heightSlider.addEventListener("input", handleSliderChange);

  updateSliderLabels();
  updateGalleryPreparationStatus();
  ensureModelReady();
})();
