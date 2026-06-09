#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import json
import textwrap
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
PRODUCTION_COLLECTION_URL = "https://shibu.pro/vinilos/data/collection.json"
PRODUCTION_COVER_URL = "https://shibu.pro/vinilos/covers/{number}.jpg"
ITUNES_TOKEN = "/100x100bb.jpg"
ITUNES_HD_TOKEN = "/1000x1000bb.jpg"

# Discogs now blocks hotlinking for our localhost preview, so these records
# need a stable alternative source or a generated local placeholder.
REMOTE_COVER_OVERRIDES = {
    "17": "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/63/3c/98/633c98ab-b4f3-3f40-798b-bdb49d923468/074640878626.jpg/100x100bb.jpg",
    "99": "https://is1-ssl.mzstatic.com/image/thumb/Music123/v4/9f/cb/e3/9fcbe337-993f-2cdc-8907-255d10c6d045/19CRGIM12499.rgb.jpg/100x100bb.jpg",
    "161": "https://cdn-images.dzcdn.net/images/cover/762293f16236fc0e2afd9bab476919ff/1000x1000-000000-80-0-0.jpg",
    "162": "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/60/92/98/609298b4-6bdc-1b87-e21b-a853310bbe11/753625010267.jpg/100x100bb.jpg",
    "163": "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/25/3c/3e/253c3e06-cd31-0952-1b90-4de69a77def5/4050486102855_cover.jpg/100x100bb.jpg",
    "164": "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/d5/7f/6e/d57f6e8e-068c-ef83-2a62-663e47d3f002/Syro_digital_packshot_RGB_1400.jpg/100x100bb.jpg",
    "165": "https://is1-ssl.mzstatic.com/image/thumb/Music7/v4/14/38/44/143844a7-553a-38c8-5a29-2a20445b6b4f/JoannaNewsom_Divers_Mini.jpg/100x100bb.jpg",
    "166": "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/7a/65/c2/7a65c212-d5b8-2e3c-4d08-77bc4e4a65ac/3614970930488.jpg/100x100bb.jpg",
    "168": "https://is1-ssl.mzstatic.com/image/thumb/Music113/v4/ae/dd/05/aedd058e-cc07-3c40-6d22-74f2fbec7073/889030017161.png/100x100bb.jpg",
    "169": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dc/0d/ae/dc0daef8-093e-757d-2b09-90a3d0943075/13ULAIM49008.rgb.jpg/100x100bb.jpg",
    "170": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/ba/52/3b/ba523b6b-0658-ae87-e520-1c0b48aad4b9/634904086664.png/100x100bb.jpg",
    "171": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/62/dc/9a/62dc9ab2-ff72-49fc-84e1-534b822e4818/COKM-43651.jpg/100x100bb.jpg",
    "172": "https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/ed/76/24/ed7624b8-4079-8881-47f1-c72b03ede03e/5060180323844.jpg/100x100bb.jpg",
    "173": "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/17/28/eb/1728ebee-a489-5eda-6af5-feb3a10fdeaa/4062548028539.png/100x100bb.jpg",
    "174": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/28/a1/59/28a1595d-5592-2490-0399-1c802c34e327/10CMGIM00782.rgb.jpg/100x100bb.jpg",
    "175": "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/60/66/ab/6066abe5-5626-28e2-3f86-f08b07312f46/4062548032826.png/100x100bb.jpg",
    "176": "https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/cb/86/2e/cb862ee4-dc77-3ea7-33c5-f0b72a9c7aeb/dj.fygxuvzy.jpg/100x100bb.jpg",
    "177": "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/7b/53/8c/7b538c1b-8be0-baed-d664-b1e8e5c31aa3/22UMGIM10125.rgb.jpg/100x100bb.jpg",
    "178": "https://cdn-images.dzcdn.net/images/cover/48f364718b8a2f41dd7f52a10aa860de/1000x1000-000000-80-0-0.jpg",
    "179": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/b8/fb/58/b8fb584f-f7dd-cb14-ae4a-5e96728a4d5e/cover.jpg/100x100bb.jpg",
    "180": "https://cdn-images.dzcdn.net/images/cover/1c31cfff3baf6b26dadde729357d35cf/1000x1000-000000-80-0-0.jpg",
    "181": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b5/86/ae/b586aef7-ec6d-5bcc-13c1-740d07fff07c/5056556125952_cover.jpg/100x100bb.jpg",
    "182": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/25/68/d2/2568d2b8-9c9a-b9b5-f647-ea6daaaca346/8721253017790.png/100x100bb.jpg",
    "183": "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/b5/9c/b9/b59cb984-b561-6c64-f52a-8f0da1b78c21/4941255069038.jpg/100x100bb.jpg",
    "184": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/f1/06/ec/f106ec4d-edc9-ed78-c5e8-caec05604dcc/4251804179874_3000.jpg/100x100bb.jpg",
    "186": "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/dd/5c/23/dd5c23df-14fe-60e3-7f11-bb4862fa0434/4560427459899.jpg/100x100bb.jpg",
    "187": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/0f/32/e9/0f32e9c7-6d78-e1c1-f89c-f9a46fe157d7/3663729405982_cover.jpg/100x100bb.jpg",
    "188": "https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/cf/6f/3a/cf6f3a10-11e7-8459-440a-102a97e55290/5400863201890.jpg/100x100bb.jpg",
    "190": "https://is1-ssl.mzstatic.com/image/thumb/Music123/v4/3b/a3/59/3ba359b2-cd37-efce-d8d1-fc2e1faec216/888880766724.jpg/100x100bb.jpg",
}

PLACEHOLDER_ONLY = {
    "167",
    "185",
    "189",
    "191",
    "192",
}

PLACEHOLDER_PALETTES = [
    ("#101418", "#243b52", "#f7f4ea"),
    ("#17131c", "#54414e", "#fff6e8"),
    ("#10110d", "#586244", "#f9f7ef"),
    ("#12151f", "#385170", "#f8f4ee"),
    ("#1b120f", "#7a4f3b", "#fff3eb"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Materialize local cover assets for the vinyl collection.")
    parser.add_argument(
        "collection",
        type=Path,
        help="Path to collection.json",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    collection_path = args.collection.resolve()
    root = collection_path.parent.parent
    covers_dir = root / "covers"
    if covers_dir.is_symlink() and not covers_dir.exists():
        covers_dir.unlink()
    covers_dir.mkdir(parents=True, exist_ok=True)

    payload = json.loads(collection_path.read_text(encoding="utf-8"))
    records = payload.get("records", [])
    production_collection = fetch_json(PRODUCTION_COLLECTION_URL)
    production_cover_numbers = {
        str(record.get("number")): record
        for record in production_collection.get("records", [])
        if str(record.get("coverUrl") or "").startswith("/vinilos/covers/")
    }

    counts = {
        "production": 0,
        "override": 0,
        "placeholder": 0,
        "updated_records": 0,
    }

    for record in records:
        number = str(record.get("number") or "").strip()
        if not number:
            continue

        local_path = existing_local_cover_path(covers_dir, number)
        if local_path:
            pass
        elif number in production_cover_numbers:
            local_path = covers_dir / f"{number}.jpg"
            if not local_path.exists():
                download_binary(PRODUCTION_COVER_URL.format(number=number), local_path)
                counts["production"] += 1
        elif number in REMOTE_COVER_OVERRIDES:
            local_path = covers_dir / f"{number}.jpg"
            if not local_path.exists():
                download_binary(REMOTE_COVER_OVERRIDES[number], local_path)
                counts["override"] += 1
        elif number in PLACEHOLDER_ONLY:
            local_path = covers_dir / f"{number}.svg"
            if not local_path.exists():
                local_path.write_text(build_placeholder_svg(record), encoding="utf-8")
                counts["placeholder"] += 1

        if not local_path:
            continue

        public_path = f"/vinilos/covers/{local_path.name}"
        if record.get("coverUrl") != public_path or record.get("thumbUrl") != public_path:
            record["coverUrl"] = public_path
            record["thumbUrl"] = public_path
            counts["updated_records"] += 1

    collection_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(counts, indent=2))


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def download_binary(url: str, destination: Path) -> None:
    last_error = None
    for candidate in candidate_download_urls(url):
        request = urllib.request.Request(
            candidate,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                destination.write_bytes(response.read())
                return
        except urllib.error.HTTPError as error:
            last_error = error

    if last_error:
        raise last_error


def existing_local_cover_path(covers_dir: Path, number: str) -> Path | None:
    for extension in ("jpg", "jpeg", "png", "webp", "svg"):
        candidate = covers_dir / f"{number}.{extension}"
        if candidate.exists():
            return candidate
    return None


def candidate_download_urls(url: str) -> list[str]:
    candidates = []
    if ITUNES_TOKEN in url:
        candidates.append(url.replace(ITUNES_TOKEN, ITUNES_HD_TOKEN))
    candidates.append(url)
    return list(dict.fromkeys(candidates))


def build_placeholder_svg(record: dict) -> str:
    number = str(record.get("number") or "").strip()
    artist = str(record.get("artist") or "Unknown Artist").strip()
    title = str(record.get("title") or "Untitled").strip()
    genre = str(record.get("genre") or "Vinyl").strip().upper()
    year = str(record.get("year") or "").strip()

    palette = PLACEHOLDER_PALETTES[sum(ord(char) for char in number + title) % len(PLACEHOLDER_PALETTES)]
    background_a, background_b, foreground = palette

    title_lines = textwrap.wrap(title, width=16)[:4]
    artist_lines = textwrap.wrap(artist, width=28)[:2]
    footer = f"Record {number}" if not year else f"Record {number}  •  {year}"

    title_tspans = "".join(
        f'<tspan x="96" dy="{0 if index == 0 else 110}">{html.escape(line)}</tspan>'
        for index, line in enumerate(title_lines)
    )
    artist_tspans = "".join(
        f'<tspan x="96" dy="{0 if index == 0 else 54}">{html.escape(line)}</tspan>'
        for index, line in enumerate(artist_lines)
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" role="img" aria-label="{html.escape(artist)} - {html.escape(title)}">
  <defs>
    <linearGradient id="g" x1="0%" x2="100%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="{background_a}" />
      <stop offset="100%" stop-color="{background_b}" />
    </linearGradient>
  </defs>
  <rect width="1200" height="1200" fill="url(#g)" />
  <circle cx="980" cy="220" r="210" fill="{foreground}" opacity="0.08" />
  <circle cx="1040" cy="1040" r="320" fill="{foreground}" opacity="0.05" />
  <text x="96" y="124" fill="{foreground}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="8">{html.escape(genre)}</text>
  <text x="96" y="364" fill="{foreground}" font-family="Helvetica, Arial, sans-serif" font-size="108" font-weight="800">{title_tspans}</text>
  <text x="96" y="980" fill="{foreground}" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="500" opacity="0.92">{artist_tspans}</text>
  <text x="1104" y="1110" text-anchor="end" fill="{foreground}" font-family="Helvetica, Arial, sans-serif" font-size="30" opacity="0.78">{html.escape(footer)}</text>
</svg>
"""


if __name__ == "__main__":
    main()
