"""Tests for capture/token_capture.py (needs mitmproxy: pip install mitmproxy). Run: python test/python/test_token_capture.py"""
import base64
import json
import os
import stat
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "capture"))
from mitmproxy.test import taddons, tflow  # noqa: E402

import token_capture as tc  # noqa: E402


def b64(obj):
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")


def jwt(claims):
    return f"{b64({'alg': 'RS256', 'typ': 'JWT'})}.{b64(claims)}.sig"


now = int(time.time())
older = jwt({"userId": "u", "iat": now - 86400 * 20, "exp": now + 86400 * 39})
newer = jwt({"userId": "u", "iat": now, "exp": now + 86400 * 60})
expired = jwt({"userId": "u", "iat": 1, "exp": 2})
foreign = jwt({"sub": "x", "exp": now + 3600})

assert tc.bevel_token_from_header(f"Bearer {newer}") == newer
assert tc.bevel_token_from_header(f"bearer {newer}") == newer
assert tc.bevel_token_and_expiry(f"Bearer {older}")[1] == now + 86400 * 39
assert tc.bevel_token_from_header(f"Bearer {expired}") is None, "expired tokens are ignored"
assert tc.bevel_token_from_header(f"Bearer {foreign}") is None, "needs Bevel's userId claim"
assert tc.bevel_token_from_header("Basic abc") is None
assert tc.bevel_token_from_header("Bearer not.a.jwt") is None

out = os.path.join(tempfile.mkdtemp(), "token")
addon = tc.TokenCapture()


def send(host, token):
    flow = tflow.tflow()
    flow.request.host = host
    flow.request.headers["Authorization"] = f"Bearer {token}"
    addon.request(flow)


with taddons.context(addon) as tctx:
    tctx.configure(addon, bevel_token_out=out)
    send("example.com", newer)
    assert not os.path.exists(out), "other hosts are ignored"
    send("api.supersethealth.com", expired)
    assert not os.path.exists(out), "expired tokens are ignored"
    send("api.supersethealth.com", older)
    assert json.load(open(out)) == {"token": older, "distinct": 1}
    send("api.supersethealth.com", newer)
    assert json.load(open(out)) == {"token": newer, "distinct": 2}, "a newer token wins"
    send("api.supersethealth.com", older)
    assert json.load(open(out)) == {"token": newer, "distinct": 2}, "an older token never replaces a newer one"

assert stat.S_IMODE(os.stat(out).st_mode) == 0o600, "owner-only file"
print("token_capture addon: OK")
