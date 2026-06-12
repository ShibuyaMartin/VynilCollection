// Daily cron target (vercel.json) — one cheap query so the Supabase free-tier
// project never pauses for inactivity (~7 idle days).
export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: "Supabase env vars missing" });
  }

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY },
  });

  return res.status(response.ok ? 200 : 502).json({ ok: response.ok });
}
