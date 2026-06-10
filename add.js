const ADMIN_TOKEN_STORAGE_KEY = "vinilos-admin-token";
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const ZXING_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E"];

const APP_BASE_PATH = resolveAppBasePath();

const steps = {
  scan: document.getElementById("step-scan"),
  candidates: document.getElementById("step-candidates"),
  confirm: document.getElementById("step-confirm"),
  done: document.getElementById("step-done"),
};

const scannerShell = document.getElementById("scanner-shell");
const video = document.getElementById("scanner-video");
const scanStatus = document.getElementById("scan-status");
const scanError = document.getElementById("scan-error");
const startScanButton = document.getElementById("start-scan");
const stopScanButton = document.getElementById("stop-scan");
const manualForm = document.getElementById("manual-form");
const manualInput = document.getElementById("manual-input");
const candidatesHeading = document.getElementById("candidates-heading");
const candidateList = document.getElementById("candidate-list");
const confirmCard = document.getElementById("confirm-card");
const confirmError = document.getElementById("confirm-error");
const confirmAddButton = document.getElementById("confirm-add");
const adminTokenRow = document.getElementById("admin-token-row");
const adminTokenInput = document.getElementById("admin-token-input");

document.getElementById("back-link").href = APP_BASE_PATH || "/";

let mediaStream = null;
let scanLoopActive = false;
let lastBarcode = "";
let selectedRelease = null;

startScanButton.addEventListener("click", startScanner);
stopScanButton.addEventListener("click", stopScanner);
manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = manualInput.value.trim();
  if (query) search(query);
});
document.getElementById("candidates-back").addEventListener("click", () => showStep("scan"));
document.getElementById("confirm-back").addEventListener("click", () => showStep("candidates"));
confirmAddButton.addEventListener("click", addSelectedRelease);
document.getElementById("scan-another").addEventListener("click", () => {
  lastBarcode = "";
  selectedRelease = null;
  showStep("scan");
});

function showStep(name) {
  for (const [key, element] of Object.entries(steps)) {
    element.classList.toggle("active", key === name);
  }
  if (name !== "scan") stopScanner();
}

// --- Paso 1: cámara y detección -------------------------------------------

async function startScanner() {
  scanError.textContent = "";
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch {
    scanError.textContent =
      "No pude acceder a la cámara. Dale permiso al navegador o escribí el código a mano.";
    return;
  }

  video.srcObject = mediaStream;
  await video.play();
  scannerShell.hidden = false;
  startScanButton.hidden = true;
  stopScanButton.hidden = false;
  scanStatus.textContent = "Apuntá al código de barras";

  let detectFrame;
  try {
    detectFrame = await createDetector();
  } catch {
    scanError.textContent = "No pude cargar el lector de códigos. Escribí el código a mano.";
    stopScanner();
    return;
  }

  scanLoopActive = true;
  while (scanLoopActive) {
    try {
      const barcode = await detectFrame(video);
      if (barcode && /^\d{8,14}$/.test(barcode)) {
        navigator.vibrate?.(80);
        stopScanner();
        search(barcode);
        return;
      }
    } catch {
      // Frame failed to decode; keep trying.
    }
    await sleep(220);
  }
}

function stopScanner() {
  scanLoopActive = false;
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  video.srcObject = null;
  scannerShell.hidden = true;
  startScanButton.hidden = false;
  stopScanButton.hidden = true;
}

// Prefers the native BarcodeDetector (Chrome/Android); falls back to
// zxing-wasm from CDN for iOS Safari and desktop browsers.
async function createDetector() {
  if ("BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = BARCODE_FORMATS.filter((format) => supported.includes(format));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return async (videoElement) => {
          const codes = await detector.detect(videoElement);
          return codes[0]?.rawValue || null;
        };
      }
    } catch {
      // Fall through to zxing-wasm.
    }
  }

  const { readBarcodes } = await import(
    "https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/reader/index.js"
  );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return async (videoElement) => {
    if (!videoElement.videoWidth) return null;
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    context.drawImage(videoElement, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const results = await readBarcodes(imageData, { formats: ZXING_FORMATS, tryHarder: true });
    return results[0]?.text || null;
  };
}

// --- Paso 2: candidatos ----------------------------------------------------

async function search(query) {
  scanError.textContent = "";
  const isBarcode = /^\d{8,14}$/.test(query.replace(/\s/g, ""));
  lastBarcode = isBarcode ? query.replace(/\s/g, "") : "";

  candidatesHeading.textContent = isBarcode
    ? `Buscando código ${query}...`
    : `Buscando "${query}"...`;
  candidateList.innerHTML = '<div class="spinner"></div>';
  showStep("candidates");

  let data;
  try {
    const param = isBarcode ? `barcode=${encodeURIComponent(lastBarcode)}` : `q=${encodeURIComponent(query)}`;
    data = await fetchJson(apiUrl(`/api/lookup?${param}`));
  } catch (error) {
    candidatesHeading.textContent = "La búsqueda falló.";
    candidateList.innerHTML = "";
    renderRetry(error.message);
    return;
  }

  const candidates = data.candidates || [];
  if (!candidates.length) {
    candidatesHeading.textContent = isBarcode
      ? `Discogs no tiene resultados para el código ${query}. Probá buscar por artista y título.`
      : `Sin resultados para "${query}".`;
    candidateList.innerHTML = "";
    return;
  }

  candidatesHeading.textContent = `${candidates.length} resultado${candidates.length === 1 ? "" : "s"} en Discogs — elegí tu edición:`;
  candidateList.innerHTML = "";
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.className = "candidate";
    button.type = "button";

    const img = document.createElement("img");
    img.src = candidate.thumb || candidate.coverImage || "";
    img.alt = "";
    img.loading = "lazy";

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = candidate.title;
    const details = document.createElement("span");
    details.textContent = [
      candidate.year,
      candidate.country,
      candidate.label,
      candidate.catalogNumber,
      (candidate.formats || []).join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
    meta.append(title, details);

    button.append(img, meta);
    button.addEventListener("click", () => loadRelease(candidate.releaseId));
    candidateList.appendChild(button);
  }
}

function renderRetry(message) {
  const error = document.createElement("p");
  error.className = "error";
  error.textContent = message;
  candidateList.appendChild(error);
}

// --- Paso 3: confirmación --------------------------------------------------

async function loadRelease(releaseId) {
  confirmError.textContent = "";
  confirmCard.innerHTML = '<div class="spinner"></div>';
  adminTokenRow.hidden = Boolean(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY));
  showStep("confirm");

  try {
    const data = await fetchJson(apiUrl(`/api/lookup?release=${encodeURIComponent(releaseId)}`));
    selectedRelease = data.release;
  } catch (error) {
    confirmCard.innerHTML = "";
    confirmError.textContent = `No pude cargar el detalle: ${error.message}`;
    return;
  }

  renderConfirmCard(selectedRelease);
}

function renderConfirmCard(release) {
  confirmCard.innerHTML = "";

  if (release.coverImage) {
    const img = document.createElement("img");
    img.src = release.coverImage;
    img.alt = `Tapa de ${release.title}`;
    confirmCard.appendChild(img);
  }

  const title = document.createElement("h2");
  title.textContent = `${release.artist} — ${release.title}`;

  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = [
    release.year,
    release.country,
    release.label,
    release.catalogNumber,
    (release.genres || []).join(" / "),
  ]
    .filter(Boolean)
    .join(" · ");

  confirmCard.append(title, sub);

  if (release.tracklist?.length) {
    const tracklist = document.createElement("ol");
    tracklist.className = "tracklist-preview";
    for (const track of release.tracklist) {
      const item = document.createElement("li");
      item.textContent = track.duration ? `${track.title} (${track.duration})` : track.title;
      tracklist.appendChild(item);
    }
    confirmCard.appendChild(tracklist);
  }
}

async function addSelectedRelease() {
  if (!selectedRelease) return;
  confirmError.textContent = "";

  const storedToken = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";
  const adminToken = storedToken || adminTokenInput.value.trim();
  if (!adminToken) {
    adminTokenRow.hidden = false;
    confirmError.textContent = "Pegá el token de admin para poder agregar discos.";
    adminTokenInput.focus();
    return;
  }

  confirmAddButton.disabled = true;
  confirmAddButton.textContent = "Agregando...";

  try {
    const response = await fetch(apiUrl("/api/add"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        releaseId: selectedRelease.releaseId,
        barcode: lastBarcode || undefined,
        coverCondition: document.getElementById("cover-condition").value,
        discCondition: document.getElementById("disc-condition").value,
        comment: document.getElementById("comment-input").value.trim() || undefined,
      }),
    });
    const data = await response.json();

    if (response.status === 401) {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      adminTokenRow.hidden = false;
      adminTokenInput.value = "";
      throw new Error("Token inválido. Pegalo de nuevo y reintentá.");
    }
    if (response.status === 409 && data.error === "duplicate") {
      throw new Error(data.message);
    }
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);

    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
    adminTokenInput.value = "";
    renderSuccess(data);
    showStep("done");
  } catch (error) {
    confirmError.textContent = error.message;
  } finally {
    confirmAddButton.disabled = false;
    confirmAddButton.textContent = "Agregar a la colección";
  }
}

function renderSuccess(data) {
  const card = document.getElementById("success-card");
  card.innerHTML = "";

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = "✅";

  const heading = document.createElement("h2");
  heading.textContent = `#${data.record.number} — ${data.record.artist} — ${data.record.title}`;

  const note = document.createElement("p");
  note.textContent = data.note || "Agregado a la colección.";

  const link = document.createElement("a");
  link.href = APP_BASE_PATH || "/";
  link.textContent = "Ver la colección →";

  card.append(badge, heading, note, link);
}

// --- Helpers ----------------------------------------------------------------

function resolveAppBasePath() {
  const path = window.location.pathname || "/";
  return path === "/vinilos" || path.startsWith("/vinilos/") ? "/vinilos" : "";
}

// API routes live at the domain root regardless of the /vinilos rewrite.
function apiUrl(path) {
  return path;
}

async function fetchJson(url) {
  const response = await fetch(url);
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`El servidor respondió ${response.status}. ¿Está deployada la API?`);
  }
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
