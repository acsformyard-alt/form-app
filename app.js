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
  const canvas = document.getElementById("workCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let loadedImage = null;

  function clearPreview(container) {
    container.innerHTML = "";
  }

  function setPlaceholder(container, message) {
    container.innerHTML = `<p class="placeholder">${message}</p>`;
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

  function enableProcess() {
    processButton.disabled = false;
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
          "After processing, the cleaned image will appear here."
        );
        enableProcess();
      };
      img.onerror = () => {
        loadedImage = null;
        setPlaceholder(
          originalPreview,
          "We couldn't load that image. Please try another file."
        );
        disableControls();
      };
      img.src = event.target.result;
    };
    reader.onerror = () => {
      setPlaceholder(
        originalPreview,
        "There was a problem reading the file. Please try again."
      );
      disableControls();
    };
    reader.readAsDataURL(file);
  }

  function copyFromLeft(data, width, height, startX, regionHeight) {
    const maxY = Math.min(regionHeight, height);
    for (let y = 0; y < maxY; y += 1) {
      for (let x = startX; x < width; x += 1) {
        const offset = x - startX;
        const sampleX = Math.max(startX - offset - 1, 0);
        const destIndex = (y * width + x) * 4;
        const baseIndex = (y * width + sampleX) * 4;
        const belowY = Math.min(y + 2, height - 1);
        const belowIndex = (belowY * width + sampleX) * 4;

        data[destIndex] = Math.round(
          (data[baseIndex] * 2 + data[belowIndex]) / 3
        );
        data[destIndex + 1] = Math.round(
          (data[baseIndex + 1] * 2 + data[belowIndex + 1]) / 3
        );
        data[destIndex + 2] = Math.round(
          (data[baseIndex + 2] * 2 + data[belowIndex + 2]) / 3
        );
        data[destIndex + 3] = 255;
      }
    }
  }

  function featherBoundary(
    data,
    width,
    height,
    startX,
    regionHeight,
    featherSize
  ) {
    const endY = Math.min(regionHeight + featherSize, height);
    for (let y = regionHeight; y < endY; y += 1) {
      const blend = 1 - (y - regionHeight + 1) / (featherSize + 1);
      for (let x = startX; x < width; x += 1) {
        const currentIndex = (y * width + x) * 4;
        const sourceIndex = (y * width + Math.max(startX - 1, 0)) * 4;
        data[currentIndex] = Math.round(
          data[currentIndex] * (1 - blend) + data[sourceIndex] * blend
        );
        data[currentIndex + 1] = Math.round(
          data[currentIndex + 1] * (1 - blend) + data[sourceIndex + 1] * blend
        );
        data[currentIndex + 2] = Math.round(
          data[currentIndex + 2] * (1 - blend) + data[sourceIndex + 2] * blend
        );
      }
    }
  }

  function removeUpperRightText() {
    if (!loadedImage) return;

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
    const data = imageData.data;

    copyFromLeft(data, imgWidth, imgHeight, startX, regionHeight);
    featherBoundary(data, imgWidth, imgHeight, startX, regionHeight, 12);

    ctx.putImageData(imageData, 0, 0);

    const cleanedUrl = canvas.toDataURL("image/png");
    displayImage(resultPreview, cleanedUrl, "Image with upper-right text removed");

    downloadLink.href = cleanedUrl;
    downloadLink.classList.add("is-active");
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
    loadFromFile(file);
  });

  processButton.addEventListener("click", removeUpperRightText);
  widthSlider.addEventListener("input", () => {
    updateSliderLabels();
    if (loadedImage) {
      // Trigger a quick preview update when users tweak the sliders
      removeUpperRightText();
    }
  });
  heightSlider.addEventListener("input", () => {
    updateSliderLabels();
    if (loadedImage) {
      removeUpperRightText();
    }
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
})();
