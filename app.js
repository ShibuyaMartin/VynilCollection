const state = {
  collectionName: "Collection",
  records: [],
  filteredRecords: [],
  activeIndex: 0,
  filters: {
    query: "",
    genre: "all",
    style: "all",
  },
};

const interaction = {
  drag: null,
  suppressClickUntil: 0,
};

const REFLECTION_TUNING_STORAGE_KEY = "vinilos-reflection-tuning";

const REFLECTION_TUNING_DEFAULTS = {
  backgroundGlowColor: "#ffffff",
  backgroundGlowStrength: 0,
  backgroundGlowBlur: 240,
  backgroundGlowX: 52,
  backgroundGlowY: 50,
  backgroundVignette: 1,
  reflectionOpacity: 0.47,
  centerReflectionOpacity: 1,
  nearReflectionOpacity: 0.35,
  farReflectionOpacity: 0.42,
  centerReflectionBlur: 2,
  nearReflectionBlur: 8,
  farReflectionBlur: 24,
  activeStrength: 0.007,
  sideStrength: 0,
  activeGap: 4,
  sideGap: 0,
  fadeHeight: 30,
  fadeBlur: 18,
  fadeTop: 0.11,
  fadeMid: 0.71,
  fadeBottom: 0.7,
  edgeDark: 0.44,
  centerDark: 0.26,
};

const coverCardCache = new Map();

const elements = {
  searchInput: document.querySelector("#search-input"),
  genreFilter: document.querySelector("#genre-filter"),
  styleFilter: document.querySelector("#style-filter"),
  resetFilters: document.querySelector("#reset-filters"),
  sceneEmptyReset: document.querySelector("#scene-empty-reset"),
  galleryStage: document.querySelector("#gallery-stage"),
  coverLayer: document.querySelector("#cover-layer"),
  sceneEmpty: document.querySelector("#scene-empty"),
  prevButton: document.querySelector("#prev-button"),
  nextButton: document.querySelector("#next-button"),
  slider: document.querySelector("#position-slider"),
  albumNumber: document.querySelector("#album-number"),
  albumTitle: document.querySelector("#album-title"),
  albumArtist: document.querySelector("#album-artist"),
  albumMeta: document.querySelector("#album-meta"),
  albumNotes: document.querySelector("#album-notes"),
  discogsLink: document.querySelector("#discogs-link"),
  spotifyLink: document.querySelector("#spotify-link"),
  tidalLink: document.querySelector("#tidal-link"),
  tracklistStatus: document.querySelector("#tracklist-status"),
  tracklistList: document.querySelector("#tracklist-list"),
  tuningPanel: document.querySelector("#tuning-panel"),
  tuningInputs: [...document.querySelectorAll("[data-tuning-key]")],
  tuningOutputs: [...document.querySelectorAll("[data-tuning-output]")],
  tuningOutput: document.querySelector("#tuning-output"),
  tuningCopy: document.querySelector("#tuning-copy"),
  tuningReset: document.querySelector("#tuning-reset"),
};

init().catch((error) => {
  console.error(error);
  elements.sceneEmpty.hidden = false;
  elements.sceneEmpty.querySelector(".scene-empty__title").textContent = "Collection data missing";
  elements.sceneEmpty.querySelector(".scene-empty__copy").textContent =
    "Run the importer script from the README so the app can load your spreadsheet.";
});

async function init() {
  const response = await fetch("/vinilos/data/collection.json?v=1775263830");
  if (!response.ok) {
    throw new Error(`Failed to load collection.json (${response.status})`);
  }

  const payload = await response.json();
  state.collectionName = payload.collectionName ?? "Vinyl Collection";
  state.records = dedupeRecords(payload.records ?? []);

  buildFilters();
  bindEvents();
  syncFiltersFromControls();
  applyFilters({ autoResetIfEmpty: true });
  initTuningPanel();
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.filters.query = event.target.value.trim();
    applyFilters();
  });

  elements.genreFilter.addEventListener("change", (event) => {
    state.filters.genre = event.target.value;
    applyFilters();
  });

  elements.styleFilter.addEventListener("change", (event) => {
    state.filters.style = event.target.value;
    applyFilters();
  });

  elements.resetFilters.addEventListener("click", () => {
    resetFilters();
  });

  elements.sceneEmptyReset.addEventListener("click", () => {
    resetFilters();
  });

  elements.prevButton.addEventListener("click", () => navigate(-1));
  elements.nextButton.addEventListener("click", () => navigate(1));

  elements.slider.addEventListener("input", (event) => {
    state.activeIndex = Number(event.target.value);
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      navigate(-1);
    }

    if (event.key === "ArrowRight") {
      navigate(1);
    }
  });

  elements.galleryStage.addEventListener("pointerdown", handlePointerDown);
  elements.galleryStage.addEventListener("pointermove", handlePointerMove);
  elements.galleryStage.addEventListener("pointerup", handlePointerUp);
  elements.galleryStage.addEventListener("pointerleave", handlePointerUp);
  elements.galleryStage.addEventListener("wheel", handleWheel, { passive: false });
}

function handlePointerDown(event) {
  interaction.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    lastX: event.clientX,
    moved: false,
  };

  elements.galleryStage.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  if (!interaction.drag) {
    return;
  }

  const deltaX = event.clientX - interaction.drag.lastX;
  const movedX = Math.abs(event.clientX - interaction.drag.startX);
  if (movedX > 6) {
    interaction.drag.moved = true;
  }

  if (Math.abs(deltaX) > 42) {
    const steps = Math.max(1, Math.floor(Math.abs(deltaX) / 42));
    for (let step = 0; step < steps; step += 1) {
      navigate(deltaX < 0 ? 1 : -1);
    }
    interaction.drag.lastX = event.clientX;
  }
}

function handlePointerUp(event) {
  if (!interaction.drag) {
    return;
  }

  if (interaction.drag.moved) {
    interaction.suppressClickUntil = performance.now() + 120;
  }

  if (interaction.drag.pointerId === event.pointerId) {
    elements.galleryStage.releasePointerCapture?.(event.pointerId);
  }

  interaction.drag = null;
}

function handleWheel(event) {
  if (!state.filteredRecords.length) {
    return;
  }

  const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15;
  const browseIntent = horizontalIntent || event.shiftKey;
  if (!browseIntent) {
    return;
  }

  const directionSource = horizontalIntent ? event.deltaX : event.deltaY;
  if (!directionSource) {
    return;
  }

  event.preventDefault();
  navigate(directionSource > 0 ? 1 : -1);
}

function buildFilters() {
  const genres = uniqueSorted(state.records.flatMap((record) => getGenresForRecord(record)).filter(Boolean));
  const styles = uniqueSorted(state.records.flatMap((record) => getStylesForRecord(record)).filter(Boolean));

  populateSelect(elements.genreFilter, genres, "All");
  populateSelect(elements.styleFilter, styles, "All");
}

function populateSelect(selectElement, values, allLabel) {
  selectElement.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "all";
  defaultOption.textContent = allLabel;
  selectElement.append(defaultOption);

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectElement.append(option);
  });
}

function syncFiltersFromControls() {
  state.filters.query = elements.searchInput.value.trim();
  state.filters.genre = elements.genreFilter.value || "all";
  state.filters.style = elements.styleFilter.value || "all";
}

function resetFilters() {
  state.filters = {
    query: "",
    genre: "all",
    style: "all",
  };

  elements.searchInput.value = "";
  elements.genreFilter.value = "all";
  elements.styleFilter.value = "all";
  applyFilters();
}

function hasActiveFilters() {
  return Boolean(state.filters.query || state.filters.genre !== "all" || state.filters.style !== "all");
}

function applyFilters(options = {}) {
  const { autoResetIfEmpty = false } = options;
  const query = normalizeText(state.filters.query);
  const previousRecord = state.filteredRecords[state.activeIndex];

  state.filteredRecords = state.records.filter((record) => {
    const matchesQuery = !query || record.searchText.includes(query);
    const recordGenres = getGenresForRecord(record);
    const recordStyles = getStylesForRecord(record);
    const matchesGenre = state.filters.genre === "all" || recordGenres.includes(state.filters.genre);
    const matchesStyle = state.filters.style === "all" || recordStyles.includes(state.filters.style);

    return matchesQuery && matchesGenre && matchesStyle;
  });

  if (!state.filteredRecords.length) {
    if (autoResetIfEmpty && hasActiveFilters()) {
      resetFilters();
      return;
    }

    state.activeIndex = 0;
    render();
    return;
  }

  if (previousRecord) {
    const preservedIndex = state.filteredRecords.findIndex(
      (record) => record.id === previousRecord.id
    );
    state.activeIndex = preservedIndex >= 0 ? preservedIndex : 0;
  } else {
    state.activeIndex = 0;
  }

  render();
}

function navigate(delta) {
  if (!state.filteredRecords.length) {
    return;
  }

  const maxIndex = state.filteredRecords.length - 1;
  state.activeIndex = clamp(state.activeIndex + delta, 0, maxIndex);
  render();
}

function render() {
  renderStage();
  renderAlbumPanel();
}

function renderStage() {
  const hasRecords = Boolean(state.filteredRecords.length);

  elements.slider.max = String(Math.max(state.filteredRecords.length - 1, 0));
  elements.slider.value = String(state.activeIndex);
  elements.sceneEmpty.hidden = hasRecords;
  elements.prevButton.disabled = !hasRecords || state.activeIndex === 0;
  elements.nextButton.disabled =
    !hasRecords || state.activeIndex === state.filteredRecords.length - 1;

  renderCoverLayer();
}

function renderCoverLayer() {
  if (!state.filteredRecords.length) {
    elements.coverLayer.replaceChildren();
    coverCardCache.clear();
    return;
  }

  const visibleRange = 3;
  const nextCards = [];
  const visibleKeys = new Set();

  for (let offset = -visibleRange; offset <= visibleRange; offset += 1) {
    const index = state.activeIndex + offset;
    const record = state.filteredRecords[index];
    if (!record) {
      continue;
    }

    const recordKey = String(record.id || `${record.number}-${record.artist}-${record.title}`);
    visibleKeys.add(recordKey);

    let entry = coverCardCache.get(recordKey);
    if (!entry) {
      entry = createCoverCard();
      coverCardCache.set(recordKey, entry);
    }

    updateCoverCard(entry, record, index, offset);
    nextCards.push(entry.frame);
  }

  for (const [recordKey, entry] of coverCardCache.entries()) {
    if (visibleKeys.has(recordKey)) {
      continue;
    }
    entry.frame.remove();
    coverCardCache.delete(recordKey);
  }

  elements.coverLayer.replaceChildren(...nextCards);
}

function createCoverCard() {
  const frame = document.createElement("div");
  frame.className = "cover-frame";

  const card = document.createElement("button");
  card.type = "button";
  card.className = "cover-card";

  const image = document.createElement("img");
  image.className = "cover-card__image";
  image.loading = "eager";
  image.referrerPolicy = "strict-origin-when-cross-origin";

  const reflection = document.createElement("div");
  reflection.className = "cover-reflection";
  reflection.hidden = true;

  const reflectionImage = document.createElement("img");
  reflectionImage.className = "cover-reflection__image";
  reflectionImage.loading = "eager";
  reflectionImage.referrerPolicy = "strict-origin-when-cross-origin";
  reflectionImage.alt = "";
  reflectionImage.setAttribute("aria-hidden", "true");
  reflection.append(reflectionImage);

  const placeholder = document.createElement("div");
  placeholder.className = "cover-card__placeholder";

  const genre = document.createElement("span");
  genre.className = "cover-card__genre";

  const title = document.createElement("span");
  title.className = "cover-card__title";

  const artist = document.createElement("span");
  artist.className = "cover-card__artist";

  placeholder.append(genre, title, artist);
  card.append(image, placeholder);
  frame.append(card, reflection);

  image.addEventListener("load", () => {
    placeholder.hidden = true;
    reflection.hidden = !image.currentSrc;
  });

  image.addEventListener("error", () => {
    const fallbackCoverUrl = card.dataset.fallbackCover || "";
    if (fallbackCoverUrl && image.src !== fallbackCoverUrl) {
      image.src = fallbackCoverUrl;
      reflectionImage.src = fallbackCoverUrl;
      return;
    }
    placeholder.hidden = false;
    reflection.hidden = true;
  });

  reflectionImage.addEventListener("error", () => {
    reflection.hidden = true;
  });

  card.addEventListener("click", () => {
    if (performance.now() < interaction.suppressClickUntil) {
      return;
    }

    const targetIndex = Number(card.dataset.index || "-1");
    if (targetIndex < 0 || Number.isNaN(targetIndex)) {
      return;
    }

    state.activeIndex = targetIndex;
    render();
  });

  return { frame, card, image, reflection, reflectionImage, placeholder, genre, title, artist };
}

function updateCoverCard(entry, record, index, offset) {
  const { frame, card, image, reflection, reflectionImage, placeholder, genre, title, artist } = entry;
  const isNewCard = !frame.isConnected;
  const preferredCoverUrl = resolveCoverUrl(record.coverUrl || record.thumbUrl || "");
  const fallbackCoverUrl =
    preferredCoverUrl && record.thumbUrl && resolveCoverUrl(record.thumbUrl) !== preferredCoverUrl
      ? resolveCoverUrl(record.thumbUrl)
      : "";

  card.dataset.index = String(index);
  card.dataset.fallbackCover = fallbackCoverUrl;
  card.setAttribute("aria-label", `${record.artist} - ${record.title}`);
  const distance = Math.abs(offset);
  frame.classList.toggle("cover-frame--active", distance === 0);
  frame.classList.toggle("cover-frame--near", distance === 1);
  frame.classList.toggle("cover-frame--far", distance >= 2);
  frame.classList.toggle("cover-frame--side", distance >= 1);
  card.classList.toggle("cover-card--active", distance === 0);
  card.classList.toggle("cover-card--near", distance === 1);
  card.classList.toggle("cover-card--far", distance >= 2);
  card.classList.toggle("cover-card--side", distance >= 1);

  frame.style.zIndex = String(200 - distance);
  frame.style.transformOrigin =
    offset < 0 ? "100% 50%" : offset > 0 ? "0% 50%" : "50% 50%";
  frame.style.transitionDelay = `${Math.min(distance * 18, 72)}ms`;

  const nextTransform = coverTransform(offset);
  const nextOpacity = String(coverOpacity(offset));
  const nextFilter = coverFilter(offset);

  if (isNewCard) {
    frame.style.transform = `${nextTransform} scale(0.94)`;
    frame.style.opacity = "0";
    card.style.filter = "saturate(0.55) brightness(0.58)";
    reflectionImage.style.filter = "saturate(0.55) brightness(0.58)";
    requestAnimationFrame(() => {
      frame.style.transform = nextTransform;
      frame.style.opacity = nextOpacity;
      card.style.filter = nextFilter;
      reflectionImage.style.filter = nextFilter;
    });
  } else {
    frame.style.transform = nextTransform;
    frame.style.opacity = nextOpacity;
    card.style.filter = nextFilter;
    reflectionImage.style.filter = nextFilter;
  }

  genre.textContent = getGenresForRecord(record)[0] || record.genre || "Collection";
  title.textContent = record.title;
  artist.textContent = record.artist;
  image.alt = `${record.artist} - ${record.title}`;

  if (card.dataset.coverSrc !== preferredCoverUrl) {
    card.dataset.coverSrc = preferredCoverUrl;
    if (preferredCoverUrl) {
      placeholder.hidden = false;
      reflection.hidden = false;
      image.src = preferredCoverUrl;
      reflectionImage.src = preferredCoverUrl;
    } else {
      image.removeAttribute("src");
      reflectionImage.removeAttribute("src");
      reflection.hidden = true;
      placeholder.hidden = false;
    }
  } else if (!preferredCoverUrl) {
    reflection.hidden = true;
    placeholder.hidden = false;
  }
}

function renderAlbumPanel() {
  const record = state.filteredRecords[state.activeIndex];

  if (!record) {
    elements.albumNumber.textContent = "Record -";
    elements.albumTitle.textContent = "No record selected";
    elements.albumArtist.textContent = "Adjust the filters to bring the archive back.";
    elements.albumMeta.textContent = "Genre • Style • Year • Label";
    if (elements.albumNotes) {
      elements.albumNotes.textContent = "The notes will appear here once a record is selected.";
    }
    setListenLinks(null);
    hideDiscogsLink();
    renderTracklist([]);
    return;
  }

  elements.albumNumber.textContent = `Record ${record.number} / ${state.filteredRecords.length}`;
  elements.albumTitle.textContent = record.title;
  elements.albumArtist.textContent = record.artist;
  elements.albumMeta.textContent = buildMetaLine(record);
  if (elements.albumNotes) {
    elements.albumNotes.textContent = record.notes || "No notes recorded yet.";
  }

  setListenLinks(record);

  if (record.discogsUrl) {
    elements.discogsLink.href = discogsAbsoluteUrl(record.discogsCanonicalUrl || record.discogsUrl);
    elements.discogsLink.hidden = false;
    elements.discogsLink.classList.remove("is-disabled");
  } else {
    hideDiscogsLink();
  }

  renderTracklist(record.tracklist ?? []);
  if(typeof updatePlayer==="function") updatePlayer(record);
}

function buildMetaLine(record) {
  const genres = getGenresForRecord(record);
  const styles = getStylesForRecord(record);

  return [
    genres.slice(0, 2).join(" / "),
    styles.slice(0, 2).join(" / "),
    record.year || "",
    record.country || "",
    record.label ? `Label: ${record.label}` : "",
  ]
    .filter(Boolean)
    .join(" • ");
}

function renderTracklist(tracklist) {
  elements.tracklistList.innerHTML = "";

  if (!tracklist.length) {
    elements.tracklistStatus.textContent = "Unavailable";
    elements.tracklistList.className = "tracklist-list tracklist-list--empty";

    const emptyItem = document.createElement("li");
    emptyItem.className = "tracklist-list__empty-copy";
    emptyItem.textContent = "Tracklist unavailable for this pressing.";
    elements.tracklistList.append(emptyItem);
    return;
  }

  elements.tracklistStatus.textContent = `${tracklist.length} tracks`;
  elements.tracklistList.className = "tracklist-list";

  tracklist.forEach((track, index) => {
    const item = document.createElement("li");
    item.className = "tracklist-list__item";

    const position = document.createElement("span");
    position.className = "tracklist-list__position";
    position.textContent = track.position || String(index + 1).padStart(2, "0");

    const titleWrap = document.createElement("div");
    titleWrap.className = "tracklist-list__title-wrap";

    if (track.heading) {
      const heading = document.createElement("span");
      heading.className = "tracklist-list__heading";
      heading.textContent = track.heading;
      titleWrap.append(heading);
    }

    const title = document.createElement("span");
    title.className = "tracklist-list__title";
    title.textContent = track.title || "Untitled";
    titleWrap.append(title);

    const duration = document.createElement("span");
    duration.className = "tracklist-list__duration";
    duration.textContent = track.duration || "--:--";

    item.append(position, titleWrap, duration);
    elements.tracklistList.append(item);
  });
}

function setListenLinks(record) {
  const spotifyUrl = record ? searchUrl("https://open.spotify.com/search/", record) : "#";
  const tidalUrl = record ? searchUrl("https://listen.tidal.com/search?q=", record, true) : "#";

  setLinkState(elements.spotifyLink, spotifyUrl, Boolean(record));
  setLinkState(elements.tidalLink, tidalUrl, Boolean(record));
}

function setLinkState(link, href, enabled) {
  link.href = href;
  link.classList.toggle("is-disabled", !enabled);
  link.setAttribute("aria-disabled", String(!enabled));
}

function hideDiscogsLink() {
  elements.discogsLink.hidden = true;
  elements.discogsLink.classList.add("is-disabled");
  elements.discogsLink.removeAttribute("href");
}

function searchUrl(baseUrl, record, alreadyQuery = false) {
  if (!record) {
    return "#";
  }

  const query = `${record.artist} ${record.title}`.trim();
  const encoded = encodeURIComponent(query);
  return alreadyQuery ? `${baseUrl}${encoded}` : `${baseUrl}${encoded}`;
}

function discogsAbsoluteUrl(value) {
  if (!value) {
    return "#";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return `https://www.discogs.com${value}`;
}

function resolveCoverUrl(value) {
  const url = String(value || "").trim();
  if (!url) {
    return "";
  }

  // The repo doesn't include /covers assets, so local previews on localhost
  // borrow the already-published cover files from shibu.pro.
  if (isLocalPreviewHost() && url.startsWith("/vinilos/covers/")) {
    return `https://shibu.pro${url}`;
  }

  return url;
}

function isLocalPreviewHost() {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

function coverTransform(offset) {
  const distance = Math.abs(offset);
  const direction = Math.sign(offset) || 0;
  const poses = {
    0: { x: 0, y: 0, z: 280, rotateY: 0, rotateX: 0, scale: 1.62 },
    1: { x: 15.5, y: 0, z: 140, rotateY: -50, rotateX: 0.8, scale: 0.98 },
    2: { x: 28, y: 0, z: 44, rotateY: -64, rotateX: 1, scale: 0.8 },
    3: { x: 40.5, y: 0, z: -16, rotateY: -74, rotateX: 1.2, scale: 0.62 },
  };
  const pose = poses[distance] ?? poses[3];
  const x = pose.x * direction;
  const y = pose.y;
  const z = pose.z;
  const rotateY = distance === 0 ? 0 : pose.rotateY * direction;
  const rotateX = pose.rotateX;
  const scale = pose.scale;

  return `translate3d(calc(-50% + ${x}vw), calc(-50% + ${y}rem), ${z}px) rotateY(${rotateY}deg) rotateX(${rotateX}deg) scale(${scale})`;
}

function coverOpacity(offset) {
  const distance = Math.abs(offset);
  if (distance === 0) {
    return 1;
  }
  if (distance === 1) {
    return 0.96;
  }
  if (distance === 2) {
    return 0.72;
  }
  return 0.38;
}

function coverFilter(offset) {
  const distance = Math.abs(offset);
  if (distance === 0) {
    return "saturate(1) brightness(1)";
  }
  if (distance === 1) {
    return "saturate(0.94) brightness(0.96)";
  }
  if (distance === 2) {
    return "saturate(0.82) brightness(0.82)";
  }
  return "saturate(0.66) brightness(0.6)";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getGenresForRecord(record) {
  const discogsGenres = (record.discogsGenres ?? []).filter(Boolean);
  if (discogsGenres.length) {
    return discogsGenres;
  }

  const groupedGenres = (record.genreGroups ?? []).filter(Boolean);
  if (groupedGenres.length) {
    return groupedGenres;
  }

  return record.genre ? [record.genre] : [];
}

function getStylesForRecord(record) {
  return (record.discogsStyles ?? []).filter(Boolean);
}

function dedupeRecords(records) {
  const map = new Map();

  records.forEach((record) => {
    const releaseId = String(record.discogsReleaseId || "").trim();
    const fallbackKey = [
      normalizeText(record.artist || ""),
      normalizeText(record.title || ""),
      normalizeText(record.year || ""),
      normalizeText(record.label || ""),
    ].join("|");
    const key = releaseId ? `release:${releaseId}` : `fallback:${fallbackKey}`;

    if (!map.has(key)) {
      map.set(key, record);
      return;
    }

    const existing = map.get(key);
    const existingScore = qualityScore(existing);
    const nextScore = qualityScore(record);
    if (nextScore > existingScore) {
      map.set(key, record);
    }
  });

  return [...map.values()].sort((left, right) => Number(left.number) - Number(right.number));
}

function qualityScore(record) {
  let score = 0;
  if (record.coverUrl) {
    score += 2;
  }
  if (record.tracklist?.length) {
    score += 2;
  }
  if (record.discogsStyles?.length) {
    score += 1;
  }
  if (record.notes) {
    score += 1;
  }
  return score;
}

// ── SEARCH TOGGLE ──
document.addEventListener('DOMContentLoaded', function() {
  const toggle = document.getElementById('search-toggle');
  const overlay = document.getElementById('search-overlay');
  const closeBtn = document.getElementById('search-close');
  const input = document.getElementById('search-input');
  if (!toggle || !overlay) return;
  toggle.addEventListener('click', () => { overlay.hidden = false; setTimeout(() => input && input.focus(), 50); });
  closeBtn && closeBtn.addEventListener('click', () => { overlay.hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
  });
});

// ── YOUTUBE PLAYER ──
let currentPlayerQuery = null;
async function updatePlayer(record) {
  const shell = document.getElementById('player-shell');
  const wrap = document.getElementById('player-wrap');
  if (!shell || !wrap) return;
  const query = '"' + record.title + '" ' + record.artist + ' full album';
  if (query === currentPlayerQuery) return;
  currentPlayerQuery = query;
  shell.hidden = false;
  wrap.innerHTML = '<div class="player-searching">Buscando...</div>';
  try {
    const res = await fetch('/yt-search?q=' + encodeURIComponent(query));
    if (!res.ok) throw new Error('no result');
    const data = await res.json();
    if (data.videoId) {
      wrap.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + data.videoId + '?autoplay=0&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>';
    } else throw new Error('not found');
  } catch(e) {
    const ytSearch = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    wrap.innerHTML = '<div class="player-not-found"><a href="' + ytSearch + '" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">Buscar en YouTube ↗</a></div>';
  }
}

function initTuningPanel() {
  if (!isLocalPreviewHost() || !elements.tuningPanel) {
    return;
  }

  elements.tuningPanel.hidden = false;

  const savedValues = loadReflectionTuning();
  const tuningValues = { ...REFLECTION_TUNING_DEFAULTS, ...savedValues };

  elements.tuningInputs.forEach((input) => {
    const key = input.dataset.tuningKey;
    if (!key || !(key in tuningValues)) {
      return;
    }

    input.value = String(tuningValues[key]);
    input.addEventListener("input", handleTuningInput);
  });

  elements.tuningCopy?.addEventListener("click", copyTuningValues);
  elements.tuningReset?.addEventListener("click", resetTuningValues);

  applyReflectionTuning(tuningValues);
}

function handleTuningInput() {
  const tuningValues = readTuningValuesFromControls();
  saveReflectionTuning(tuningValues);
  applyReflectionTuning(tuningValues);
}

function resetTuningValues() {
  elements.tuningInputs.forEach((input) => {
    const key = input.dataset.tuningKey;
    if (!key || !(key in REFLECTION_TUNING_DEFAULTS)) {
      return;
    }

    input.value = String(REFLECTION_TUNING_DEFAULTS[key]);
  });

  localStorage.removeItem(REFLECTION_TUNING_STORAGE_KEY);
  applyReflectionTuning(REFLECTION_TUNING_DEFAULTS);
}

async function copyTuningValues() {
  if (!elements.tuningOutput) {
    return;
  }

  const text = elements.tuningOutput.value;
  elements.tuningOutput.focus();
  elements.tuningOutput.select();

  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.warn("Unable to copy tuning values automatically.", error);
  }
}

function readTuningValuesFromControls() {
  const values = { ...REFLECTION_TUNING_DEFAULTS };

  elements.tuningInputs.forEach((input) => {
    const key = input.dataset.tuningKey;
    if (!key || !(key in values)) {
      return;
    }

    values[key] = input.type === "color" ? input.value : Number(input.value);
  });

  return values;
}

function applyReflectionTuning(values) {
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--background-glow-color-rgb", hexToRgbChannels(values.backgroundGlowColor));
  rootStyle.setProperty("--background-glow-strength", String(values.backgroundGlowStrength));
  rootStyle.setProperty("--background-glow-blur", `${values.backgroundGlowBlur}px`);
  rootStyle.setProperty("--background-glow-x", `${values.backgroundGlowX}%`);
  rootStyle.setProperty("--background-glow-y", `${values.backgroundGlowY}%`);
  rootStyle.setProperty("--background-vignette", String(values.backgroundVignette));
  rootStyle.setProperty("--reflection-opacity-master", String(values.reflectionOpacity));
  rootStyle.setProperty(
    "--reflection-opacity-active",
    String(roundNumber(values.reflectionOpacity * values.centerReflectionOpacity, 3))
  );
  rootStyle.setProperty(
    "--reflection-opacity-near",
    String(roundNumber(values.reflectionOpacity * values.nearReflectionOpacity, 3))
  );
  rootStyle.setProperty(
    "--reflection-opacity-far",
    String(roundNumber(values.reflectionOpacity * values.farReflectionOpacity, 3))
  );
  rootStyle.setProperty("--reflection-blur-active", `${values.centerReflectionBlur}px`);
  rootStyle.setProperty("--reflection-blur-near", `${values.nearReflectionBlur}px`);
  rootStyle.setProperty("--reflection-blur-far", `${values.farReflectionBlur}px`);
  rootStyle.setProperty(
    "--reflection-glow-opacity-active",
    String(roundNumber(Math.min(0.52, values.centerReflectionBlur / 18) * values.reflectionOpacity * values.centerReflectionOpacity, 3))
  );
  rootStyle.setProperty(
    "--reflection-glow-opacity-near",
    String(roundNumber(Math.min(0.52, values.nearReflectionBlur / 18) * values.reflectionOpacity * values.nearReflectionOpacity, 3))
  );
  rootStyle.setProperty(
    "--reflection-glow-opacity-far",
    String(roundNumber(Math.min(0.52, values.farReflectionBlur / 18) * values.reflectionOpacity * values.farReflectionOpacity, 3))
  );
  const activeStrength = values.activeStrength;
  const sideStrength = values.sideStrength;

  rootStyle.setProperty("--reflection-fade-height", `${values.fadeHeight}%`);
  rootStyle.setProperty("--reflection-fade-blur", `${values.fadeBlur}px`);
  rootStyle.setProperty("--reflection-fade-top", String(values.fadeTop));
  rootStyle.setProperty("--reflection-fade-mid", String(values.fadeMid));
  rootStyle.setProperty("--reflection-fade-bottom", String(values.fadeBottom));
  rootStyle.setProperty("--reflection-fade-edge-dark", String(values.edgeDark));
  rootStyle.setProperty("--reflection-fade-edge-soft", String(roundNumber(Math.max(0, values.edgeDark * 0.22), 3)));
  rootStyle.setProperty("--reflection-fade-center-dark", String(values.centerDark));
  rootStyle.setProperty("--reflection-fade-center-peak", String(roundNumber(Math.min(0.3, values.centerDark + 0.05), 3)));
  rootStyle.setProperty("--reflection-gap-active", `${values.activeGap}px`);
  rootStyle.setProperty("--reflection-gap-side", `${values.sideGap}px`);
  rootStyle.setProperty("--reflection-active-start", String(activeStrength));
  rootStyle.setProperty("--reflection-active-secondary", String(roundNumber(activeStrength / 2, 4)));
  rootStyle.setProperty("--reflection-side-start", String(sideStrength));

  updateTuningOutputs(values);
}

function updateTuningOutputs(values) {
  const labels = {
    backgroundGlowColor: String(values.backgroundGlowColor).toUpperCase(),
    backgroundGlowStrength: formatTuningNumber(values.backgroundGlowStrength, 2),
    backgroundGlowBlur: `${values.backgroundGlowBlur}px`,
    backgroundGlowX: `${values.backgroundGlowX}%`,
    backgroundGlowY: `${values.backgroundGlowY}%`,
    backgroundVignette: formatTuningNumber(values.backgroundVignette, 2),
    reflectionOpacity: formatTuningNumber(values.reflectionOpacity, 2),
    centerReflectionOpacity: formatTuningNumber(values.centerReflectionOpacity, 2),
    nearReflectionOpacity: formatTuningNumber(values.nearReflectionOpacity, 2),
    farReflectionOpacity: formatTuningNumber(values.farReflectionOpacity, 2),
    centerReflectionBlur: `${values.centerReflectionBlur}px`,
    nearReflectionBlur: `${values.nearReflectionBlur}px`,
    farReflectionBlur: `${values.farReflectionBlur}px`,
    activeStrength: formatTuningNumber(values.activeStrength, 4),
    sideStrength: formatTuningNumber(values.sideStrength, 4),
    activeGap: `${values.activeGap}px`,
    sideGap: `${values.sideGap}px`,
    fadeHeight: `${values.fadeHeight}%`,
    fadeBlur: `${values.fadeBlur}px`,
    fadeTop: formatTuningNumber(values.fadeTop, 3),
    fadeMid: formatTuningNumber(values.fadeMid, 3),
    fadeBottom: formatTuningNumber(values.fadeBottom, 3),
    edgeDark: formatTuningNumber(values.edgeDark, 3),
    centerDark: formatTuningNumber(values.centerDark, 3),
  };

  elements.tuningOutputs.forEach((output) => {
    const key = output.dataset.tuningOutput;
    if (!key || !(key in labels)) {
      return;
    }
    output.textContent = labels[key];
  });

  if (elements.tuningOutput) {
    elements.tuningOutput.value = JSON.stringify(values, null, 2);
  }
}

function formatTuningNumber(value, digits) {
  return Number(value).toFixed(digits);
}

function roundNumber(value, digits) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function hexToRgbChannels(value) {
  const normalized = String(value || "").trim().replace("#", "");
  if (!normalized) {
    return "0 0 0";
  }

  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized.slice(0, 6);

  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);

  if ([red, green, blue].some((channel) => Number.isNaN(channel))) {
    return "0 0 0";
  }

  return `${red} ${green} ${blue}`;
}

function loadReflectionTuning() {
  try {
    const raw = localStorage.getItem(REFLECTION_TUNING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn("Unable to read saved tuning values.", error);
    return {};
  }
}

function saveReflectionTuning(values) {
  try {
    localStorage.setItem(REFLECTION_TUNING_STORAGE_KEY, JSON.stringify(values));
  } catch (error) {
    console.warn("Unable to save tuning values.", error);
  }
}
