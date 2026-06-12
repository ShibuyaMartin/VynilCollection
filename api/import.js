// Imports a Discogs collection page by page. Each call handles one page
// (25 releases) so the client can drive a progress loop without hitting
// function timeouts. Rows are built from the collection's basic_information
// — no per-release fetches — so a 300-record import costs ~12 Discogs
// requests instead of 300. Tracklists stay empty; "Replace edition" can
// backfill any record worth enriching.

const DISCOGS_API = "https://api.discogs.com";
const USER_AGENT = "Deadwax/1.0";
const PER_PAGE = 25;
const MAX_RECORDS_PER_COLLECTION = 500;
const MAX_COVER_BYTES = 2 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DISCOGS_TOKEN"].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  try {
    const accessToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return res.status(401).json({ error: "Sign in first" });
    }
    const user = await verifyUser(accessToken);
    if (!user) {
      return res.status(401).json({ error: "Session expired — sign in again" });
    }

    const discogsUsername = String(req.body?.discogsUsername || "").trim();
    if (!/^[\w.-]{1,60}$/.test(discogsUsername)) {
      return res.status(400).json({ error: "Enter your Discogs username" });
    }
    const page = Math.max(1, Number.parseInt(req.body?.page, 10) || 1);

    // One Discogs request for the whole page.
    const collection = await fetch(
      `${DISCOGS_API}/users/${encodeURIComponent(discogsUsername)}/collection/folders/0/releases?page=${page}&per_page=${PER_PAGE}&sort=added&sort_order=asc`,
      {
        headers: {
          Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}`,
          "User-Agent": USER_AGENT,
        },
      }
    );
    if (collection.status === 404) {
      return res.status(404).json({ error: `Discogs user "${discogsUsername}" not found` });
    }
    if (collection.status === 403) {
      return res.status(403).json({
        error: "That Discogs collection is private — make it public in Discogs settings (Privacy) and retry",
      });
    }
    if (!collection.ok) {
      throw new Error(`Discogs responded ${collection.status}`);
    }
    const payload = await collection.json();
    const items = payload.releases || [];
    const pages = payload.pagination?.pages || 1;
    const totalItems = payload.pagination?.items || items.length;

    // What this user already has, to skip duplicates idempotently.
    const existing = await restFetch(
      `/rest/v1/records?owner_id=eq.${user.id}&select=discogs_release_id,position&limit=1000`
    );
    const ownedIds = new Set(existing.map((row) => row.discogs_release_id).filter(Boolean));
    let recordCount = existing.length;
    let position = existing.reduce((max, row) => Math.max(max, row.position || 0), 0) + 1;

    let imported = 0;
    let skipped = 0;
    let capped = false;

    for (const item of items) {
      const info = item.basic_information;
      if (!info?.id) continue;
      if (ownedIds.has(String(info.id))) {
        skipped += 1;
        continue;
      }
      if (recordCount >= MAX_RECORDS_PER_COLLECTION) {
        capped = true;
        break;
      }

      const row = buildRowFromBasicInfo(user.id, position, info, item.notes);
      let inserted = null;
      for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
        const result = await restInsert("/rest/v1/records", { ...row, position });
        if (result.ok) {
          inserted = result.data;
        } else if (result.status === 409) {
          position += 1;
        } else {
          throw new Error(result.error);
        }
      }
      if (!inserted) continue;

      position += 1;
      recordCount += 1;
      imported += 1;
      ownedIds.add(String(info.id));

      // Cover is best-effort; the record stays without one if this fails.
      const cover = await downloadImage(info.cover_image);
      if (cover && cover.length <= MAX_COVER_BYTES) {
        const coverPath = `${user.id}/${inserted.id}.jpg`;
        if (await uploadCover(coverPath, cover)) {
          await restPatch(`/rest/v1/records?id=eq.${inserted.id}`, { cover_path: coverPath });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      page,
      pages,
      totalItems,
      imported,
      skipped,
      capped,
      collectionCount: recordCount,
      done: capped || page >= pages,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Import failed" });
  }
}

function buildRowFromBasicInfo(ownerId, position, info, notes) {
  const artist = formatArtists(info.artists);
  const title = String(info.title || "").trim();
  const labels = info.labels || [];
  const genres = info.genres || [];
  const styles = info.styles || [];

  // Discogs collection notes are [{field_id, value}]; field 3 is the
  // standard free-text Notes field.
  const comment = Array.isArray(notes)
    ? String(notes.find((note) => note.field_id === 3)?.value || "").trim() || null
    : null;

  return {
    owner_id: ownerId,
    position,
    artist,
    title,
    year: Number.parseInt(info.year, 10) || null,
    label: labels[0]?.name || "",
    catalog_number: labels[0]?.catno || "",
    country: "",
    cover_condition: "VG+",
    disc_condition: "VG+",
    barcode: null,
    comment,
    genres,
    styles,
    formats: flattenFormats(info.formats),
    tracklist: [],
    discogs_release_id: String(info.id),
    discogs_url: `https://www.discogs.com/release/${info.id}`,
    search_text: normalizeText(
      [artist, title, info.year || "", genres.join(" / "), labels[0]?.name || "", labels[0]?.catno || ""].join(" ")
    ),
    added_via: "discogs-import",
  };
}

// --- Supabase helpers (raw REST, service role) -------------------------------

async function verifyUser(accessToken) {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? user : null;
}

function serviceHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function restFetch(path) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, { headers: serviceHeaders() });
  if (!response.ok) {
    throw new Error(`Supabase ${path.split("?")[0]} responded ${response.status}`);
  }
  return response.json();
}

async function restInsert(path, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method: "POST",
    headers: serviceHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: `Supabase insert responded ${response.status}: ${text.slice(0, 200)}` };
  }
  const rows = await response.json();
  return { ok: true, data: rows[0] };
}

async function restPatch(path, body) {
  await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method: "PATCH",
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  });
}

async function uploadCover(path, buffer) {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/covers/${path}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "true",
    },
    body: buffer,
  });
  return response.ok;
}

// --- Discogs helpers ----------------------------------------------------------

async function downloadImage(url) {
  if (!url || url.includes("spacer.gif")) return null;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

function formatArtists(artists) {
  if (Array.isArray(artists) && artists.length) {
    const names = artists
      .map((artist) => String(artist.name || "").replace(/\s*\(\d+\)$/, ""))
      .filter(Boolean);
    return [...new Set(names)].join(" / ");
  }
  return "";
}

function flattenFormats(formats) {
  const names = new Set();
  for (const format of formats || []) {
    if (format.name) names.add(format.name);
    for (const description of format.descriptions || []) names.add(description);
  }
  return [...names];
}

function normalizeText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
