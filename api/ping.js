// "Is this for sale?" — emails the record's owner via Resend. The sender is
// identified by their verified Supabase session; the owner's email is looked
// up server-side and never reaches any client. Rate-limited through the
// pings table (which has no client insert policy, so this is the only door).

const MAX_PINGS_PER_DAY = 3;
const PING_COOLDOWN_DAYS = 7;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });
  }

  try {
    const accessToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!accessToken) {
      return res.status(401).json({ error: "Sign in to ask about records" });
    }

    const sender = await verifyUser(accessToken);
    if (!sender) {
      return res.status(401).json({ error: "Session expired — sign in again" });
    }

    const { recordId, message, includeEmail } = req.body || {};
    if (!recordId || !/^[0-9a-f-]{36}$/.test(String(recordId))) {
      return res.status(400).json({ error: "recordId is required" });
    }
    const note = String(message || "").slice(0, 500);

    const senderProfiles = await restFetch(`/rest/v1/profiles?id=eq.${sender.id}&select=username,display_name`);
    if (!senderProfiles.length) {
      return res.status(403).json({ error: "Create your profile first" });
    }
    const senderProfile = senderProfiles[0];

    const records = await restFetch(
      `/rest/v1/records?id=eq.${recordId}&select=id,owner_id,position,artist,title`
    );
    if (!records.length) {
      return res.status(404).json({ error: "Record not found" });
    }
    const record = records[0];

    if (record.owner_id === sender.id) {
      return res.status(400).json({ error: "That's your own record" });
    }

    // Rate limits (service role — clients cannot insert pings directly).
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recentCount = await countRows(`/rest/v1/pings?sender_id=eq.${sender.id}&created_at=gte.${dayAgo}`);
    if (recentCount >= MAX_PINGS_PER_DAY) {
      return res.status(429).json({ error: `Limit reached: ${MAX_PINGS_PER_DAY} asks per day` });
    }

    const cooldownStart = new Date(Date.now() - PING_COOLDOWN_DAYS * 24 * 3600 * 1000).toISOString();
    const dupCount = await countRows(
      `/rest/v1/pings?sender_id=eq.${sender.id}&record_id=eq.${recordId}&created_at=gte.${cooldownStart}`
    );
    if (dupCount >= 1) {
      return res.status(429).json({ error: "You already asked about this record recently" });
    }

    const ownerProfiles = await restFetch(`/rest/v1/profiles?id=eq.${record.owner_id}&select=username,display_name`);
    const owner = ownerProfiles[0] || {};

    const ownerEmail = await fetchOwnerEmail(record.owner_id);
    if (!ownerEmail) {
      return res.status(502).json({ error: "Could not reach the owner" });
    }

    await restInsert("/rest/v1/pings", {
      record_id: recordId,
      sender_id: sender.id,
      message: note || null,
    });

    const senderName = senderProfile.display_name || senderProfile.username;
    const recordName = `${record.artist} — ${record.title}`;
    const senderLink = `https://deadwax.app/u/${senderProfile.username}`;

    const html = `
      <div style="font-family:sans-serif;max-width:520px">
        <p><strong>${escapeHtml(senderName)}</strong> (@${escapeHtml(senderProfile.username)}) is asking about a record in your Deadwax collection:</p>
        <p style="font-size:17px"><strong>${escapeHtml(recordName)}</strong> (#${record.position})</p>
        <p><em>Is it for sale?</em></p>
        ${note ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444">${escapeHtml(note)}</blockquote>` : ""}
        <p>Check out their collection: <a href="${senderLink}">${senderLink}</a></p>
        ${includeEmail && sender.email ? `<p>You can reply directly to this email.</p>` : `<p style="color:#888;font-size:13px">The sender did not share their email — reach them through their collection page.</p>`}
      </div>`;

    const sent = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Deadwax <ping@deadwax.app>",
        to: [ownerEmail],
        subject: `Is "${record.title}" for sale? — Deadwax`,
        html,
        ...(includeEmail && sender.email ? { reply_to: sender.email } : {}),
      }),
    });

    if (!sent.ok) {
      const body = await sent.text().catch(() => "");
      throw new Error(`Email delivery failed (${sent.status}): ${body.slice(0, 150)}`);
    }

    return res.status(200).json({
      ok: true,
      message: `Sent! ${owner.display_name || owner.username || "The owner"} will get an email.`,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to send" });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

async function countRows(path) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}&select=id`, {
    headers: serviceHeaders({ Prefer: "count=exact", Range: "0-0" }),
  });
  const range = response.headers.get("content-range") || "/0";
  return Number.parseInt(range.split("/")[1], 10) || 0;
}

async function restInsert(path, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase insert responded ${response.status}: ${text.slice(0, 150)}`);
  }
}
