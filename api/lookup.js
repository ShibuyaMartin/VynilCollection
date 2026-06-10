const DISCOGS_API = "https://api.discogs.com";
const USER_AGENT = "VinilosShibu/1.0 +https://vynil-collection.vercel.app";

export default async function handler(req, res) {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "DISCOGS_TOKEN is not configured" });
  }

  const { barcode, q, release } = req.query;

  try {
    if (release) {
      const details = await discogsFetch(`/releases/${encodeURIComponent(release)}`, token);
      return cacheable(res).status(200).json({ release: normalizeRelease(details) });
    }

    if (barcode) {
      const candidates = await searchByBarcode(String(barcode), token);
      return cacheable(res).status(200).json({ candidates });
    }

    if (q) {
      const data = await discogsFetch(
        `/database/search?${new URLSearchParams({
          q: String(q),
          type: "release",
          format: "Vinyl",
          per_page: "12",
        })}`,
        token
      );
      return cacheable(res).status(200).json({ candidates: normalizeCandidates(data) });
    }

    return res.status(400).json({ error: "Pass ?barcode=, ?q= or ?release=" });
  } catch (error) {
    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({ error: error.message || "Discogs lookup failed" });
  }
}

async function searchByBarcode(rawBarcode, token) {
  const digits = rawBarcode.replace(/\D/g, "");
  const variants = [digits];
  // Discogs stores some barcodes as UPC-A (12) and some as EAN-13 (13, leading 0).
  if (digits.length === 13 && digits.startsWith("0")) variants.push(digits.slice(1));
  if (digits.length === 12) variants.push(`0${digits}`);

  for (const variant of variants) {
    const data = await discogsFetch(
      `/database/search?${new URLSearchParams({
        barcode: variant,
        type: "release",
        per_page: "12",
      })}`,
      token
    );
    const candidates = normalizeCandidates(data);
    if (candidates.length) return candidates;
  }
  return [];
}

function normalizeCandidates(data) {
  return (data.results || []).map((result) => ({
    releaseId: result.id,
    title: result.title || "",
    year: result.year || "",
    country: result.country || "",
    label: Array.isArray(result.label) ? result.label[0] || "" : "",
    catalogNumber: result.catno || "",
    formats: result.format || [],
    genres: result.genre || [],
    styles: result.style || [],
    thumb: result.thumb || "",
    coverImage: result.cover_image || "",
    discogsUrl: result.id ? `https://www.discogs.com/release/${result.id}` : "",
  }));
}

function normalizeRelease(release) {
  const labels = release.labels || [];
  return {
    releaseId: release.id,
    artist: formatArtists(release.artists, release.artists_sort),
    title: release.title || "",
    year: release.year ? String(release.year) : "",
    country: release.country || "",
    label: labels[0]?.name || "",
    catalogNumber: labels[0]?.catno || "",
    genres: release.genres || [],
    styles: release.styles || [],
    formats: flattenFormats(release.formats),
    coverImage: pickImage(release.images),
    discogsUrl: release.uri || `https://www.discogs.com/release/${release.id}`,
    tracklist: normalizeTracklist(release.tracklist || []),
  };
}

function formatArtists(artists, fallback) {
  if (Array.isArray(artists) && artists.length) {
    return artists
      .map((artist) => String(artist.name || "").replace(/\s*\(\d+\)$/, ""))
      .filter(Boolean)
      .join(" / ");
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

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return "";
  const primary = images.find((image) => image.type === "primary");
  return (primary || images[0]).uri || "";
}

// Mirrors scripts/hydrate_discogs_details.py normalize_tracklist().
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

async function discogsFetch(path, token) {
  const response = await fetch(`${DISCOGS_API}${path}`, {
    headers: {
      Authorization: `Discogs token=${token}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    const error = new Error(`Discogs responded ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function cacheable(res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return res;
}
