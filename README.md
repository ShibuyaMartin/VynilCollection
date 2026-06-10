# Vinyl Archive

A small static site that turns the `coleccion_vinilos.xlsx` spreadsheet into a minimal HTML cover-flow page with album metadata, tracklists, and listening links.

## What is here

- `index.html`, `styles.css`, `app.js`: the front-end experience
- `scripts/build_collection.py`: converts the spreadsheet into `data/collection.json`
- `scripts/enrich_discogs.py`: optionally looks up Discogs art without exposing your token in the browser
- `scripts/hydrate_discogs_details.py`: optionally fetches tracklists for Discogs-matched releases

## Build the collection data

```bash
python3 ./scripts/build_collection.py \
  /Users/martinshibuya/Desktop/coleccion_vinilos.xlsx \
  ./data/collection.json
```

## Run the page locally

```bash
cd /Users/martinshibuya/Documents/GitHub/MyVynilCollection/VynilCollection
python3 -m http.server 4173
```

Then open [http://localhost:4173](http://localhost:4173).

The app works both at the web root and under `/vinilos`, so the same build can be used locally, on GitHub Pages-style hosting, or on Vercel.

## Optional: attach real Discogs covers

The UI already works with generated placeholder sleeves. When you want real cover art, run:

```bash
DISCOGS_USER_TOKEN=your_token_here \
python3 ./scripts/enrich_discogs.py ./data/collection.json
```

Notes:

- The token stays local because the lookup script runs on your machine.
- The script writes matches back into `data/collection.json`.
- If you re-import the spreadsheet later, rerun the Discogs sync afterwards.

To fetch tracklists for the records that already matched Discogs:

```bash
DISCOGS_USER_TOKEN=your_token_here \
python3 ./scripts/hydrate_discogs_details.py ./data/collection.json
```

To materialize local cover files into `./covers` so they can be committed and deployed with the site:

```bash
python3 ./scripts/materialize_covers.py ./data/collection.json
```

## Deploy

This repo is ready to deploy as a static site on Vercel. The important part is that `covers/` is versioned, so the deploy does not depend on Discogs or other remote image hosts at runtime.

## Add records by scanning a barcode (mobile)

Open `/add` (or `/vinilos/add`) on your phone, scan the barcode with the camera, pick the right Discogs edition, confirm, done. The flow is:

1. `add.html` + `add.js` scan the barcode (native `BarcodeDetector` on Android/Chrome, `zxing-wasm` fallback on iOS Safari). Records without a usable barcode can be identified by photographing the cover: `api/identify.js` sends the (client-side downscaled) photo to the Claude API, which extracts artist + title, and the result feeds the same Discogs search. Each identification costs a fraction of a cent and requires the admin token.
2. `api/lookup.js` searches Discogs by barcode (or free text) and fetches release details — the Discogs token never reaches the browser.
3. `api/add.js` builds a record with the same schema as `build_collection.py`, downloads the cover, and pushes **one atomic commit** to GitHub (`data/collection.json` + `covers/<n>.jpg`) via the Git Data API.
4. Vercel picks up the commit and redeploys; the record shows up in about a minute.

### Required Vercel environment variables

| Variable | What it is |
| --- | --- |
| `DISCOGS_TOKEN` | Discogs personal access token (discogs.com → Settings → Developers) |
| `GITHUB_TOKEN` | Fine-grained PAT with **Contents: Read and write** on this repo only |
| `GITHUB_REPO` | `ShibuyaMartin/VynilCollection` |
| `GITHUB_BRANCH` | Optional, defaults to `main` |
| `ADMIN_TOKEN` | Any long random string; the scan page asks for it once and stores it in `localStorage` |
| `ANTHROPIC_API_KEY` | Claude API key (console.anthropic.com) — powers "Identify by cover photo" |

Set them with `vercel env add <NAME> production` or in the Vercel dashboard, then redeploy. Generate a good `ADMIN_TOKEN` with `openssl rand -hex 24`.

Notes:

- Anyone can *view* the collection and even open `/add`, but only requests carrying `ADMIN_TOKEN` can write.
- If a scan matches a release that is already in the collection (same Discogs release id), the API answers `409` instead of duplicating it.
- After someone adds a record from the phone, run `git pull` before working locally.
