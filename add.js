import { supabase } from "/js/supabase-client.js";
import { requireSession, getOwnProfile } from "/js/auth.js";

const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const ZXING_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E"];

let session = null;
let ownProfile = null;

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
const backLink = document.getElementById("back-link");

// Auth gate: redirects to /login when there is no session.
(async () => {
  session = await requireSession("/add");
  if (!session) {
    return;
  }
  ownProfile = await getOwnProfile();
  if (!ownProfile) {
    window.location.replace("/login?next=/add");
    return;
  }
  backLink.href = `/u/${ownProfile.username}`;
})();

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
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch {
    scanError.textContent =
      "Could not access the camera. Allow camera access in the browser, or type the code below.";
    return;
  }

  video.srcObject = mediaStream;
  await video.play();

  // Continuous autofocus and a modest zoom dramatically improve barcode
  // reads on phones; both are best-effort (not all browsers expose them).
  try {
    const [track] = mediaStream.getVideoTracks();
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const advanced = [];
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      advanced.push({ focusMode: "continuous" });
    }
    if (caps.zoom && caps.zoom.max >= 1.5) {
      advanced.push({ zoom: Math.min(2, caps.zoom.max) });
    }
    if (advanced.length) {
      await track.applyConstraints({ advanced });
    }
  } catch {
    // Best effort only.
  }
  scannerShell.hidden = false;
  startScanButton.hidden = true;
  stopScanButton.hidden = false;
  scanStatus.textContent = "Point at the barcode";

  let detectFrame;
  try {
    detectFrame = await createDetector();
  } catch {
    scanError.textContent = "Could not load the barcode reader. Type the code manually.";
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
    await sleep(150);
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

  // Version pinned: an unpinned @2 broke when 2.2.x moved the dist layout.
  const { readBarcodes } = await import(
    "https://cdn.jsdelivr.net/npm/zxing-wasm@2.2.4/dist/es/reader/index.js"
  );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  return async (videoElement) => {
    const width = videoElement.videoWidth;
    const height = videoElement.videoHeight;
    if (!width) return null;

    // Decode only the on-screen guide region: the barcode covers far more
    // effective pixels than in a full-frame scan.
    const cropWidth = Math.round(width * 0.8);
    const cropHeight = Math.round(height * 0.36);
    const cropX = Math.round((width - cropWidth) / 2);
    const cropY = Math.round((height - cropHeight) / 2);
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    context.drawImage(videoElement, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const imageData = context.getImageData(0, 0, cropWidth, cropHeight);
    const results = await readBarcodes(imageData, {
      formats: ZXING_FORMATS,
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
    });
    return results[0]?.text || null;
  };
}

// --- Paso 2: candidatos ----------------------------------------------------

async function search(query) {
  scanError.textContent = "";
  const isBarcode = /^\d{8,14}$/.test(query.replace(/\s/g, ""));
  lastBarcode = isBarcode ? query.replace(/\s/g, "") : "";

  candidatesHeading.textContent = isBarcode
    ? `Searching barcode ${query}…`
    : `Searching "${query}"…`;
  candidateList.innerHTML = '<div class="spinner"></div>';
  showStep("candidates");

  let data;
  try {
    const param = isBarcode ? `barcode=${encodeURIComponent(lastBarcode)}` : `q=${encodeURIComponent(query)}`;
    data = await fetchJson(apiUrl(`/api/lookup?${param}`));
  } catch (error) {
    candidatesHeading.textContent = "Search failed.";
    candidateList.innerHTML = "";
    renderRetry(error.message);
    return;
  }

  const candidates = data.candidates || [];
  if (!candidates.length) {
    candidatesHeading.textContent = isBarcode
      ? `No Discogs results for barcode ${query}. Try searching by artist and title.`
      : `No results for "${query}".`;
    candidateList.innerHTML = "";
    return;
  }

  candidatesHeading.textContent = `${candidates.length} result${candidates.length === 1 ? "" : "s"} on Discogs — pick your edition:`;
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
  showStep("confirm");

  try {
    const data = await fetchJson(apiUrl(`/api/lookup?release=${encodeURIComponent(releaseId)}`));
    selectedRelease = data.release;
  } catch (error) {
    confirmCard.innerHTML = "";
    confirmError.textContent = `Could not load release details: ${error.message}`;
    return;
  }

  renderConfirmCard(selectedRelease);
}

function renderConfirmCard(release) {
  confirmCard.innerHTML = "";

  if (release.coverImage) {
    const img = document.createElement("img");
    img.src = release.coverImage;
    img.alt = `${release.title} cover`;
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

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    window.location.replace("/login?next=/add");
    return;
  }

  confirmAddButton.disabled = true;
  confirmAddButton.textContent = "Adding\u2026";

  try {
    const response = await fetch("/api/records", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        releaseId: selectedRelease.releaseId,
        barcode: lastBarcode || undefined,
        coverCondition: document.getElementById("cover-condition").value,
        discCondition: document.getElementById("disc-condition").value,
        comment: document.getElementById("comment-input").value.trim() || undefined,
      }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`The server responded ${response.status}. Is the API deployed?`);
    }

    if (response.status === 401) {
      window.location.replace("/login?next=/add");
      return;
    }
    if (response.status === 409 && payload.error === "duplicate") {
      throw new Error(payload.message);
    }
    if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);

    renderSuccess(payload);
    showStep("done");
  } catch (error) {
    confirmError.textContent = error.message;
  } finally {
    confirmAddButton.disabled = false;
    confirmAddButton.textContent = "Add to collection";
  }
}

function renderSuccess(payload) {
  const card = document.getElementById("success-card");
  card.innerHTML = "";

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = "Added";

  const heading = document.createElement("h2");
  heading.textContent = `#${payload.record.position} \u2014 ${payload.record.artist} \u2014 ${payload.record.title}`;

  const note = document.createElement("p");
  note.textContent = "It is already live in your collection.";

  const link = document.createElement("a");
  link.href = payload.collection || (ownProfile ? `/u/${ownProfile.username}` : "/");
  link.textContent = "View collection \u2192";

  card.append(badge, heading, note, link);
}

// --- Helpers ----------------------------------------------------------------

function apiUrl(path) {
  return path;
}

async function fetchJson(url) {
  const response = await fetch(url);
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server responded ${response.status}. Is the API deployed?`);
  }
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Discogs collection import ------------------------------------------------
// One /api/import call per Discogs page (25 releases); the loop here drives
// progress until the server says done.

const importForm = document.getElementById("import-form");
const importUsernameInput = document.getElementById("import-username");
const importError = document.getElementById("import-error");
const importStatus = document.getElementById("import-status");

importForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const discogsUsername = importUsernameInput.value.trim();
  if (!discogsUsername) return;

  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    window.location.replace("/login?next=/add");
    return;
  }

  const submitButton = importForm.querySelector("button");
  submitButton.disabled = true;
  importUsernameInput.disabled = true;
  importError.textContent = "";
  importStatus.hidden = false;
  importStatus.textContent = "Connecting to Discogs…";

  let page = 1;
  let imported = 0;
  let skipped = 0;

  try {
    for (;;) {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ discogsUsername, page }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `The server responded ${response.status}`);
      }

      imported += payload.imported;
      skipped += payload.skipped;
      importStatus.textContent =
        `Importing… ${imported} added · ${skipped} skipped — page ${payload.page}/${payload.pages}`;

      if (payload.done) {
        importStatus.textContent = payload.capped
          ? `Imported ${imported}, skipped ${skipped} — stopped at the ${payload.collectionCount}-record limit.`
          : `Done: ${imported} imported, ${skipped} already on your shelf.`;
        if (imported) {
          const profile = await getOwnProfile();
          if (profile) {
            importStatus.append(" ");
            const link = document.createElement("a");
            link.href = `/u/${profile.username}`;
            link.textContent = "View your collection →";
            importStatus.append(link);
          }
        }
        break;
      }
      page = payload.page + 1;
    }
  } catch (error) {
    importError.textContent = error.message || "Import failed";
    importStatus.hidden = true;
  } finally {
    submitButton.disabled = false;
    importUsernameInput.disabled = false;
  }
});
