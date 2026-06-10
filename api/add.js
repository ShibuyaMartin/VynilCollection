const DISCOGS_API = "https://api.discogs.com";
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "VinilosShibu/1.0 +https://vynil-collection.vercel.app";
const COLLECTION_PATH = "data/collection.json";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const missing = ["ADMIN_TOKEN", "DISCOGS_TOKEN", "GITHUB_TOKEN", "GITHUB_REPO"].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  const auth = String(req.headers.authorization || "");
  if (auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: "Invalid admin token" });
  }

  const { releaseId, barcode, coverCondition, discCondition, comment } = req.body || {};
  if (!releaseId) {
    return res.status(400).json({ error: "releaseId is required" });
  }

  try {
    const release = await discogsFetch(`/releases/${encodeURIComponent(releaseId)}`);

    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || "main";
    const collection = await fetchCollection(repo, branch);

    const duplicate = (collection.records || []).find(
      (record) => String(record.discogsReleaseId || "") === String(releaseId)
    );
    if (duplicate && !req.body.allowDuplicate) {
      return res.status(409).json({
        error: "duplicate",
        message: `Ya está en la colección como #${duplicate.number}: ${duplicate.artist} - ${duplicate.title}`,
        record: { number: duplicate.number, artist: duplicate.artist, title: duplicate.title },
      });
    }

    const nextNumber =
      (collection.records || []).reduce(
        (max, record) => Math.max(max, parseInt(record.number, 10) || 0),
        0
      ) + 1;

    const cover = await downloadCover(release);
    const record = buildRecord({
      release,
      number: nextNumber,
      barcode,
      coverCondition,
      discCondition,
      comment,
      hasLocalCover: Boolean(cover),
    });

    collection.records.push(record);
    collection.recordCount = collection.records.length;
    collection.generatedAt = new Date().toISOString();

    const commitUrl = await commitToGitHub({
      repo,
      branch,
      record,
      collection,
      cover,
    });

    return res.status(200).json({
      ok: true,
      record: {
        number: record.number,
        artist: record.artist,
        title: record.title,
        year: record.year,
        coverUrl: record.coverUrl,
      },
      commitUrl,
      note: "Vercel va a redeployar el sitio; el disco aparece en ~1 minuto.",
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to add record" });
  }
}

function buildRecord({ release, number, barcode, coverCondition, discCondition, comment, hasLocalCover }) {
  const artist = formatArtists(release.artists, release.artists_sort);
  const title = String(release.title || "").trim();
  const year = release.year ? String(release.year) : "";
  const labels = release.labels || [];
  const label = labels[0]?.name || "";
  const catalogNumber = labels[0]?.catno || "";
  const country = release.country || "";
  const genres = release.genres || [];
  const styles = release.styles || [];
  const genre = genres.join(" / ");
  const releaseUrl = release.uri || `https://www.discogs.com/release/${release.id}`;
  const coverPath = `/vinilos/covers/${number}.jpg`;

  const record = {
    number: String(number),
    artist,
    title,
    year,
    genre,
    label,
    catalogNumber,
    country,
    coverCondition: String(coverCondition || "VG+"),
    discCondition: String(discCondition || "VG+"),
    id: `${number}-${slugify(`${artist} ${title}`)}`,
    genreGroups: genres.length ? genres : ["Otros"],
    yearSort: parseInt(year, 10) || null,
    searchText: normalizeText(
      [artist, title, year, genre, label, catalogNumber, country, comment || ""].join(" ")
    ),
    coverUrl: hasLocalCover ? coverPath : "",
    thumbUrl: hasLocalCover ? coverPath : "",
    discogsUrl: releaseUrl,
    discogsCanonicalUrl: releaseUrl,
    discogsFormats: flattenFormats(release.formats),
    discogsMediaType: "Vinyl",
    discogsIsVinyl: true,
    discogsGenres: genres,
    discogsStyles: styles,
    discogsReleaseId: String(release.id),
    tracklist: normalizeTracklist(release.tracklist || []),
    addedVia: "barcode-scan",
  };

  if (barcode) record.barcode = String(barcode);
  if (comment) record.comment = String(comment);

  return record;
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
  if (!buffer.length) return null;
  return buffer;
}

async function fetchCollection(repo, branch) {
  const response = await githubFetch(
    `/repos/${repo}/contents/${COLLECTION_PATH}?ref=${encodeURIComponent(branch)}`,
    { headers: { Accept: "application/vnd.github.raw+json" } }
  );
  return response.json();
}

// Single atomic commit (JSON + cover) via the Git Data API, so one scan
// triggers exactly one Vercel deploy.
async function commitToGitHub({ repo, branch, record, collection, cover }) {
  const refData = await (await githubFetch(`/repos/${repo}/git/ref/heads/${branch}`)).json();
  const headSha = refData.object.sha;
  const headCommit = await (await githubFetch(`/repos/${repo}/git/commits/${headSha}`)).json();

  const jsonBlob = await createBlob(repo, JSON.stringify(collection, null, 2) + "\n", "utf-8");

  const tree = [
    { path: COLLECTION_PATH, mode: "100644", type: "blob", sha: jsonBlob },
  ];
  if (cover) {
    const coverBlob = await createBlob(repo, cover.toString("base64"), "base64");
    tree.push({ path: `covers/${record.number}.jpg`, mode: "100644", type: "blob", sha: coverBlob });
  }

  const newTree = await (
    await githubFetch(`/repos/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
    })
  ).json();

  const commit = await (
    await githubFetch(`/repos/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `Add record #${record.number}: ${record.artist} - ${record.title}\n\nAdded via barcode scan.`,
        tree: newTree.sha,
        parents: [headSha],
      }),
    })
  ).json();

  await githubFetch(`/repos/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return commit.html_url || `https://github.com/${repo}/commit/${commit.sha}`;
}

async function createBlob(repo, content, encoding) {
  const response = await githubFetch(`/repos/${repo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content, encoding }),
  });
  return (await response.json()).sha;
}

async function githubFetch(path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${path} responded ${response.status}: ${body.slice(0, 200)}`);
  }

  return response;
}

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

// Mirrors scripts/build_collection.py normalize_text() / slugify().
function normalizeText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
