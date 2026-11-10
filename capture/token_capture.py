"""
mitmproxy addon used by `bevel-mcp token capture`. Not meant to be run on its own.

It watches requests from YOUR Bevel app to api.supersethealth.com. Each valid, unexpired Bevel
token in an Authorization header is considered, and the one that expires LATEST is written to the
private file given by `--set bevel_token_out=<path>` (owner-only permissions) as
{"token": ..., "distinct": <number of different tokens seen>}. Parts of the app can hold older
tokens (seen live: a request carrying a token issued weeks before the main app's), so the newest
wins. The CLI then moves the token into the macOS Keychain and deletes the file.

Nothing else is recorded: no other hosts, headers or bodies, and the token is never logged.
"""

from __future__ import annotations

import base64
import json
import os
import time

from mitmproxy import ctx, http

BEVEL_HOST = "api.supersethealth.com"


def _decode_segment(segment: str) -> dict:
    padded = segment + "=" * (-len(segment) % 4)
    value = json.loads(base64.urlsafe_b64decode(padded))
    if not isinstance(value, dict):
        raise ValueError("not a JSON object")
    return value


def bevel_token_from_header(header: str, now: float | None = None) -> str | None:
    """Returns the bearer token if it looks like a current Bevel token, else None."""
    found = bevel_token_and_expiry(header, now)
    return found[0] if found else None


def bevel_token_and_expiry(header: str, now: float | None = None) -> tuple[str, float] | None:
    """(token, exp) if the header carries a current Bevel token, else None."""
    if not header.lower().startswith("bearer "):
        return None
    token = header[7:].strip()
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        return None
    try:
        claims = _decode_segment(parts[1])
    except Exception:
        return None
    # Bevel tokens carry userId/iat/exp (seen in captures).
    exp = claims.get("exp")
    if "userId" not in claims or not isinstance(exp, (int, float)):
        return None
    if exp <= (now if now is not None else time.time()):
        return None
    return token, float(exp)


class TokenCapture:
    def __init__(self) -> None:
        self.best: tuple[str, float] | None = None
        self.seen: set[str] = set()

    @property
    def done(self) -> bool:
        return self.best is not None

    def load(self, loader) -> None:
        loader.add_option("bevel_token_out", str, "", "File to write the captured Bevel token to")
        loader.add_option("bevel_capture_ready", str, "", "Marker that the Bevel proxy is ready")

    def running(self) -> None:
        if ctx.options.bevel_capture_ready:
            fd = os.open(ctx.options.bevel_capture_ready, os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(fd)

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host != BEVEL_HOST:
            return
        out = ctx.options.bevel_token_out
        if not out:
            return
        found = bevel_token_and_expiry(flow.request.headers.get("authorization", ""))
        if found is None:
            return
        token, exp = found
        is_new = token not in self.seen
        self.seen.add(token)
        if self.best is not None and exp <= self.best[1] and not is_new:
            return
        if self.best is None or exp > self.best[1]:
            self.best = (token, exp)
        self._write(out)
        if is_new:
            ctx.log.info(f"[bevel] token seen ({len(self.seen)} distinct so far)")

    def _write(self, out: str) -> None:
        assert self.best is not None
        payload = json.dumps({"token": self.best[0], "distinct": len(self.seen)})
        tmp = f"{out}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(payload)
        os.replace(tmp, out)


addons = [TokenCapture()]
