// Crate digger: suggest a record the collector doesn't own, rooted in the
// styles that dominate their shelf. No AI — a style is drawn weighted by its
// share of the collection, then Discogs community have/want data ranks the
// candidates. Public data only, so the anon key is enough.

const USER_AGENT = "Deadwax/1.0";
const MODERN_CUTOFF = 2010;
const TOP_POOL = 30;
const STYLE_ATTEMPTS = 4;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Use GET" });
  }

  const missing = ["DISCOGS_TOKEN", "SUPABASE_URL", "SUPABASE_ANON_KEY"].filter((name) => !process.env[name]);
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const username = String(req.query.username || "").toLowerCase();
    if (!/^[a-z0-9-]{1,40}$/.test(username)) {
      return res.status(400).json({ error: "username is required" });
    }
    const era = req.query.era === "modern" ? "modern" : "any";

    const profiles = await supabaseFetch(`/rest/v1/profiles?username=eq.${username}&select=id`);
    if (!profiles.length) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const records = await supabaseFetch(
      `/rest/v1/records?owner_id=eq.${profiles[0].id}&select=styles,artist,title,discogs_release_id&limit=1000`
    );

    const styleWeights = new Map();
    for (const record of records) {
      for (const style of record.styles || []) {
        if (style) styleWeights.set(style, (styleWeights.get(style) || 0) + 1);
      }
    }
    if (!styleWeights.size) {
      return res.status(404).json({ error: "No styles on this shelf yet" });
    }

    const ownedIds = new Set(records.map((r) => r.discogs_release_id).filter(Boolean));
    const ownedNames = new Set(records.map((r) => normalize(`${r.artist} ${r.title}`)));

    const triedStyles = [];
    for (let attempt = 0; attempt < STYLE_ATTEMPTS; attempt += 1) {
      const style = weightedPick(styleWeights, triedStyles);
      if (!style) break;
      triedStyles.push(style);

      const candidates = await searchDiscogs(style, era, ownedIds, ownedNames);
      if (!candidates.length) continue;

      const pool = candidates.slice(0, TOP_POOL);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return res.status(200).json({
        style,
        poolSize: pool.length,
        pick: {
          title: pick.title,
          year: pick.year || null,
          coverImage: pick.cover_image || null,
          url: pick.uri ? `https://www.discogs.com${pick.uri}` : null,
          have: pick.community?.have || 0,
          want: pick.community?.want || 0,
        },
      });
    }

    return res.status(404).json({ error: "Came up empty this time — roll again" });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Dig failed" });
  }
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Random style, weighted by how much of the shelf it covers.
function weightedPick(weights, exclude) {
  const entries = [...weights.entries()].filter(([style]) => !exclude.includes(style));
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!total) return null;
  let roll = Math.random() * total;
  for (const [style, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return style;
  }
  return entries[entries.length - 1][0];
}

async function searchDiscogs(style, era, ownedIds, ownedNames) {
  const params = new URLSearchParams({
    style,
    format: "Vinyl",
    type: "release",
    per_page: "100",
    token: process.env.DISCOGS_TOKEN,
  });
  const response = await fetch(`https://api.discogs.com/database/search?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Discogs responded ${response.status}`);
  }
  const payload = await response.json();

  const seenMasters = new Set();
  return (payload.results || [])
    .filter((result) => {
      const year = Number(result.year);
      if (era === "modern" && (!year || year < MODERN_CUTOFF)) return false;
      if (ownedIds.has(result.id)) return false;
      if (ownedNames.has(normalize(result.title))) return false;
      const key = result.master_id || `r${result.id}`;
      if (seenMasters.has(key)) return false;
      seenMasters.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        (b.community?.want || 0) + (b.community?.have || 0) -
        ((a.community?.want || 0) + (a.community?.have || 0))
    );
}

async function supabaseFetch(path) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase ${path.split("?")[0]} responded ${response.status}`);
  }
  return response.json();
}
