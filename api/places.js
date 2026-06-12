// Vinyl places near a point: record stores come from OpenStreetMap via the
// Overpass API (free, no key), community-added places (fairs, listening
// cafés) come from our own places table. Accepts ?lat&lng or ?q=<city>,
// which is geocoded through Nominatim. Public data only — no auth.

const USER_AGENT = "Deadwax/1.0";
const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 50;
const MAX_RESULTS = 60;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Use GET" });
  }

  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY"].filter((name) => !process.env[name]);
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  try {
    let lat = Number(req.query.lat);
    let lng = Number(req.query.lng);
    let label = "";

    const q = String(req.query.q || "").trim().slice(0, 120);
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && q) {
      const geo = await geocode(q);
      if (!geo) {
        return res.status(404).json({ error: `Could not find "${q}" — try a city name` });
      }
      lat = geo.lat;
      lng = geo.lng;
      label = geo.label;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: "Pass lat/lng or a place to search" });
    }

    const radiusKm = Math.min(MAX_RADIUS_KM, Math.max(1, Number(req.query.radius) || DEFAULT_RADIUS_KM));

    const [osmPlaces, communityPlaces] = await Promise.all([
      fetchOsmStores(lat, lng, radiusKm),
      fetchCommunityPlaces(lat, lng, radiusKm),
    ]);

    // Community rows that mirror an OSM element override the OSM entry
    // (they carry a placeId reviews can attach to).
    const byOsmId = new Map(communityPlaces.filter((p) => p.osmId).map((p) => [p.osmId, p]));
    const merged = [
      ...communityPlaces.filter((p) => !p.osmId),
      ...communityPlaces.filter((p) => p.osmId),
      ...osmPlaces.filter((p) => !byOsmId.has(p.osmId)),
    ];

    for (const place of merged) {
      place.distanceKm = Math.round(haversineKm(lat, lng, place.lat, place.lng) * 10) / 10;
    }
    merged.sort((a, b) => a.distanceKm - b.distanceKm);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      center: { lat, lng, label },
      radiusKm,
      places: merged.slice(0, MAX_RESULTS),
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Search failed" });
  }
}

async function geocode(q) {
  const params = new URLSearchParams({ q, format: "json", limit: "1" });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Geocoder responded ${response.status}`);
  }
  const results = await response.json();
  if (!results.length) return null;
  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    label: String(results[0].display_name || q).split(",").slice(0, 3).join(",").trim(),
  };
}

async function fetchOsmStores(lat, lng, radiusKm) {
  const radius = Math.round(radiusKm * 1000);
  const query = `
[out:json][timeout:12];
(
  node["shop"="records"](around:${radius},${lat},${lng});
  way["shop"="records"](around:${radius},${lat},${lng});
  node["shop"="music"](around:${radius},${lat},${lng});
  way["shop"="music"](around:${radius},${lat},${lng});
);
out center tags;`;

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!response.ok) {
    throw new Error(`Map data responded ${response.status} — try again in a minute`);
  }
  const payload = await response.json();

  const seen = new Set();
  const places = [];
  for (const element of payload.elements || []) {
    const tags = element.tags || {};
    const elementLat = element.lat ?? element.center?.lat;
    const elementLng = element.lon ?? element.center?.lon;
    if (!Number.isFinite(elementLat) || !Number.isFinite(elementLng)) continue;

    const osmId = `${element.type}/${element.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);

    const address = [
      [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
      tags["addr:city"],
    ]
      .filter(Boolean)
      .join(", ");

    places.push({
      source: "osm",
      osmId,
      placeId: null,
      name: tags.name || "Record store",
      kind: "store",
      lat: elementLat,
      lng: elementLng,
      address,
      website: tags.website || tags["contact:website"] || tags["contact:instagram"] || "",
    });
  }
  return places;
}

async function fetchCommunityPlaces(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const params =
    `lat=gte.${lat - latDelta}&lat=lte.${lat + latDelta}` +
    `&lng=gte.${lng - lngDelta}&lng=lte.${lng + lngDelta}` +
    `&select=id,osm_id,name,kind,lat,lng,website,city&limit=200`;

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/places?${params}`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });
  if (!response.ok) {
    // The table may not exist yet; OSM results still work.
    return [];
  }
  const rows = await response.json();
  return rows
    .filter((row) => haversineKm(lat, lng, row.lat, row.lng) <= radiusKm)
    .map((row) => ({
      source: "deadwax",
      osmId: row.osm_id || null,
      placeId: row.id,
      name: row.name,
      kind: row.kind,
      lat: row.lat,
      lng: row.lng,
      address: row.city || "",
      website: row.website || "",
    }));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
