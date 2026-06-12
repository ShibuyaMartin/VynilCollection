# Deadwax

A social vinyl-collection app at [deadwax.app](https://deadwax.app): every user gets their own shelf at `/u/<username>`, browsable as a 3D cover-flow or a grid, and adds records by scanning the barcode with their phone camera.

## Architecture

- **Front end**: static HTML + vanilla ES modules, no build step. `index.html`/`app.js` (collection views), `add.html`/`add.js` (barcode scanner + add flow), `login.html`/`js/login.js` (magic link / OTP code sign-in).
- **Backend**: [Supabase](https://supabase.com) — Postgres (profiles + records with row-level security, see `supabase/schema.sql`), email auth, and a public `covers` storage bucket.
- **Serverless functions** (Vercel, zero deps):
  - `api/lookup.js` — Discogs search by barcode/text (token stays server-side)
  - `api/records.js` — creates a record: verifies the Supabase session token, fetches the Discogs release, downloads the cover into Storage
  - `api/keepalive.js` — daily cron so the free-tier Supabase project never pauses

## Environment variables (Vercel)

| Variable | What it is |
| --- | --- |
| `DISCOGS_TOKEN` | Discogs personal access token |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | Publishable key (also hardcoded in `js/supabase-client.js`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret key — server-side only |

Auth emails are delivered via Resend SMTP (configured in Supabase) from `login@deadwax.app`. The Magic Link email template includes `{{ .Token }}` so users can type the sign-in code instead of opening the link (in-app mail browsers block the camera and isolate sessions).

## Local development

```bash
npx serve -l 4173 .   # serve.json mirrors the Vercel rewrites (/u/:user, /add, /login)
```

## History

The original single-user version (collection JSON + covers committed to this repo, adds via GitHub-API commits) is preserved at the `pre-supabase` tag. `scripts/migrate_to_supabase.mjs` is the script that imported that data into Supabase.
