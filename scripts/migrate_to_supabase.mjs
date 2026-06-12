// One-time migration: data/collection.json + covers/ -> Supabase.
// Zero dependencies (Node 18+). Re-runnable: existing (owner, position)
// rows are skipped.
//
// Usage:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/migrate_to_supabase.mjs
//
// Optional: OWNER_EMAIL (default shibu@decentraland.org),
//           OWNER_USERNAME (default shibu), OWNER_NAME (default Martín).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const SUPABASE_URL = required("SUPABASE_URL");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = process.env.OWNER_EMAIL || "shibu@decentraland.org";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "shibu";
const OWNER_NAME = process.env.OWNER_NAME || "Martín";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var ${name}`);
    process.exit(1);
  }
  return value;
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers: headers(options.headers) });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}

async function ensureOwner() {
  // Find-or-create the auth user (admin API), then the profile.
  const lookup = await api(`/auth/v1/admin/users?page=1&per_page=200`);
  if (!lookup.ok) throw new Error(`admin users list failed: ${lookup.status}`);
  let user = (lookup.data.users || []).find((u) => u.email === OWNER_EMAIL);

  if (!user) {
    const created = await api(`/auth/v1/admin/users`, {
      method: "POST",
      body: JSON.stringify({ email: OWNER_EMAIL, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`create user failed: ${created.status} ${JSON.stringify(created.data)}`);
    user = created.data;
    console.log(`created auth user ${OWNER_EMAIL}`);
  } else {
    console.log(`auth user exists: ${OWNER_EMAIL}`);
  }

  const profile = await api(`/rest/v1/profiles?id=eq.${user.id}&select=id,username`);
  if (!profile.data.length) {
    const inserted = await api(`/rest/v1/profiles`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ id: user.id, username: OWNER_USERNAME, display_name: OWNER_NAME }),
    });
    if (!inserted.ok) throw new Error(`create profile failed: ${JSON.stringify(inserted.data)}`);
    console.log(`created profile @${OWNER_USERNAME}`);
  } else {
    console.log(`profile exists: @${profile.data[0].username}`);
  }

  return user.id;
}

function mapRecord(legacy, ownerId) {
  return {
    owner_id: ownerId,
    position: Number.parseInt(legacy.number, 10),
    artist: legacy.artist || "",
    title: legacy.title || "",
    year: Number.parseInt(legacy.year, 10) || legacy.yearSort || null,
    label: legacy.label || "",
    catalog_number: legacy.catalogNumber || "",
    country: legacy.country || "",
    cover_condition: legacy.coverCondition || "VG+",
    disc_condition: legacy.discCondition || "VG+",
    barcode: legacy.barcode || null,
    comment: legacy.comment || null,
    genres: legacy.genreGroups?.length ? legacy.genreGroups : (legacy.discogsGenres || []),
    styles: legacy.discogsStyles || [],
    formats: legacy.discogsFormats || [],
    tracklist: legacy.tracklist || [],
    discogs_release_id: legacy.discogsReleaseId || null,
    discogs_url: legacy.discogsCanonicalUrl || legacy.discogsUrl || "",
    search_text: legacy.searchText || "",
    added_via: legacy.addedVia || "spreadsheet-import",
  };
}

async function main() {
  const collection = JSON.parse(await readFile("data/collection.json", "utf-8"));
  const records = collection.records || [];
  console.log(`migrating ${records.length} records for ${OWNER_EMAIL}`);

  const ownerId = await ensureOwner();

  const existingRows = await api(`/rest/v1/records?owner_id=eq.${ownerId}&select=position&limit=1000`);
  const existingPositions = new Set((existingRows.data || []).map((row) => row.position));

  let inserted = 0;
  let skipped = 0;
  let coversUploaded = 0;
  let coversMissing = 0;

  for (const legacy of records) {
    const position = Number.parseInt(legacy.number, 10);
    if (existingPositions.has(position)) {
      skipped += 1;
      continue;
    }

    const insertResult = await api(`/rest/v1/records`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(mapRecord(legacy, ownerId)),
    });
    if (!insertResult.ok) {
      console.error(`  FAILED #${legacy.number} ${legacy.artist} - ${legacy.title}: ${JSON.stringify(insertResult.data).slice(0, 200)}`);
      continue;
    }
    const row = insertResult.data[0];
    inserted += 1;

    const coverFile = `covers/${legacy.number}.jpg`;
    if (existsSync(coverFile)) {
      const image = await readFile(coverFile);
      const coverPath = `${ownerId}/${row.id}.jpg`;
      const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/covers/${coverPath}`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "image/jpeg",
          "x-upsert": "true",
        },
        body: image,
      });
      if (upload.ok) {
        await api(`/rest/v1/records?id=eq.${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ cover_path: coverPath }),
        });
        coversUploaded += 1;
      } else {
        console.error(`  cover upload failed for #${legacy.number}: ${upload.status}`);
      }
    } else {
      coversMissing += 1;
    }

    if (inserted % 20 === 0) {
      console.log(`  ...${inserted} inserted`);
    }
  }

  console.log(`done: ${inserted} inserted, ${skipped} already present, ${coversUploaded} covers uploaded, ${coversMissing} covers missing`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
