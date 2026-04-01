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
cd /Users/martinshibuya/Documents/GitHub/MyVynilCollection
python3 -m http.server 4173
```

Then open [http://localhost:4173](http://localhost:4173).

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
