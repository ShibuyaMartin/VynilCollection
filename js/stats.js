// Collection stats: acquisition heatmap, decades, top artists/genres/styles
// and the genre mosaic. Everything is hand-rolled SVG/CSS — no chart library.

import { supabase, coverPublicUrl } from "/js/supabase-client.js";

const root = document.getElementById("boards-root");
const titleEl = document.getElementById("page-title");
const subEl = document.getElementById("page-sub");
const backLink = document.getElementById("back-link");

const username = (window.location.pathname.match(/^\/u\/([a-z0-9-]+)\/stats\/?$/) || [])[1];

init().catch((error) => {
  console.error(error);
  root.innerHTML = '<p class="status">Could not load stats. Try reloading.</p>';
});

async function init() {
  if (!username) {
    root.innerHTML = '<p class="status">Unknown collection.</p>';
    return;
  }

  backLink.href = `/u/${username}`;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .eq("username", username)
    .maybeSingle();

  if (!profile) {
    root.innerHTML = '<p class="status">Collection not found.</p>';
    return;
  }

  const { data: rows, error } = await supabase
    .from("records")
    .select("artist, genres, styles, year, created_at, cover_path")
    .eq("owner_id", profile.id)
    .limit(1000);

  if (error) {
    throw error;
  }

  const records = rows || [];
  const ownerName = profile.display_name || profile.username;
  document.title = `${ownerName} · Stats — Deadwax`;
  titleEl.textContent = `${ownerName} · Stats`;
  subEl.textContent = `@${profile.username} · ${records.length} record${records.length === 1 ? "" : "s"}`;

  if (!records.length) {
    root.innerHTML = '<p class="status">No records yet — nothing to count.</p>';
    return;
  }

  const boards = document.createElement("div");
  boards.className = "boards";
  boards.append(
    board("Records added", renderHeatmap(records), "wide"),
    board("By release decade", renderDecades(records), "wide"),
    board("Top artists", renderBars(tally(records, (r) => [cleanArtist(r.artist)]), 10),),
    board("Top genres", renderBars(tally(records, (r) => listOf(r.genres)), 10)),
    board("Top styles", renderBars(tally(records, (r) => listOf(r.styles)), 10)),
    board("The blend", renderMosaic(records)),
  );
  root.replaceChildren(boards);
}

function board(title, content, modifier) {
  const section = document.createElement("section");
  section.className = `board${modifier ? ` board--${modifier}` : ""}`;
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading, content);
  return section;
}

// --- Tallies -----------------------------------------------------------------

function listOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/\s*[,;]\s*/);
  return [];
}

function cleanArtist(artist) {
  // Discogs disambiguates duplicates as "Name (2)".
  return String(artist || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

function tally(records, pick) {
  const counts = new Map();
  for (const record of records) {
    for (const key of pick(record)) {
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// --- Horizontal bars ---------------------------------------------------------

function renderBars(entries, limit) {
  const top = entries.slice(0, limit);
  const wrap = document.createElement("div");
  wrap.className = "bars";

  if (!top.length) {
    wrap.innerHTML = '<p class="status">No data.</p>';
    return wrap;
  }

  const max = top[0][1];
  for (const [label, count] of top) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const name = document.createElement("span");
    name.className = "label";
    name.textContent = label;
    name.title = label;

    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${Math.max(2, Math.round((count / max) * 100))}%`;
    track.append(fill);

    const value = document.createElement("span");
    value.className = "count";
    value.textContent = String(count);

    row.append(name, track, value);
    wrap.append(row);
  }
  return wrap;
}

// --- Decades -----------------------------------------------------------------

function renderDecades(records) {
  const byDecade = new Map();
  let unknown = 0;
  for (const record of records) {
    const year = Number(record.year);
    if (!year || year < 1900) {
      unknown += 1;
      continue;
    }
    const decade = Math.floor(year / 10) * 10;
    byDecade.set(decade, (byDecade.get(decade) || 0) + 1);
  }

  const wrap = document.createElement("div");
  if (!byDecade.size) {
    wrap.innerHTML = '<p class="status">No release years on file.</p>';
    return wrap;
  }

  const decades = [...byDecade.keys()];
  const start = Math.min(...decades);
  const end = Math.max(...decades);
  const max = Math.max(...byDecade.values());

  const chart = document.createElement("div");
  chart.className = "columns";
  for (let decade = start; decade <= end; decade += 10) {
    const count = byDecade.get(decade) || 0;
    const column = document.createElement("div");
    column.className = `column${count ? "" : " is-empty"}`;

    const value = document.createElement("span");
    value.className = "value";
    value.textContent = count ? String(count) : "";

    const pillar = document.createElement("div");
    pillar.className = "pillar";
    pillar.style.height = `${count ? Math.max(2, Math.round((count / max) * 100)) : 1}%`;

    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = `${String(decade).slice(2)}s`;

    column.append(value, pillar, tick);
    chart.append(column);
  }
  wrap.append(chart);

  if (unknown) {
    const note = document.createElement("p");
    note.className = "heatmap-note";
    note.textContent = `${unknown} record${unknown === 1 ? "" : "s"} without a release year`;
    wrap.append(note);
  }
  return wrap;
}

// --- Acquisition heatmap (GitHub-style, last 12 months) -----------------------

function renderHeatmap(records) {
  const perDay = new Map();
  for (const record of records) {
    const day = String(record.created_at || "").slice(0, 10);
    if (day) perDay.set(day, (perDay.get(day) || 0) + 1);
  }

  const CELL = 11;
  const GAP = 2;
  const today = new Date();
  // Last day of the current week (Saturday) so today's column is complete.
  const gridEnd = new Date(today);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));
  const WEEKS = 53;
  const gridStart = new Date(gridEnd);
  gridStart.setDate(gridStart.getDate() - (WEEKS * 7 - 1));

  const width = WEEKS * (CELL + GAP) + 24;
  const height = 7 * (CELL + GAP) + 18;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const shade = (count) => {
    if (!count) return "rgba(255,255,255,0.06)";
    if (count <= 2) return "rgba(243,237,227,0.28)";
    if (count <= 5) return "rgba(243,237,227,0.52)";
    if (count <= 9) return "rgba(243,237,227,0.76)";
    return "#f3ede3";
  };

  const cursor = new Date(gridStart);
  let lastMonth = -1;
  let total = 0;
  for (let week = 0; week < WEEKS; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      if (cursor > today) break;
      const iso = cursor.toISOString().slice(0, 10);
      const count = perDay.get(iso) || 0;
      total += count;

      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", String(week * (CELL + GAP)));
      rect.setAttribute("y", String(14 + day * (CELL + GAP)));
      rect.setAttribute("width", String(CELL));
      rect.setAttribute("height", String(CELL));
      rect.setAttribute("fill", shade(count));
      if (count) {
        const tip = document.createElementNS(svgNS, "title");
        tip.textContent = `${iso} — ${count} record${count === 1 ? "" : "s"}`;
        rect.append(tip);
      }
      svg.append(rect);

      if (day === 0 && cursor.getMonth() !== lastMonth) {
        lastMonth = cursor.getMonth();
        const label = document.createElementNS(svgNS, "text");
        label.setAttribute("x", String(week * (CELL + GAP)));
        label.setAttribute("y", "9");
        label.setAttribute("fill", "rgba(243,237,227,0.42)");
        label.setAttribute("font-family", "Geist Mono, monospace");
        label.setAttribute("font-size", "8.5");
        label.setAttribute("letter-spacing", "0.5");
        label.textContent = cursor.toLocaleString("en", { month: "short" }).toUpperCase();
        svg.append(label);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const wrap = document.createElement("div");
  const scroll = document.createElement("div");
  scroll.className = "heatmap-scroll";
  scroll.append(svg);
  // Start scrolled to the present.
  requestAnimationFrame(() => {
    scroll.scrollLeft = scroll.scrollWidth;
  });

  const note = document.createElement("p");
  note.className = "heatmap-note";
  note.textContent = `${total} added in the last 12 months`;

  wrap.append(scroll, note);
  return wrap;
}

// --- Genre mosaic --------------------------------------------------------------

function renderMosaic(records) {
  const entries = tally(records, (r) => listOf(r.genres));
  const wrap = document.createElement("div");
  if (!entries.length) {
    wrap.innerHTML = '<p class="status">No genres on file.</p>';
    return wrap;
  }

  // Only the top genres, normalized among themselves — a long tail of
  // one-off genres would otherwise swallow the picture.
  const MAX_TILES = 9;
  const top = entries.slice(0, MAX_TILES);
  const total = top.reduce((sum, [, count]) => sum + count, 0);

  // One representative cover per genre, each a different record so the
  // mosaic doesn't repeat covers when one release spans several genres.
  const coverFor = new Map();
  const usedCovers = new Set();
  for (const [genre] of top) {
    for (const record of records) {
      if (!record.cover_path || usedCovers.has(record.cover_path)) continue;
      if (!listOf(record.genres).includes(genre)) continue;
      coverFor.set(genre, record.cover_path);
      usedCovers.add(record.cover_path);
      break;
    }
  }

  const mosaic = document.createElement("div");
  mosaic.className = "mosaic";

  // Recursive split treemap: divide the weight in two roughly equal halves,
  // split the rectangle along its longer side, recurse.
  const place = (items, x, y, w, h) => {
    if (!items.length) return;
    if (items.length === 1) {
      const [genre, count] = items[0];
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.style.left = `${x}%`;
      tile.style.top = `${y}%`;
      tile.style.width = `${w}%`;
      tile.style.height = `${h}%`;
      const cover = coverFor.get(genre);
      if (cover) tile.style.backgroundImage = `url("${coverPublicUrl(cover)}")`;
      const label = document.createElement("span");
      label.textContent = `${genre} ${Math.round((count / total) * 100)}%`;
      tile.append(label);
      mosaic.append(tile);
      return;
    }

    const sum = items.reduce((acc, [, count]) => acc + count, 0);
    let split = 1;
    let acc = items[0][1];
    while (split < items.length - 1 && acc + items[split][1] <= sum / 2) {
      acc += items[split][1];
      split += 1;
    }
    const first = items.slice(0, split);
    const second = items.slice(split);
    const ratio = acc / sum;

    if (w >= h) {
      place(first, x, y, w * ratio, h);
      place(second, x + w * ratio, y, w * (1 - ratio), h);
    } else {
      place(first, x, y, w, h * ratio);
      place(second, x, y + h * ratio, w, h * (1 - ratio));
    }
  };
  place(top, 0, 0, 100, 100);

  const note = document.createElement("p");
  note.className = "mosaic-note";
  note.textContent = `Top ${top.length} genres as one cover — area = share among them`;

  wrap.append(mosaic, note);
  return wrap;
}
