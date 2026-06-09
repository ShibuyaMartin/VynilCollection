#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import re
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
API_ROOT = "https://api.discogs.com"
MAX_RETRIES = 4
ALLOWED_PROXY_HOSTS = {
    "i.discogs.com",
    "img.discogs.com",
    "imagescdn.juno.co.uk",
    "shibu.pro",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the vinyl app with local image proxy support.")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Project root to serve. Defaults to the VynilCollection directory.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind. Defaults to 127.0.0.1.")
    parser.add_argument("--port", type=int, default=4173, help="Port to bind. Defaults to 4173.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    server = PreviewServer((args.host, args.port), PreviewHandler, root=root)
    print(f"Serving {root} at http://{args.host}:{args.port}/vinilos/", flush=True)
    server.serve_forever()


class PreviewServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_class, root: Path):
        super().__init__(server_address, handler_class)
        self.root = root
        self.collection_path = root / "data" / "collection.json"
        self.discogs_token = os.environ.get("DISCOGS_USER_TOKEN", "").strip()
        self._collection_cache_mtime = 0.0
        self._collection_cache: List[Dict[str, object]] = []
        self._cover_cache: Dict[str, tuple[str, bytes]] = {}
        self._remote_cache: Dict[str, tuple[str, bytes]] = {}
        self.timeout = 1

    def load_collection(self) -> List[Dict[str, object]]:
        if not self.collection_path.exists():
            return []
        stat = self.collection_path.stat()
        if stat.st_mtime != self._collection_cache_mtime:
            payload = json.loads(self.collection_path.read_text(encoding="utf-8"))
            self._collection_cache = payload.get("records", [])
            self._collection_cache_mtime = stat.st_mtime
        return self._collection_cache

    def find_record(self, number: str) -> Dict[str, object] | None:
        return next((record for record in self.load_collection() if str(record.get("number")) == number), None)

    def fetch_discogs_cover_for_record(self, record: Dict[str, object]) -> tuple[str, bytes] | None:
        release_id = str(record.get("discogsReleaseId") or "").strip()
        if not release_id:
            release_id = extract_release_id(str(record.get("discogsUrl") or ""))
        if not release_id or not self.discogs_token:
            return None

        if release_id in self._cover_cache:
            return self._cover_cache[release_id]

        details = fetch_release_details(release_id, self.discogs_token)
        if not details:
            return None

        image_url = ""
        for image in details.get("images") or []:
            image_url = str(image.get("uri") or "").strip()
            if image_url:
                break
        if not image_url:
            return None

        content_type, body = self.fetch_remote_url(image_url)
        if not body:
            return None

        self._cover_cache[release_id] = (content_type, body)
        return content_type, body

    def fetch_remote_url(self, url: str) -> tuple[str, bytes]:
        cached = self._remote_cache.get(url)
        if cached:
            return cached

        content_type, body = fetch_remote_bytes(url)
        self._remote_cache[url] = (content_type, body)
        return content_type, body


class PreviewHandler(SimpleHTTPRequestHandler):
    server: PreviewServer

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)

        if parsed.path == "/":
            self.send_response(302)
            self.send_header("Location", "/vinilos/")
            self.end_headers()
            return

        if parsed.path == "/yt-search":
            self.send_json({"videoId": None})
            return

        if parsed.path == "/vinilos/cover-proxy":
            self.handle_cover_proxy(parsed.query)
            return

        if parsed.path.startswith("/vinilos/covers/"):
            if self.handle_local_or_virtual_cover(parsed.path):
                return

        super().do_GET()

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlsplit(path)
        request_path = parsed.path

        if request_path in {"/vinilos", "/vinilos/"}:
            relative = ""
        elif request_path.startswith("/vinilos/"):
            relative = request_path[len("/vinilos/") :]
        else:
            relative = "__not_found__"

        normalized = posixpath.normpath(relative)
        if normalized == ".":
            normalized = ""
        normalized = normalized.lstrip("/")
        return str(self.server.root / normalized)

    def log_message(self, format: str, *args) -> None:
        print(f"[http] {self.address_string()} - " + format % args, flush=True)

    def send_json(self, payload: Dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_cover_proxy(self, query_string: str) -> None:
        query = urllib.parse.parse_qs(query_string)
        target = str((query.get("url") or [""])[0]).strip()
        if not target:
            self.send_error(400, "Missing url parameter")
            return

        if not is_allowed_proxy_url(target):
            self.send_error(403, "URL not allowed")
            return

        try:
            content_type, body = self.server.fetch_remote_url(target)
        except urllib.error.HTTPError as error:
            self.send_error(error.code, "Remote image fetch failed")
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            self.send_error(504, "Remote image timeout")
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_local_or_virtual_cover(self, request_path: str) -> bool:
        filesystem_path = Path(self.translate_path(request_path))
        if filesystem_path.exists():
            return False

        match = re.search(r"/vinilos/covers/(\d+)\.[a-zA-Z0-9]+$", request_path)
        if not match:
            self.send_error(404, "Cover not found")
            return True

        record = self.server.find_record(match.group(1))
        if not record:
            self.send_error(404, "Record not found")
            return True

        source_url = str(record.get("coverUrl") or record.get("thumbUrl") or "").strip()
        if source_url.startswith("http://") or source_url.startswith("https://"):
            try:
                content_type, body = self.server.fetch_remote_url(source_url)
                self.send_image_bytes(content_type, body)
                return True
            except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout, TimeoutError):
                pass

        cover = self.server.fetch_discogs_cover_for_record(record)
        if cover:
            content_type, body = cover
            self.send_image_bytes(content_type, body)
            return True

        self.send_error(404, "Cover unavailable")
        return True

    def send_image_bytes(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type or "image/jpeg")
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def is_allowed_proxy_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme == "https" and parsed.netloc in ALLOWED_PROXY_HOSTS


def fetch_remote_bytes(url: str) -> tuple[str, bytes]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.netloc.endswith("discogs.com"):
        return fetch_remote_bytes_via_curl(url)

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }
    if parsed.netloc.endswith("discogs.com"):
        headers["Referer"] = "https://www.discogs.com/"

    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=25) as response:
        content_type = response.headers.get("Content-Type") or guess_content_type(url)
        return content_type, response.read()


def fetch_remote_bytes_via_curl(url: str) -> tuple[str, bytes]:
    command = [
        "curl",
        "-L",
        "-sS",
        "-f",
        "--max-time",
        "25",
        "-A",
        USER_AGENT,
        "-H",
        "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "-H",
        "Referer: https://www.discogs.com/",
        url,
    ]

    try:
        result = subprocess.run(command, check=True, capture_output=True)
    except subprocess.CalledProcessError as error:
        raise urllib.error.HTTPError(url, 502, "curl fetch failed", None, None) from error

    return guess_content_type(url), result.stdout


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
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code == 429 and attempt < MAX_RETRIES - 1:
                retry_after = error.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 6.0 * (attempt + 1)
                continue
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError):
            if attempt < MAX_RETRIES - 1:
                delay = 2.5 * (attempt + 1)
                continue
            raise

    return None


def extract_release_id(value: str) -> str:
    match = re.search(r"/release/(\d+)", value)
    return match.group(1) if match else ""


def guess_content_type(url: str) -> str:
    content_type, _ = mimetypes.guess_type(url)
    return content_type or "image/jpeg"


if __name__ == "__main__":
    main()
