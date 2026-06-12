// Creates a record in the caller's collection: verifies the Supabase session
// token, fetches the Discogs release, inserts the row (service role) and
// uploads the cover to Storage. Replaces the old GitHub-commit flow.

const DISCOGS_API = "https://api.discogs.com";
const USER_AGENT = "VinilosShibu/1.0 +https://vynil-collection.vercel.app";
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
    // 1. Verify the caller's session token. owner_id ALWAYS comes from the
    //    verified JWT — this function writes with the service role, which
    //    bypasses RLS, so the body is never trusted for identity.
    const accessToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return res.status(401).json({ error: "Sign in to add records" });
    }

    const user = await verifyUser(accessToken);
    if (!user) {
      return res.status(401).json({ error: "Session expired — sign in again" });
    }

    const profile = await restFetch(`/rest/v1/profiles?id=eq.${user.id}&select=id,username,display_name`);
    if (!profile.length) {
      return res.status(403).json({ error: "Create your profile first" });
    }

    const { releaseId, barcode, coverCondition, discCondition, comment } = req.body || {};
    if (!releaseId) {
      return res.status(400).json({ error: "releaseId is required" });
    }

    // 2. Duplicate check within this collection.
    const existing = await restFetch(
      `/rest/v1/records?owner_id=eq.${user.id}&discogs_release_id=eq.${encodeURIComponent(releaseId)}&select=position,artist,title`
    );
    if (existing.length && !req.body.allowDuplicate) {
      const dup = existing[0];
      return res.status(409).json({
        error: "duplicate",
        message: `Already in your collection as #${dup.position}: ${dup.artist} - ${dup.title}`,
      });
    }

    const countRows = await restFetch(`/rest/v1/records?owner_id=eq.${user.id}&select=position&order=position.desc&limit=1`);
    const recordCount = await countRecords(user.id);
    if (recordCount >= MAX_RECORDS_PER_COLLECTION) {
      return res.status(403).json({ error: `Collection limit reached (${MAX_RECORDS_PER_COLLECTION} records)` });
    }

    // 3. Discogs release + cover (must be server-side: token + UA headers).
    const release = await discogsFetch(`/releases/${encodeURIComponent(releaseId)}`);
    const cover = await downloadCover(release);

    // 4. Insert with position = max + 1, retrying once if a concurrent add
    //    grabbed the same position (unique owner_id+position constraint).
    let position = (countRows[0]?.position || 0) + 1;
    let row = null;
    for (let attempt = 0; attempt < 2 && !row; attempt += 1) {
      const insert = await restInsert("/rest/v1/records", buildRow({
        ownerId: user.id,
        position,
        release,
        barcode,
        coverCondition,
        discCondition,
        comment,
      }));
      if (insert.ok) {
        row = insert.data;
      } else if (insert.status === 409) {
        position += 1;
      } else {
        throw new Error(insert.error);
      }
    }
    if (!row) {
      throw new Error("Could not allocate a collection number, try again");
    }

    // 5. Cover to Storage (public bucket `covers`); the record survives
    //    coverless if this fails.
    let coverPath = null;
    if (cover && cover.length <= MAX_COVER_BYTES) {
      coverPath = `${user.id}/${row.id}.jpg`;
      const uploaded = await uploadCover(coverPath, cover);
      if (uploaded) {
        await restPatch(`/rest/v1/records?id=eq.${row.id}`, { cover_path: coverPath });
      } else {
        coverPath = null;
      }
    }

    return res.status(200).json({
      ok: true,
      record: {
        position: row.position,
        artist: row.artist,
        title: row.title,
        year: row.year,
        coverPath,
      },
      collection: `/u/${profile[0].username}`,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to add record" });
  }
}

function buildRow({ ownerId, position, release, barcode, coverCondition, discCondition, comment }) {
  const artist = formatArtists(release.artists, release.artists_sort);
  const title = String(release.title || "").trim();
  const labels = release.labels || [];
  const genres = release.genres || [];
  const styles = release.styles || [];
  const releaseUrl = release.uri || `https://www.discogs.com/release/${release.id}`;

  return {
    owner_id: ownerId,
    position,
    artist,
    title,
    year: Number.parseInt(release.year, 10) || null,
    label: labels[0]?.name || "",
    catalog_number: labels[0]?.catno || "",
    country: release.country || "",
    cover_condition: String(coverCondition || "VG+"),
    disc_condition: String(discCondition || "VG+"),
    barcode: barcode ? String(barcode) : null,
    comment: comment ? String(comment) : null,
    genres,
    styles,
    formats: flattenFormats(release.formats),
    tracklist: normalizeTracklist(release.tracklist || []),
    discogs_release_id: String(release.id),
    discogs_url: releaseUrl,
    search_text: normalizeText(
      [artist, title, release.year || "", genres.join(" / "), labels[0]?.name || "", labels[0]?.catno || "", release.country || "", comment || ""].join(" ")
    ),
    added_via: "barcode-scan",
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
  if (!response.ok) {
    return null;
  }
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

async function countRecords(ownerId) {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/records?owner_id=eq.${ownerId}&select=id`,
    { headers: serviceHeaders({ Prefer: "count=exact", Range: "0-0" }) }
  );
  const range = response.headers.get("content-range") || "/0";
  return Number.parseInt(range.split("/")[1], 10) || 0;
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

// --- Discogs helpers (ported from the legacy api/add.js) --------------------

async function discogsFetch(path) {
  const response = await fetch(`${DISCOGS_API}${path}`, {
    headers: {
      Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Discogs responded ${response.status}`);
  }
  return response.json();
}

async function downloadCover(release) {
  const images = release.images || [];
  const primary = images.find((image) => image.type === "primary") || images[0];
  const url = primary?.uri;
  if (!url) return null;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}`,
    },
  });
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length ? buffer : null;
}

function formatArtists(artists, fallback) {
  if (Array.isArray(artists) && artists.length) {
    const names = artists
      .map((artist) => String(artist.name || "").replace(/\s*\(\d+\)$/, ""))
      .filter(Boolean);
    return [...new Set(names)].join(" / ");
  }
  return String(fallback || "").replace(/\s*\(\d+\)$/, "");
}

function flattenFormats(formats) {
  const names = new Set();
  for (const format of formats || []) {
    if (format.name) names.add(format.name);
    for (const description of format.descriptions || []) names.add(description);
  }
  return [...names];
}

function normalizeTracklist(entries) {
  const tracks = [];
  let currentHeading = "";

  for (const entry of entries) {
    const entryType = String(entry.type_ || "track");
    const title = String(entry.title || "").trim();

    if (entryType === "heading") {
      currentHeading = title;
      continue;
    }

    if (entryType === "index" && Array.isArray(entry.sub_tracks)) {
      const groupHeading = title || currentHeading;
      for (const subTrack of entry.sub_tracks) {
        tracks.push({
          position: String(subTrack.position || "").trim(),
          title: String(subTrack.title || "").trim(),
          duration: String(subTrack.duration || "").trim(),
          heading: groupHeading,
        });
      }
      continue;
    }

    tracks.push({
      position: String(entry.position || "").trim(),
      title,
      duration: String(entry.duration || "").trim(),
      heading: currentHeading,
    });
  }

  return tracks;
}

function normalizeText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
