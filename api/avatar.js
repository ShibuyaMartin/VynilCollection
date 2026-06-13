// Uploads the caller's avatar to the public `avatars` bucket and points
// profiles.avatar_path at it. JWT-verified; the path is always derived from
// the verified user id, never the body. Versioned filename so the public URL
// changes on every upload and caches can't serve the old face.

const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].filter(
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

    // Body is a base64 data URL (image/jpeg or image/png).
    const dataUrl = String(req.body?.image || "");
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Send a JPEG, PNG or WebP image" });
    }
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({ error: "Image must be under 3 MB" });
    }

    const contentType = match[1];
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const avatarPath = `${user.id}/${Date.now()}.${ext}`;

    const upload = await uploadAvatar(avatarPath, buffer, contentType);
    if (!upload.ok) {
      if (upload.status === 400 || upload.status === 404) {
        throw new Error('Storage bucket "avatars" is missing — create a public bucket named avatars in Supabase → Storage');
      }
      throw new Error(`Storage upload failed (${upload.status}): ${upload.body}`);
    }

    // Remove the previous avatar so the bucket doesn't accumulate orphans.
    const profiles = await restFetch(`/rest/v1/profiles?id=eq.${user.id}&select=avatar_path`);
    const previous = profiles[0]?.avatar_path;

    await restPatch(`/rest/v1/profiles?id=eq.${user.id}`, { avatar_path: avatarPath });

    if (previous && previous !== avatarPath) {
      await deleteAvatar(previous);
    }

    return res.status(200).json({ ok: true, avatarPath });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to update avatar" });
  }
}

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

async function restPatch(path, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method: "PATCH",
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Supabase update responded ${response.status}`);
  }
}

async function uploadAvatar(path, buffer, contentType) {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/avatars/${path}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  const body = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 150);
  return { ok: response.ok, status: response.status, body };
}

async function deleteAvatar(path) {
  await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/avatars/${path}`, {
    method: "DELETE",
    headers: serviceHeaders(),
  }).catch(() => {});
}
