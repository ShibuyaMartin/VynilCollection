#!/usr/bin/env python3

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, List

USER_AGENT = "MyVynilCollection/1.0 +local"
API_URL = "https://api.discogs.com/database/search"
API_ROOT = "https://api.discogs.com"
MAX_RETRIES = 6
MISSING_MARKERS = {"", "-", "n/a", "na", "unknown"}
VALIDATION_CANDIDATE_LIMIT = 10
MIN_MATCH_SCORE = 0.32


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Search Discogs and attach cover art URLs to the generated collection JSON."
    )
    parser.add_argument("collection_json", type=Path, help="Path to data/collection.json")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional output path. Defaults to overwriting the input file.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional limit for how many records to process in this run.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=1.1,
        help="Delay between requests to stay well under Discogs rate limits.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Refresh records even when they already have a Discogs URL.",
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

    output_path = args.output or args.collection_json
    payload = json.loads(args.collection_json.read_text(encoding="utf-8"))
    records = payload.get("records", [])
    target_numbers = parse_record_numbers(args.record_numbers)

    matched = 0
    skipped = 0
    processed = 0

    for record in records:
        if target_numbers and str(record.get("number")) not in target_numbers:
            continue

        if args.limit is not None and processed >= args.limit:
            break

        has_discogs = bool(record.get("discogsUrl"))
        has_cover = bool(record.get("coverUrl") or record.get("thumbUrl"))

        if has_discogs and not args.overwrite:
            skipped += 1
            continue

        if has_discogs and has_cover and args.overwrite:
            skipped += 1
            continue

        match = search_best_match(record, token)
        processed += 1

        if match:
            previous_release_url = (
                record.get("discogsReleaseUrl")
                or record.get("discogsCanonicalUrl")
                or record.get("discogsUrl")
            )
            record["coverUrl"] = match["cover_url"]
            record["thumbUrl"] = match["thumb_url"]
            record["discogsUrl"] = match.get("master_url") or match["discogs_url"]
            record["matchScore"] = match["score"]
            record["discogsSearchFormats"] = match["formats"]
            record["discogsCanonicalUrl"] = match["discogs_url"]
            record["discogsReleaseUrl"] = match["discogs_url"]
            record["discogsMasterId"] = match.get("master_id", "")
            record["discogsMasterUrl"] = match.get("master_url", "")
            record["discogsFormats"] = match["formats"]
            record["discogsMediaType"] = match.get("media_type", "")
            record["discogsIsVinyl"] = bool(match.get("is_vinyl"))
            record["discogsGenres"] = match.get("genres", [])
            record["discogsStyles"] = match.get("styles", [])

            if previous_release_url != match["discogs_url"]:
                record.pop("tracklist", None)
                record.pop("discogsReleaseId", None)
            matched += 1
            print(f"[match] {record['number']}: {record['artist']} - {record['title']}")
        else:
            if args.overwrite:
                clear_discogs_data(record)
            print(f"[miss]  {record['number']}: {record['artist']} - {record['title']}")

        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        time.sleep(args.sleep)

    print(
        f"Processed {processed} records, matched {matched}, skipped {skipped}. Output: {output_path}"
    )


def search_best_match(record: Dict[str, object], token: str) -> Dict[str, object] | None:
    best_match: Dict[str, object] | None = None
    details_cache: Dict[str, Dict[str, object] | None] = {}
    masters_cache: Dict[str, Dict[str, object] | None] = {}

    for result_type in ("release", "master"):
        queries = build_queries(record, result_type=result_type)
        for params in queries:
            results = search_discogs(params, token)
            candidates = rank_candidates(record, results, result_type=result_type)

            for candidate in candidates[:VALIDATION_CANDIDATE_LIMIT]:
                release_id = str(candidate.get("release_id") or "")
                if not release_id and candidate.get("result_type") == "master":
                    master_id = str(candidate.get("master_id") or "")
                    if master_id:
                        if master_id not in masters_cache:
                            masters_cache[master_id] = fetch_master_details(master_id, token)
                        master_details = masters_cache[master_id]
                        if master_details:
                            release_id = str(master_details.get("main_release") or "")
                if not release_id:
                    continue

                if release_id not in details_cache:
                    details_cache[release_id] = fetch_release_details(release_id, token)
                details = details_cache[release_id]
                if not details:
                    continue

                formats = details.get("formats") or []
                if not is_vinyl_format_details(formats):
                    continue

                cover_url, thumb_url = pick_cover_urls(
                    primary_cover=candidate.get("cover_url"),
                    primary_thumb=candidate.get("thumb_url"),
                    details=details,
                )
                if not cover_url:
                    continue

                candidate["cover_url"] = cover_url
                candidate["thumb_url"] = thumb_url or cover_url
                candidate["discogs_url"] = canonical_discogs_url(details.get("uri") or candidate["discogs_url"])
                master_id = str(candidate.get("master_id") or details.get("master_id") or "").strip()
                master_url = ""
                if master_id:
                    if master_id not in masters_cache:
                        masters_cache[master_id] = fetch_master_details(master_id, token)
                    master_details = masters_cache[master_id]
                    if master_details and master_details.get("uri"):
                        master_url = canonical_discogs_url(str(master_details.get("uri")))
                    else:
                        master_url = canonical_discogs_url(f"/master/{master_id}")
                candidate["master_id"] = master_id
                candidate["master_url"] = master_url
                candidate["formats"] = flatten_formats(formats) or candidate["formats"]
                candidate["media_type"] = primary_media_type(formats)
                candidate["is_vinyl"] = True
                candidate["genres"] = list(details.get("genres") or [])
                candidate["styles"] = list(details.get("styles") or [])

                if best_match is None or candidate["score"] > best_match["score"]:
                    best_match = candidate

                if candidate["score"] >= 0.9:
                    return candidate

    if best_match and best_match["score"] >= MIN_MATCH_SCORE:
        return best_match
    return None


def clear_discogs_data(record: Dict[str, object]) -> None:
    for key in [
        "coverUrl",
        "thumbUrl",
        "discogsUrl",
        "matchScore",
        "discogsSearchFormats",
        "tracklist",
        "discogsCanonicalUrl",
        "discogsReleaseUrl",
        "discogsReleaseId",
        "discogsMasterId",
        "discogsMasterUrl",
        "discogsFormats",
        "discogsMediaType",
        "discogsIsVinyl",
        "discogsGenres",
        "discogsStyles",
    ]:
        record.pop(key, None)


def parse_record_numbers(value: str) -> set[str]:
    if not value.strip():
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


def build_queries(record: Dict[str, object], result_type: str = "release") -> List[Dict[str, str]]:
    artist_variants = artist_query_variants(str(record.get("artist", "")))
    title_variants = title_query_variants(str(record.get("title", "")))
    year = str(record.get("yearSort") or "").strip()
    label = re.sub(r"\s+", " ", str(record.get("label", "") or "")).strip()
    catalog_number = str(record.get("catalogNumber", "") or "").strip()
    compact_catalog_number = re.sub(r"\s+", "", catalog_number)

    queries: List[Dict[str, str]] = []
    base: Dict[str, str] = {
        "type": result_type,
        "per_page": "50",
        "format": "Vinyl",
    }

    if normalize_catalog(catalog_number):
        catalog_variants = unique_nonempty([catalog_number, compact_catalog_number])
        primary_title = title_variants[0] if title_variants else ""

        for catalog_variant in catalog_variants:
            query = {**base, "catno": catalog_variant}
            if label and normalize_text(label) not in MISSING_MARKERS:
                query["label"] = label
            queries.append(query)

            if primary_title:
                queries.append({**query, "release_title": primary_title})

            if artist_variants:
                for artist in artist_variants[:3]:
                    detailed_query = {**query, "artist": artist}
                    if primary_title:
                        detailed_query["release_title"] = primary_title
                    if year:
                        detailed_query["year"] = year
                    queries.append(detailed_query)

                    freeform_query = " ".join(
                        part
                        for part in [artist, primary_title, label, catalog_variant]
                        if part and normalize_text(part) not in MISSING_MARKERS
                    )
                    if freeform_query:
                        queries.append({**base, "q": freeform_query})

    for query_title in title_variants:
        if artist_variants:
            for artist in artist_variants[:3]:
                query = {**base, "artist": artist, "release_title": query_title}
                if year:
                    query["year"] = year
                queries.append(query)

                queries.append({**base, "q": f"{artist} {query_title}".strip()})
                if year:
                    queries.append({**base, "q": f"{artist} {query_title} {year}".strip()})

        queries.append({**base, "release_title": query_title})
        queries.append({**base, "q": query_title})
        if year:
            queries.append({**base, "q": f"{query_title} {year}".strip()})

    deduped: List[Dict[str, str]] = []
    seen = set()
    for query in queries:
        signature = tuple(sorted(query.items()))
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(query)
    return deduped


def artist_query_variants(value: str) -> List[str]:
    cleaned = clean_artist(value)
    variants: List[str] = []
    if cleaned:
        variants.append(cleaned)

    collapsed = re.sub(r"\(.*?\)", "", value)
    for part in re.split(r"/|&|,|\by\b|\band\b|\bfeat\.?\b|\bwith\b", collapsed, flags=re.IGNORECASE):
        token = clean_artist(part)
        if token and len(token) >= 3:
            variants.append(token)

    return unique_nonempty(variants)


def title_query_variants(value: str) -> List[str]:
    cleaned = clean_title(value)
    short_title = simplify_title_for_query(cleaned)
    variants = [cleaned, short_title, strip_ensemble_suffix(cleaned), strip_ensemble_suffix(short_title)]

    for part in re.split(r"\s+[—-]\s+|\||/", value):
        token = clean_title(part)
        short_token = simplify_title_for_query(token)
        variants.extend([token, short_token])

    for part in re.findall(r"\(([^)]+)\)", value):
        token = clean_title(part)
        short_token = simplify_title_for_query(token)
        variants.extend([token, short_token, strip_ensemble_suffix(token), strip_ensemble_suffix(short_token)])

    return [token for token in unique_nonempty(variants) if len(token) >= 2]


def strip_ensemble_suffix(value: str) -> str:
    simplified = re.sub(
        r"\b(sextet|quintet|quartet|trio|duo|ensemble|session|sessions?|vol(?:ume)?\.?\s*\d*)\b",
        "",
        value or "",
        flags=re.IGNORECASE,
    )
    simplified = re.sub(r"\s{2,}", " ", simplified)
    return simplified.strip(" -")


def unique_nonempty(values: Iterable[str]) -> List[str]:
    deduped: List[str] = []
    seen = set()
    for value in values:
        normalized = re.sub(r"\s+", " ", str(value or "")).strip(" -")
        if not normalized:
            continue
        signature = normalize_text(normalized)
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(normalized)
    return deduped


def artist_signature_tokens(value: str) -> List[str]:
    collapsed = re.sub(r"\(.*?\)", "", value)
    tokens: List[str] = []

    for part in re.split(r"/|&|\band\b|\by\b|\bfeat\.?\b|\bwith\b", collapsed, flags=re.IGNORECASE):
        normalized = normalize_text(clean_artist(part))
        pieces = [piece for piece in re.split(r"[^a-z0-9]+", normalized) if len(piece) >= 3]
        if not pieces:
            continue
        tokens.append(pieces[0])

    # Keep insertion order while deduplicating.
    seen = set()
    signatures: List[str] = []
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        signatures.append(token)
    return signatures


def contains_artist_signatures(value: str, signatures: List[str]) -> bool:
    if len(signatures) < 2:
        return True
    blob = normalize_text(value)
    blob_tokens = {piece for piece in re.split(r"[^a-z0-9]+", blob) if piece}
    matched = sum(1 for signature in signatures if signature in blob_tokens)
    return matched >= 2


def search_discogs(params: Dict[str, str], token: str) -> List[Dict[str, object]]:
    query_string = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{API_URL}?{query_string}",
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
                payload = json.loads(response.read().decode("utf-8"))
                return payload.get("results", [])
        except urllib.error.HTTPError as error:
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
        except urllib.error.URLError:
            if attempt < MAX_RETRIES - 1:
                delay = min(20.0, 2.5 * (attempt + 1))
                print(f"[wait] Network error while talking to Discogs, retrying in {delay:.1f}s...")
                continue
            raise

    return []


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
        except urllib.error.URLError:
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
        except urllib.error.URLError:
            if attempt < MAX_RETRIES - 1:
                delay = min(20.0, 2.5 * (attempt + 1))
                print(f"[wait] Network error while talking to Discogs, retrying in {delay:.1f}s...")
                continue
            raise

    return None


def rank_candidates(
    record: Dict[str, object], results: Iterable[Dict[str, object]], result_type: str = "release"
) -> List[Dict[str, object]]:
    artist_target = normalize_text(clean_artist(str(record.get("artist", ""))))
    artist_signatures = artist_signature_tokens(str(record.get("artist", "")))
    title_target = normalize_text(clean_title(str(record.get("title", ""))))
    year_target = record.get("yearSort")
    label_target = normalize_text(str(record.get("label", "")))
    catalog_target = normalize_catalog(str(record.get("catalogNumber", "")))
    country_target = normalize_country(str(record.get("country", "")))

    candidates: List[Dict[str, object]] = []

    for result in results:
        formats = result.get("format") or []
        if formats and not is_vinyl_release(formats):
            continue

        title_blob = str(result.get("title", ""))
        if not contains_artist_signatures(title_blob, artist_signatures):
            continue

        title_artist, title_album = split_result_title(title_blob)
        artist_value = normalize_text(title_artist)
        title_value = normalize_text(title_album)

        artist_score = max(similarity(artist_target, artist_value), token_similarity(artist_target, artist_value))
        title_score = max(similarity(title_target, title_value), token_similarity(title_target, title_value))
        label_score = similarity(label_target, normalize_text(" ".join(result.get("label", []) or [])))
        catalog_score = similarity(catalog_target, normalize_catalog(str(result.get("catno", ""))))
        country_score = similarity(country_target, normalize_country(str(result.get("country", ""))))

        if title_score < 0.22 and artist_score < 0.72:
            continue

        year_score = 0.0
        result_year = result.get("year")
        if year_target and result_year:
            result_year_int = parse_year_int(str(result_year))
            target_year_int = parse_year_int(str(year_target))
            if result_year_int and target_year_int:
                year_distance = abs(result_year_int - target_year_int)
                year_score = 1.0 if year_distance == 0 else 0.65 if year_distance <= 1 else 0.0

        score = (
            (title_score * 0.5)
            + (artist_score * 0.26)
            + (label_score * 0.08)
            + (catalog_score * 0.08)
            + (country_score * 0.04)
            + (year_score * 0.04)
        )

        candidate = {
            "cover_url": result.get("cover_image") or result.get("thumb"),
            "thumb_url": result.get("thumb") or result.get("cover_image"),
            "discogs_url": result.get("uri"),
            "score": round(score, 4),
            "formats": formats,
            "release_id": result.get("id") if result_type == "release" else result.get("main_release"),
            "master_id": result.get("id") if result_type == "master" else None,
            "result_type": result_type,
        }

        if not candidate["discogs_url"]:
            continue

        candidates.append(candidate)

    return sorted(candidates, key=lambda candidate: candidate["score"], reverse=True)


def split_result_title(value: str) -> tuple[str, str]:
    if " - " in value:
        artist, album = value.split(" - ", 1)
        return artist, album
    return value, value


def similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(None, left, right).ratio()


def token_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.0

    left_tokens = {token for token in re.split(r"[^a-z0-9]+", left) if token}
    right_tokens = {token for token in re.split(r"[^a-z0-9]+", right) if token}
    if not left_tokens or not right_tokens:
        return 0.0
    intersection = left_tokens & right_tokens
    union = left_tokens | right_tokens
    return len(intersection) / len(union)


def is_vinyl_release(formats: Iterable[object]) -> bool:
    normalized_formats = [normalize_text(str(value)) for value in formats]
    return any("vinyl" in value for value in normalized_formats)


def is_vinyl_format_details(formats: List[Dict[str, object]]) -> bool:
    return any(str(fmt.get("name", "")).strip().lower() == "vinyl" for fmt in formats)


def clean_artist(value: str) -> str:
    cleaned = value.replace("/", ", ")
    cleaned = cleaned.replace(",", " ")
    return re.sub(r"\s+", " ", cleaned).strip(" -")


def clean_title(value: str) -> str:
    cleaned = value
    cleaned = cleaned.replace("OST", "Original Soundtrack")
    cleaned = re.sub(
        r"\bm[úu]sica\s+de\s+la\s+pel[íi]cula(?:\s+por.*)?",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\bmusic from the original motion picture soundtrack\b.*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\boriginal motion picture soundtrack\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+[—-]\s+", " ", cleaned)
    cleaned = re.sub(r"\(.*?\)", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip(" -")


def simplify_title_for_query(value: str) -> str:
    simplified = value
    simplified = re.sub(
        r"\bm[úu]sica\s+de\s+la\s+pel[íi]cula(?:\s+por.*)?",
        "",
        simplified,
        flags=re.IGNORECASE,
    )
    simplified = re.sub(r"\s+[/|].*", "", simplified)
    simplified = re.sub(r"\s{2,}", " ", simplified)
    return simplified.strip(" -")


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value or "")
    simplified = "".join(character for character in normalized if not unicodedata.combining(character))
    return simplified.lower()


def parse_year_int(value: str) -> int | None:
    match = re.search(r"\b(19|20)\d{2}\b", value or "")
    if not match:
        return None
    return int(match.group(0))


def normalize_catalog(value: str) -> str:
    if normalize_text(value) in MISSING_MARKERS:
        return ""
    return re.sub(r"[^a-z0-9]+", "", normalize_text(value))


def normalize_country(value: str) -> str:
    normalized = normalize_text(value)
    if normalized in MISSING_MARKERS:
        return ""

    aliases = {
        "reino unido": "uk",
        "united kingdom": "uk",
        "england": "uk",
        "estados unidos": "usa",
        "united states": "usa",
        "u.s.a.": "usa",
        "u.s.a": "usa",
    }

    parts = [aliases.get(part.strip(), part.strip()) for part in normalized.split("/") if part.strip()]
    return " ".join(sorted(parts))


def normalize_cover_url(value: object) -> str:
    url = str(value or "").strip()
    if not url:
        return ""
    if "spacer.gif" in url.lower():
        return ""
    return url


def pick_cover_urls(
    primary_cover: object, primary_thumb: object, details: Dict[str, object]
) -> tuple[str, str]:
    cover_url = normalize_cover_url(primary_cover)
    thumb_url = normalize_cover_url(primary_thumb)

    if cover_url and thumb_url:
        return cover_url, thumb_url

    for image in details.get("images") or []:
        detail_cover = normalize_cover_url(image.get("uri"))
        detail_thumb = normalize_cover_url(image.get("uri150"))
        if detail_cover and not cover_url:
            cover_url = detail_cover
        if detail_thumb and not thumb_url:
            thumb_url = detail_thumb
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


def canonical_discogs_url(value: str) -> str:
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"https://www.discogs.com{value}"


if __name__ == "__main__":
    main()
