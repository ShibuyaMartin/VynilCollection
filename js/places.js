// Vinyl places: OSM record stores + community-added fairs/cafés via
// /api/places, with Deadwax ratings and comments on top (places +
// place_reviews tables under RLS).

import { supabase } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const els = {
  authLink: document.getElementById("auth-link"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  locateButton: document.getElementById("locate-button"),
  status: document.getElementById("status"),
  list: document.getElementById("place-list"),
  addPlace: document.getElementById("add-place"),
  addName: document.getElementById("add-name"),
  addKind: document.getElementById("add-kind"),
  addWebsite: document.getElementById("add-website"),
  addSubmit: document.getElementById("add-submit"),
  addStatus: document.getElementById("add-status"),
  addSignin: document.getElementById("add-signin"),
};

const KIND_LABELS = { store: "Store", fair: "Fair", cafe: "Café" };

let viewerId = null;
let center = null;
let places = [];
let reviewsByPlaceId = new Map();
let expandedKey = null;

init();

async function init() {
  const session = await getSession();
  viewerId = session?.user?.id || null;

  getOwnProfile().then((profile) => {
    if (profile) {
      els.authLink.textContent = `@${profile.username}`;
      els.authLink.href = `/u/${profile.username}`;
    }
  });

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = els.searchInput.value.trim();
    if (q) search({ q });
  });

  els.locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) {
      els.status.textContent = "This browser has no geolocation — search by city instead.";
      return;
    }
    els.locateButton.disabled = true;
    els.status.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        els.locateButton.disabled = false;
        search({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      () => {
        els.locateButton.disabled = false;
        els.status.textContent = "Location denied — search by city instead.";
      },
      { timeout: 12000, maximumAge: 120000 }
    );
  });

  els.addSubmit.addEventListener("click", addPlace);
}

async function search(params) {
  els.status.textContent = "Digging the map…";
  els.list.replaceChildren();
  expandedKey = null;

  try {
    const query = new URLSearchParams(
      params.q ? { q: params.q } : { lat: String(params.lat), lng: String(params.lng) }
    );
    const response = await fetch(`/api/places?${query}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Search failed");
    }

    center = payload.center;
    places = payload.places || [];

    const where = center.label || "your location";
    els.status.textContent = places.length
      ? `${places.length} place${places.length === 1 ? "" : "s"} within ${payload.radiusKm} km of ${where}`
      : `Nothing mapped within ${payload.radiusKm} km of ${where} — add the spots you know below.`;

    els.addPlace.hidden = !viewerId;
    els.addSignin.hidden = Boolean(viewerId);

    await loadReviews();
    renderList();
  } catch (error) {
    els.status.textContent = error.message || "Search failed";
  }
}

async function loadReviews() {
  reviewsByPlaceId = new Map();

  // Attach community rows to OSM results so their reviews surface.
  const osmIds = places.filter((p) => p.osmId && !p.placeId).map((p) => p.osmId);
  if (osmIds.length) {
    const { data } = await supabase.from("places").select("id, osm_id").in("osm_id", osmIds);
    const byOsm = new Map((data || []).map((row) => [row.osm_id, row.id]));
    for (const place of places) {
      if (!place.placeId && place.osmId) place.placeId = byOsm.get(place.osmId) || null;
    }
  }

  const placeIds = places.map((p) => p.placeId).filter(Boolean);
  if (!placeIds.length) return;

  const { data: reviews } = await supabase
    .from("place_reviews")
    .select("place_id, rating, body, created_at, author_id, profiles(username, display_name)")
    .in("place_id", placeIds)
    .order("created_at", { ascending: false })
    .limit(400);

  for (const review of reviews || []) {
    if (!reviewsByPlaceId.has(review.place_id)) reviewsByPlaceId.set(review.place_id, []);
    reviewsByPlaceId.get(review.place_id).push(review);
  }
}

function keyOf(place) {
  return place.placeId || place.osmId;
}

// A 56px map crop centered on the place, from a single OpenStreetMap tile
// (free, browser-embeddable — unlike Wikimedia maps, which blocks hotlinking).
// Returns the tile URL plus the pixel offset that centers the point, clamped
// so the tile always covers the window (no gaps near tile edges).
const THUMB_ZOOM = 15;
const TILE_PX = 256;
const THUMB_PX = 56;

function mapTile(lat, lng) {
  const n = 2 ** THUMB_ZOOM;
  const latRad = (lat * Math.PI) / 180;
  const fx = ((lng + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const xtile = Math.floor(fx);
  const ytile = Math.floor(fy);
  const px = (fx - xtile) * TILE_PX;
  const py = (fy - ytile) * TILE_PX;
  const clamp = (v) => Math.max(THUMB_PX - TILE_PX, Math.min(0, v));
  return {
    url: `https://tile.openstreetmap.org/${THUMB_ZOOM}/${xtile}/${ytile}.png`,
    offsetX: clamp(THUMB_PX / 2 - px),
    offsetY: clamp(THUMB_PX / 2 - py),
  };
}

function renderList() {
  els.list.replaceChildren(
    ...places.map((place) => {
      const card = document.createElement("article");
      card.className = "place";

      const head = document.createElement("div");
      head.className = "place-head";

      const thumb = document.createElement("div");
      thumb.className = "place-thumb";
      const tile = mapTile(place.lat, place.lng);
      const tileImg = document.createElement("img");
      tileImg.className = "place-thumb__tile";
      tileImg.src = tile.url;
      tileImg.alt = "";
      tileImg.style.left = `${tile.offsetX}px`;
      tileImg.style.top = `${tile.offsetY}px`;
      const pin = document.createElement("span");
      pin.className = "place-thumb__pin";
      thumb.append(tileImg, pin);

      const text = document.createElement("div");
      text.className = "place-text";

      const topRow = document.createElement("div");
      topRow.className = "place-toprow";
      const name = document.createElement("h2");
      name.textContent = place.name;
      const distance = document.createElement("span");
      distance.className = "distance";
      distance.textContent = `${place.distanceKm} km`;
      topRow.append(name, distance);

      const meta = document.createElement("p");
      meta.className = "meta";
      const kind = document.createElement("span");
      kind.textContent = KIND_LABELS[place.kind] || place.kind;
      meta.append(kind);

      const reviews = place.placeId ? reviewsByPlaceId.get(place.placeId) || [] : [];
      if (reviews.length) {
        const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
        const stars = document.createElement("span");
        stars.className = "stars";
        stars.textContent = `★ ${avg.toFixed(1)} (${reviews.length})`;
        meta.append(stars);
      }
      if (place.address) {
        const address = document.createElement("span");
        address.textContent = place.address;
        meta.append(address);
      }

      text.append(topRow, meta);
      head.append(thumb, text);
      card.append(head);

      if (expandedKey === keyOf(place)) {
        card.append(renderBody(place, reviews));
      }

      head.addEventListener("click", () => {
        expandedKey = expandedKey === keyOf(place) ? null : keyOf(place);
        renderList();
      });

      return card;
    })
  );
}

function renderBody(place, reviews) {
  const body = document.createElement("div");
  body.className = "place-body";

  const links = document.createElement("div");
  links.className = "place-links";

  // Search by name + coords so Maps resolves to the actual business listing
  // (with its hours, photos and reviews), not a bare dropped pin.
  const onMap = document.createElement("a");
  onMap.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${place.name} ${place.lat},${place.lng}`
  )}`;
  onMap.target = "_blank";
  onMap.rel = "noreferrer";
  onMap.textContent = "Open in Maps";
  links.append(onMap);

  const directions = document.createElement("a");
  directions.href = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  directions.target = "_blank";
  directions.rel = "noreferrer";
  directions.textContent = "Directions";
  links.append(directions);

  if (place.website) {
    const site = document.createElement("a");
    site.href = place.website.startsWith("http") ? place.website : `https://${place.website}`;
    site.target = "_blank";
    site.rel = "noreferrer";
    site.textContent = "Website";
    links.append(site);
  }
  body.append(links);

  for (const review of reviews) {
    const item = document.createElement("div");
    item.className = "review";

    const author = document.createElement("a");
    author.className = "author";
    author.textContent = review.profiles?.display_name || review.profiles?.username || "?";
    author.href = review.profiles?.username ? `/u/${review.profiles.username}` : "#";

    const rating = document.createElement("span");
    rating.className = "rating";
    rating.textContent = "★".repeat(review.rating);

    item.append(author, rating);
    if (review.body) {
      const text = document.createElement("p");
      text.className = "body";
      text.textContent = review.body;
      item.append(text);
    }
    body.append(item);
  }

  if (viewerId) {
    const form = document.createElement("div");
    form.className = "review-form";

    const select = document.createElement("select");
    for (let stars = 5; stars >= 1; stars -= 1) {
      const option = document.createElement("option");
      option.value = String(stars);
      option.textContent = "★".repeat(stars);
      select.append(option);
    }

    const input = document.createElement("input");
    input.placeholder = "Your take (optional)";
    input.maxLength = 1000;

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "primary";
    submit.textContent = reviews.some((r) => r.author_id === viewerId) ? "Update" : "Rate";
    submit.addEventListener("click", () => submitReview(place, Number(select.value), input.value.trim(), submit));

    form.append(select, input, submit);
    body.append(form);
  } else {
    const note = document.createElement("p");
    note.className = "note";
    note.innerHTML = '<a href="/login?next=/places">Sign in</a> to rate this place.';
    body.append(note);
  }

  return body;
}

async function submitReview(place, rating, text, button) {
  button.disabled = true;
  try {
    const placeId = await ensurePlaceRow(place);
    const { error } = await supabase.from("place_reviews").upsert(
      { place_id: placeId, author_id: viewerId, rating, body: text || null },
      { onConflict: "place_id,author_id" }
    );
    if (error) throw error;
    await loadReviews();
    renderList();
  } catch (error) {
    els.status.textContent = error.message || "Could not save the review";
    button.disabled = false;
  }
}

// Reviews need a places row; OSM results get one lazily on first review.
async function ensurePlaceRow(place) {
  if (place.placeId) return place.placeId;

  const row = {
    osm_id: place.osmId,
    added_by: viewerId,
    name: place.name,
    kind: place.kind,
    lat: place.lat,
    lng: place.lng,
    website: place.website || null,
  };
  const { data, error } = await supabase.from("places").insert(row).select("id").single();
  if (!error) {
    place.placeId = data.id;
    return data.id;
  }

  // Someone else created it concurrently — fetch theirs.
  const { data: existing } = await supabase
    .from("places")
    .select("id")
    .eq("osm_id", place.osmId)
    .maybeSingle();
  if (existing) {
    place.placeId = existing.id;
    return existing.id;
  }
  throw error;
}

async function addPlace() {
  const name = els.addName.value.trim();
  if (!name || !center || !viewerId) {
    els.addStatus.textContent = name ? "Search a location first." : "Give it a name.";
    return;
  }

  els.addSubmit.disabled = true;
  els.addStatus.textContent = "Adding…";

  const { error } = await supabase.from("places").insert({
    added_by: viewerId,
    name,
    kind: els.addKind.value,
    lat: center.lat,
    lng: center.lng,
    city: center.label || null,
    website: els.addWebsite.value.trim() || null,
  });

  els.addSubmit.disabled = false;
  if (error) {
    els.addStatus.textContent = error.message;
    return;
  }
  els.addName.value = "";
  els.addWebsite.value = "";
  els.addStatus.textContent = "Added — it's pinned to the searched area.";
  search({ lat: center.lat, lng: center.lng });
}
