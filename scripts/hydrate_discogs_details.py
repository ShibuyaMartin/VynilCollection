#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
import unicodedata
from pathlib import Path
from typing import Dict, List

USER_AGENT = "MyVynilCollection/1.0 +local"
API_ROOT = "https://api.discogs.com"
MAX_RETRIES = 6
MISSING_MARKERS = {"", "-", "n/a", "na", "unknown"}
COUNTRY_MAP = {
    "US": "USA",
    "USA": "USA",
    "UK": "UK",
    "Germany": "Alemania",
    "Japan": "Japón",
    "Switzerland": "Suiza",
    "Netherlands": "Países Bajos",
    "France": "Francia",
    "Italy": "Italia",
    "Belgium": "Bélgica",
    "Spain": "España",
    "Canada": "Canadá",
    "Sweden": "Suecia",
    "Denmark": "Dinamarca",
    "Austria": "Austria",
    "Ireland": "Irlanda",
    "Portugal": "Portugal",
    "Europe": "Europa",
    "Czech Republic": "República Checa",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch release details and tracklists for Discogs-matched records."
    )
    parser.add_argument("collection_json", type=Path, help="Path to data/collection.json")
    parser.add_argument(
        "--sleep",
        type=float,
        default=1.2,
        help="Delay between release-detail requests.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Refresh details even when a tracklist already exists.",
    )
    parser.add_argument(
        "--record-numbers",
        default="",
        help="Optional comma-separated record numbers to process, for example 12,37,108.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.environ.get("DISCOGS_USER_TOKEN")
    if not token:
        raise SystemExit("Set DISCOGS_USER_TOKEN before running this script.")

    payload = json.loads(args.collection_json.read_text(encoding="utf-8"))
    records = payload.get("records", [])
    target_numbers = parse_record_numbers(args.record_numbers)
    masters_cache: Dict[str, Dict[str, object] | None] = {}

    processed = 0
    hydrated = 0

    for record in records:
        if target_numbers and str(record.get("number")) not in target_numbers:
            continue
        if not record.get("discogsUrl"):
            continue
        if record.get("tracklist") and not args.overwrite:
            continue

        release_id = str(record.get("discogsReleaseId") or "").strip()
        if not release_id:
            release_id = extract_release_id(str(record.get("discogsUrl", "")))
        if not release_id:
            continue

        processed += 1
        details = fetch_release_details(release_id, token)
        if not details:
            print(f"[miss]  {record['number']}: unable to fetch release details")
            time.sleep(args.sleep)
            continue

        tracklist = normalize_tracklist(details.get("tracklist") or [])
        record["tracklist"] = tracklist
        release_url = canonical_discogs_url(details.get("uri") or record.get("discogsCanonicalUrl") or record["discogsUrl"])
        record["discogsCanonicalUrl"] = release_url
        record["discogsReleaseUrl"] = release_url
        record["discogsReleaseId"] = release_id
        record["discogsFormats"] = flatten_formats(details.get("formats") or [])
        record["discogsMediaType"] = primary_media_type(details.get("formats") or [])
        record["discogsIsVinyl"] = is_vinyl_format(details.get("formats") or [])
        record["discogsGenres"] = list(details.get("genres") or [])
        record["discogsStyles"] = list(details.get("styles") or [])
        master_id = extract_master_id(details)
        master_url = ""
        if master_id:
            if master_id not in masters_cache:
                masters_cache[master_id] = fetch_master_details(master_id, token)
            master_details = masters_cache[master_id]
            if master_details and master_details.get("uri"):
                master_url = canonical_discogs_url(str(master_details.get("uri")))
            else:
                master_url = canonical_discogs_url(f"/master/{master_id}")
        record["discogsMasterId"] = master_id
        record["discogsMasterUrl"] = master_url
        record["discogsUrl"] = master_url or release_url
        backfill_record_metadata(record, details)
        cover_url, thumb_url = pick_cover_urls(details)
        if cover_url:
            record["coverUrl"] = cover_url
        if thumb_url:
            record["thumbUrl"] = thumb_url
        hydrated += 1
        print(f"[tracklist] {record['number']}: {record['artist']} - {record['title']} ({len(tracklist)} tracks)")

        args.collection_json.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        time.sleep(args.sleep)

    print(f"Processed {processed} matched records and hydrated {hydrated}.")


def extract_release_id(value: str) -> str | None:
    match = re.search(r"/release/(\d+)", value)
    if match:
        return match.group(1)
    return None


def fetch_release_details(release_id: str, token: str) -> Dict[str, object] | None:
    request = urllib.request.Request(
        f"{API_ROOT}/releases/{release_id}",
        headers={
            "Authorization": f"Discogs token={token}",
            "User-Agent": USER_AGENT,
        },
    )

    delay = 0.0
    for attempt in range(MAX_RETRIES):
        if delay > 0:
            time.sleep(delay)

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                print(f"[miss]  Discogs release {release_id} no longer exists.")
                return None
            if error.code == 429:
                retry_after = error.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    delay = float(retry_after)
                else:
                    delay = min(60.0, 6.0 * (attempt + 1))
                print(f"[wait] Discogs rate limit hit, retrying in {delay:.1f}s...")
                continue

            if 500 <= error.code < 600 and attempt < MAX_RETRIES - 1:
                delay = min(30.0, 3.0 * (attempt + 1))
                print(f"[wait] Discogs error {error.code}, retrying in {delay:.1f}s...")
                continue
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            if attempt < MAX_RETRIES - 1:
                delay = min(20.0, 2.5 * (attempt + 1))
                print(f"[wait] Network error while talking to Discogs, retrying in {delay:.1f}s...")
                continue
            raise

    return None


def fetch_master_details(master_id: str, token: str) -> Dict[str, object] | None:
    request = urllib.request.Request(
        f"{API_ROOT}/masters/{master_id}",
        headers={
            "Authorization": f"Discogs token={token}",
            "User-Agent": USER_AGENT,
        },
    )

    delay = 0.0
    for attempt in range(MAX_RETRIES):
        if delay > 0:
            time.sleep(delay)

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code == 429:
                retry_after = error.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    delay = float(retry_after)
                else:
                    delay = min(60.0, 6.0 * (attempt + 1))
                print(f"[wait] Discogs rate limit hit, retrying in {delay:.1f}s...")
                continue

            if 500 <= error.code < 600 and attempt < MAX_RETRIES - 1:
                delay = min(30.0, 3.0 * (attempt + 1))
                print(f"[wait] Discogs error {error.code}, retrying in {delay:.1f}s...")
                continue
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            if attempt < MAX_RETRIES - 1:
                delay = min(20.0, 2.5 * (attempt + 1))
                print(f"[wait] Network error while talking to Discogs, retrying in {delay:.1f}s...")
                continue
            raise

    return None


def normalize_tracklist(entries: List[Dict[str, object]]) -> List[Dict[str, str]]:
    normalized = []
    current_heading = ""

    for entry in entries:
        entry_type = str(entry.get("type_", "track"))
        title = str(entry.get("title", "")).strip()

        if entry_type == "heading":
            current_heading = title
            continue

        sub_tracks = entry.get("sub_tracks") or []
        if sub_tracks:
            group_heading = title or current_heading
            for sub_track in sub_tracks:
                sub_title = str(sub_track.get("title", "")).strip()
                if not sub_title:
                    continue
                normalized.append(
                    {
                        "position": str(sub_track.get("position", "")).strip(),
                        "title": sub_title,
                        "duration": str(sub_track.get("duration", "")).strip(),
                        "heading": group_heading,
                    }
                )
            continue

        if not title:
            continue

        normalized.append(
            {
                "position": str(entry.get("position", "")).strip(),
                "title": title,
                "duration": str(entry.get("duration", "")).strip(),
                "heading": current_heading,
            }
        )

    return normalized


def normalize_cover_url(value: object) -> str:
    url = str(value or "").strip()
    if not url:
        return ""
    if "spacer.gif" in url.lower():
        return ""
    return url


def pick_cover_urls(details: Dict[str, object]) -> tuple[str, str]:
    cover_url = ""
    thumb_url = ""

    for image in details.get("images") or []:
        if not cover_url:
            cover_url = normalize_cover_url(image.get("uri"))
        if not thumb_url:
            thumb_url = normalize_cover_url(image.get("uri150"))
        if cover_url and thumb_url:
            break

    if not cover_url:
        cover_url = thumb_url
    if not thumb_url:
        thumb_url = cover_url

    return cover_url, thumb_url


def flatten_formats(formats: List[Dict[str, object]]) -> List[str]:
    flattened: List[str] = []
    for fmt in formats:
        name = str(fmt.get("name", "")).strip()
        if name:
            flattened.append(name)
        for description in fmt.get("descriptions") or []:
            text = str(description).strip()
            if text:
                flattened.append(text)
        extra_text = str(fmt.get("text", "")).strip()
        if extra_text:
            flattened.append(extra_text)
    return flattened


def primary_media_type(formats: List[Dict[str, object]]) -> str:
    if not formats:
        return ""
    return str(formats[0].get("name", "")).strip()


def is_vinyl_format(formats: List[Dict[str, object]]) -> bool:
    return any(str(fmt.get("name", "")).strip().lower() == "vinyl" for fmt in formats)


def canonical_discogs_url(value: str) -> str:
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"https://www.discogs.com{value}"


def extract_master_id(details: Dict[str, object]) -> str:
    master_id = str(details.get("master_id") or "").strip()
    if master_id:
        return master_id

    match = re.search(r"/masters/(\d+)", str(details.get("master_url") or ""))
    if match:
        return match.group(1)
    return ""


def backfill_record_metadata(record: Dict[str, object], details: Dict[str, object]) -> None:
    year_text = format_year(details.get("year"))
    if year_text and is_missing(record.get("year")):
        record["year"] = year_text

    country_text = normalize_country(details.get("country"))
    if country_text and is_missing(record.get("country")):
        record["country"] = country_text

    genre_groups = build_genre_groups(details)
    if genre_groups and is_missing(record.get("genre")):
        record["genre"] = " / ".join(genre_groups)
    if genre_groups and not record.get("genreGroups"):
        record["genreGroups"] = genre_groups

    year_sort = extract_year(str(record.get("year", "")))
    if year_sort is not None:
        record["yearSort"] = year_sort

    record["searchText"] = build_search_text(record)


def build_genre_groups(details: Dict[str, object]) -> List[str]:
    groups: List[str] = []
    for value in list(details.get("genres") or []) + list(details.get("styles") or []):
        text = str(value or "").strip()
        if text and text not in groups:
            groups.append(text)
    return groups


def normalize_country(value: object) -> str:
    text = str(value or "").strip()
    if not text or text in {"Unknown", "None"}:
        return ""
    return COUNTRY_MAP.get(text, text)


def format_year(value: object) -> str:
    if isinstance(value, int):
        return str(value)
    text = str(value or "").strip()
    return text if extract_year(text) is not None else ""


def extract_year(value: str) -> int | None:
    match = re.search(r"(19|20)\d{2}", value)
    if match:
        return int(match.group(0))
    return None


def build_search_text(record: Dict[str, object]) -> str:
    parts = [
        record.get("artist", ""),
        record.get("title", ""),
        record.get("year", ""),
        record.get("genre", ""),
        " / ".join(record.get("discogsGenres") or []),
        " / ".join(record.get("discogsStyles") or []),
        record.get("label", ""),
        record.get("catalogNumber", ""),
        record.get("country", ""),
        record.get("coverCondition", ""),
        record.get("discCondition", ""),
        record.get("notes", ""),
    ]
    return normalize_text(" ".join(str(part or "") for part in parts))


def is_missing(value: object) -> bool:
    return str(value or "").strip().lower() in MISSING_MARKERS


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    return "".join(character for character in normalized if not unicodedata.combining(character)).lower()


def parse_record_numbers(value: str) -> set[str]:
    if not value.strip():
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


if __name__ == "__main__":
    main()
