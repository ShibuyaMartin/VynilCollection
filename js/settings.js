// Settings: profile (avatar, name, username, bio), a collection summary,
// the wantlist, and sign out. Profile fields update straight through RLS;
// the avatar goes via /api/avatar (service-role upload).

import { supabase, avatarPublicUrl } from "/js/supabase-client.js";
import { requireSession, getOwnProfile, signOut } from "/js/auth.js";

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;
const PRIORITY_LABELS = { 1: "High", 2: "Medium", 3: "Low" };

const root = document.getElementById("settings-root");
let session = null;
let profile = null;
let els = {};

init().catch((error) => {
  console.error(error);
  root.innerHTML = '<p class="status">Could not load settings. Try reloading.</p>';
});

async function init() {
  session = await requireSession("/settings");
  if (!session) return;

  profile = await getOwnProfile();
  if (!profile) {
    window.location.replace("/login?next=/settings");
    return;
  }

  document.getElementById("collection-link").href = `/u/${profile.username}`;

  // Mount the template.
  const tpl = document.getElementById("settings-template");
  root.replaceChildren(tpl.content.cloneNode(true));
  els = {
    avatar: document.getElementById("avatar"),
    avatarButton: document.getElementById("avatar-button"),
    avatarInput: document.getElementById("avatar-input"),
    avatarNote: document.getElementById("avatar-note"),
    displayName: document.getElementById("display-name"),
    username: document.getElementById("username"),
    bio: document.getElementById("bio"),
    roles: document.getElementById("roles"),
    city: document.getElementById("city"),
    openToOffers: document.getElementById("open-to-offers"),
    linkInstagram: document.getElementById("link-instagram"),
    linkSoundcloud: document.getElementById("link-soundcloud"),
    linkWebsite: document.getElementById("link-website"),
    saveProfile: document.getElementById("save-profile"),
    profileNote: document.getElementById("profile-note"),
    statRecords: document.getElementById("stat-records"),
    statGenre: document.getElementById("stat-genre"),
    statFollowers: document.getElementById("stat-followers"),
    statsLink: document.getElementById("stats-link"),
    wantForm: document.getElementById("want-search-form"),
    wantSearch: document.getElementById("want-search"),
    wantResults: document.getElementById("want-results"),
    wantList: document.getElementById("want-list"),
    wantNote: document.getElementById("want-note"),
    accountEmail: document.getElementById("account-email"),
    signOut: document.getElementById("sign-out"),
  };

  paintProfile();
  bindProfile();
  bindWantlist();
  els.signOut.addEventListener("click", async () => {
    await signOut();
    window.location.assign("/");
  });
  els.accountEmail.textContent = session.user.email || "Signed in";

  loadSummary();
  loadWantlist();
}

// --- Profile -----------------------------------------------------------------

function paintProfile() {
  els.displayName.value = profile.display_name || "";
  els.username.value = profile.username || "";
  els.bio.value = profile.bio || "";
  els.city.value = profile.city || "";
  els.openToOffers.checked = Boolean(profile.open_to_offers);
  els.linkInstagram.value = profile.link_instagram || "";
  els.linkSoundcloud.value = profile.link_soundcloud || "";
  els.linkWebsite.value = profile.link_website || "";
  const roles = new Set(profile.roles || []);
  for (const chip of els.roles.querySelectorAll(".role-chip")) {
    chip.classList.toggle("is-on", roles.has(chip.dataset.role));
  }
  els.statsLink.href = `/u/${profile.username}/stats`;
  paintAvatar();
}

function paintAvatar() {
  els.avatar.replaceChildren();
  if (profile.avatar_path) {
    const img = document.createElement("img");
    img.src = avatarPublicUrl(profile.avatar_path);
    img.alt = "";
    els.avatar.append(img);
  } else {
    els.avatar.textContent = (profile.display_name || profile.username || "?").charAt(0).toUpperCase();
  }
}

function bindProfile() {
  els.avatarButton.addEventListener("click", () => els.avatarInput.click());
  els.avatarInput.addEventListener("change", () => {
    const file = els.avatarInput.files?.[0];
    if (file) uploadAvatar(file);
  });

  els.roles.addEventListener("click", (event) => {
    const chip = event.target.closest(".role-chip");
    if (chip) chip.classList.toggle("is-on");
  });

  els.saveProfile.addEventListener("click", saveProfile);
}

function selectedRoles() {
  return [...els.roles.querySelectorAll(".role-chip.is-on")].map((chip) => chip.dataset.role);
}

async function saveProfile() {
  const displayName = els.displayName.value.trim();
  const username = els.username.value.trim().toLowerCase();
  const bio = els.bio.value.trim();

  if (!USERNAME_RE.test(username)) {
    els.profileNote.className = "note";
    els.profileNote.textContent = "Username: 3–30 chars, lowercase letters, numbers and dashes.";
    return;
  }

  els.saveProfile.disabled = true;
  els.profileNote.className = "note";
  els.profileNote.textContent = "Saving…";

  const patch = {
    display_name: displayName,
    username,
    bio,
    roles: selectedRoles(),
    city: els.city.value.trim(),
    open_to_offers: els.openToOffers.checked,
    link_instagram: els.linkInstagram.value.trim(),
    link_soundcloud: els.linkSoundcloud.value.trim(),
    link_website: els.linkWebsite.value.trim(),
  };

  const { error } = await supabase.from("profiles").update(patch).eq("id", profile.id);

  els.saveProfile.disabled = false;
  if (error) {
    els.profileNote.textContent =
      error.code === "23505" ? "That username is taken." : error.message || "Could not save.";
    return;
  }

  const usernameChanged = username !== profile.username;
  profile = { ...profile, ...patch };
  paintAvatar();
  els.statsLink.href = `/u/${profile.username}/stats`;
  document.getElementById("collection-link").href = `/u/${profile.username}`;
  els.profileNote.className = "note ok";
  els.profileNote.textContent = usernameChanged ? `Saved — your page is now /u/${username}` : "Saved.";
}

async function uploadAvatar(file) {
  els.avatarNote.className = "note";
  els.avatarNote.textContent = "Optimizing…";

  let dataUrl;
  try {
    dataUrl = await downscaleToDataUrl(file, 512);
  } catch {
    els.avatarNote.textContent = "Couldn't read that image.";
    return;
  }

  els.avatarNote.textContent = "Uploading…";
  try {
    const response = await fetch("/api/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ image: dataUrl }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Upload failed");
    profile.avatar_path = payload.avatarPath;
    paintAvatar();
    els.avatarNote.className = "note ok";
    els.avatarNote.textContent = "Avatar updated.";
  } catch (error) {
    els.avatarNote.textContent = error.message || "Upload failed.";
  }
}

// Draw the image onto a canvas capped at `max` px and export a JPEG data URL,
// so a phone photo uploads as a small square instead of several MB.
function downscaleToDataUrl(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const size = Math.min(max, side);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Collection summary ------------------------------------------------------

async function loadSummary() {
  const [{ count: records }, { data: rows }, { count: followers }] = await Promise.all([
    supabase.from("records").select("id", { count: "exact", head: true }).eq("owner_id", profile.id),
    supabase.from("records").select("genres").eq("owner_id", profile.id).limit(1000),
    supabase.from("follows").select("follower_id", { count: "exact", head: true }).eq("following_id", profile.id),
  ]);

  els.statRecords.textContent = records ?? 0;
  els.statFollowers.textContent = followers ?? 0;

  const tally = new Map();
  for (const row of rows || []) {
    for (const genre of row.genres || []) tally.set(genre, (tally.get(genre) || 0) + 1);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  els.statGenre.textContent = top ? top[0] : "—";
  els.statGenre.style.fontSize = top ? "1rem" : "";
}

// --- Wantlist ----------------------------------------------------------------

function bindWantlist() {
  els.wantForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchWant();
  });

  els.wantResults.addEventListener("click", (event) => {
    const card = event.target.closest("[data-add-release]");
    if (card) addWant(JSON.parse(card.dataset.addRelease));
  });
}

async function searchWant() {
  const query = els.wantSearch.value.trim();
  if (!query) return;
  els.wantResults.innerHTML = '<p class="status">Searching…</p>';

  try {
    const response = await fetch(`/api/lookup?q=${encodeURIComponent(query)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Search failed");
    renderWantResults(payload.candidates || []);
  } catch (error) {
    els.wantResults.innerHTML = "";
    els.wantNote.textContent = error.message || "Search failed";
  }
}

function renderWantResults(candidates) {
  if (!candidates.length) {
    els.wantResults.innerHTML = '<p class="status">No matches.</p>';
    return;
  }
  els.wantResults.replaceChildren(
    ...candidates.slice(0, 6).map((c) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "want-item";
      card.dataset.addRelease = JSON.stringify({
        releaseId: c.releaseId,
        title: c.title,
        year: c.year,
        url: c.discogsUrl,
        cover: c.thumb || c.coverImage || "",
      });

      const img = document.createElement("img");
      img.src = c.thumb || c.coverImage || "";
      img.alt = "";
      const meta = document.createElement("span");
      meta.className = "meta";
      const title = document.createElement("strong");
      title.textContent = c.title;
      const sub = document.createElement("span");
      sub.textContent = [c.year, c.country, (c.formats || []).join(", ")].filter(Boolean).join(" · ");
      meta.append(title, sub);
      const add = document.createElement("span");
      add.className = "priority-tag";
      add.textContent = "+ Want";

      card.append(img, meta, add);
      return card;
    })
  );
}

async function addWant(item) {
  els.wantNote.textContent = "";
  const { error } = await supabase.from("wishlist").insert({
    owner_id: profile.id,
    artist: "",
    title: item.title,
    year: Number.parseInt(item.year, 10) || null,
    discogs_release_id: String(item.releaseId),
    discogs_url: item.url || "",
    cover_image: item.cover || "",
  });
  if (error) {
    els.wantNote.textContent = error.message || "Could not add.";
    return;
  }
  els.wantResults.replaceChildren();
  els.wantSearch.value = "";
  loadWantlist();
}

async function loadWantlist() {
  const { data } = await supabase
    .from("wishlist")
    .select("id, title, year, discogs_url, cover_image, priority, max_price")
    .eq("owner_id", profile.id)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false });

  const items = data || [];
  if (!items.length) {
    els.wantList.innerHTML = '<p class="status">Nothing on your wantlist yet.</p>';
    return;
  }

  els.wantList.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("div");
      row.className = "want-item";

      const img = document.createElement("img");
      img.src = item.cover_image || "";
      img.alt = "";
      img.loading = "lazy";

      const meta = document.createElement("a");
      meta.className = "meta";
      meta.href = item.discogs_url || "#";
      meta.target = "_blank";
      meta.rel = "noreferrer";
      meta.style.textDecoration = "none";
      meta.style.color = "inherit";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const sub = document.createElement("span");
      sub.textContent = item.year ? String(item.year) : "";
      meta.append(title, sub);

      const controls = document.createElement("div");
      controls.className = "controls";

      const priority = document.createElement("select");
      for (const p of [1, 2, 3]) {
        const opt = document.createElement("option");
        opt.value = String(p);
        opt.textContent = PRIORITY_LABELS[p];
        if (p === item.priority) opt.selected = true;
        priority.append(opt);
      }
      priority.addEventListener("change", () => updateWant(item.id, { priority: Number(priority.value) }));

      const price = document.createElement("input");
      price.className = "price";
      price.type = "number";
      price.min = "0";
      price.placeholder = "Max $";
      if (item.max_price != null) price.value = item.max_price;
      price.addEventListener("change", () =>
        updateWant(item.id, { max_price: price.value === "" ? null : Number(price.value) })
      );

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.addEventListener("click", () => removeWant(item.id));

      controls.append(priority, price, remove);
      row.append(img, meta, controls);
      return row;
    })
  );
}

async function updateWant(id, patch) {
  await supabase.from("wishlist").update(patch).eq("id", id);
}

async function removeWant(id) {
  await supabase.from("wishlist").delete().eq("id", id);
  loadWantlist();
}
