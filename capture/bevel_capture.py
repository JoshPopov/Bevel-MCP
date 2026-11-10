"""
mitmproxy addon: save Bevel API traffic as token-redacted JSON files.

Usage (from the repo root, with your iPhone already proxied through mitmproxy):

    mitmweb -s capture/bevel_capture.py
    # or headless:
    mitmdump -s capture/bevel_capture.py --set bevel_out=fixtures/captures

For every request to api.supersethealth.com it writes one file:

    fixtures/captures/<timestamp>_<METHOD>_<path>.json

containing method, path, query, request/response headers and JSON bodies. Authorization,
Cookie and similar headers, and any JWT-shaped string anywhere, are replaced with "<redacted>".

For every *other* host it only appends "METHOD host path" (no query, no bodies) to
fixtures/captures/hosts.txt. That shows which auth service the app talks to (for example
securetoken.googleapis.com) without saving refresh tokens or passwords.

The output still contains your personal health data. fixtures/captures/ is gitignored:
review files before copying any into test/fixtures/.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from mitmproxy import ctx, http

API_HOSTS = {"api.supersethealth.com"}
REDACTED = "<redacted>"
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")
BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
SENSITIVE_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-firebase-appcheck",
    "x-goog-api-key",
}
SENSITIVE_KEY_RE = re.compile(r"token|secret|password|authorization|cookie|api[_-]?key", re.IGNORECASE)
MAX_TEXT_BODY = 20_000


def redact_text(value: str) -> str:
    return JWT_RE.sub(REDACTED, BEARER_RE.sub(r"\1" + REDACTED, value))


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: (REDACTED if SENSITIVE_KEY_RE.search(str(k)) else redact(v)) for k, v in value.items()}
    return value


def redact_headers(headers: http.Headers) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in headers.items(multi=True):
        clean = REDACTED if name.lower() in SENSITIVE_HEADERS else redact_text(value)
        out[name] = f"{out[name]}, {clean}" if name in out else clean
    return out


def body_of(message: http.Message | None) -> dict[str, Any] | None:
    if message is None or not message.raw_content:
        return None
    text = message.get_text(strict=False) or ""
    try:
        return {"json": redact(json.loads(text))}
    except ValueError:
        cleaned = redact_text(text)
        clipped = cleaned if len(cleaned) <= MAX_TEXT_BODY else cleaned[:MAX_TEXT_BODY] + "…"
        return {"text": clipped, "contentType": message.headers.get("content-type", "")}


def slug(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", path.strip("/"))[:120].strip("-") or "root"


class BevelCapture:
    def __init__(self) -> None:
        self.seen_hosts: set[str] = set()
        self.counter = 0

    def load(self, loader) -> None:
        loader.add_option("bevel_out", str, "fixtures/captures", "Directory for redacted Bevel captures")

    @property
    def out_dir(self) -> Path:
        path = Path(ctx.options.bevel_out)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host in API_HOSTS:
            self.save_api_flow(flow)
        else:
            self.note_host(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host in API_HOSTS:
            self.save_api_flow(flow)

    def save_api_flow(self, flow: http.HTTPFlow) -> None:
        req, res = flow.request, flow.response
        self.counter += 1
        stamp = time.strftime("%Y%m%dT%H%M%S", time.localtime(req.timestamp_start))
        path = req.path.split("?", 1)[0]
        name = f"{stamp}_{self.counter:04d}_{req.method}_{slug(path)}.json"
        record = {
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(req.timestamp_start)),
            "request": {
                "method": req.method,
                "host": req.pretty_host,
                "path": path,
                "query": redact({k: v for k, v in req.query.items(multi=True)}),
                "headers": redact_headers(req.headers),
                "body": body_of(req),
            },
            "response": None
            if res is None
            else {
                "status": res.status_code,
                "headers": redact_headers(res.headers),
                "body": body_of(res),
            },
            "error": str(flow.error) if flow.error else None,
        }
        target = self.out_dir / name
        target.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        ctx.log.info(f"[bevel] saved {req.method} {record['request']['path']} -> {target}")

    def note_host(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        line = f"{req.method} {req.pretty_host} {req.path.split('?', 1)[0]}"
        if line in self.seen_hosts:
            return
        self.seen_hosts.add(line)
        with (self.out_dir / "hosts.txt").open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")


addons = [BevelCapture()]
