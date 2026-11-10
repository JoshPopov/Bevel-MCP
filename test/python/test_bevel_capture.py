"""Tests for capture/bevel_capture.py (needs mitmproxy). Run: python test/python/test_bevel_capture.py"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "capture"))
from mitmproxy.test import taddons, tflow  # noqa: E402

import bevel_capture as bc  # noqa: E402

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
out = Path(tempfile.mkdtemp())
addon = bc.BevelCapture()
with taddons.context(addon) as tctx:
    tctx.configure(addon, bevel_out=str(out))
    api = tflow.tflow(resp=True)
    api.request.host = "api.supersethealth.com"
    api.request.method = "POST"
    api.request.path = "/api/journal/v1/user-journal-data/push?x=1&refresh_token=abc"
    api.request.headers["Authorization"] = f"Bearer {JWT}"
    api.request.headers["bevel-app-version"] = "3.2.7"
    api.request.set_text(json.dumps({"booleanJournals": [{"uuid": "U1", "note": f"tok {JWT}"}], "idToken": "zzz"}))
    api.response.set_text(json.dumps({"booleanJournals": {"succeeded": ["U1"], "failed": []}}))
    api.response.headers["set-cookie"] = "session=secret"
    addon.response(api)

    other = tflow.tflow(resp=True)
    other.request.host = "securetoken.googleapis.com"
    other.request.path = "/v1/token?key=AIzaSECRET"
    other.request.set_text("grant_type=refresh_token&refresh_token=SECRET")
    addon.response(other)
    addon.response(other)

saved = [p for p in out.iterdir() if p.suffix == ".json"]
assert len(saved) == 1, saved
text = saved[0].read_text()
for secret in (JWT, "zzz", "session=secret", "abc"):
    assert secret not in text, f"{secret!r} leaked"
record = json.loads(text)
assert record["request"]["path"] == "/api/journal/v1/user-journal-data/push"
assert record["request"]["headers"]["Authorization"] == "<redacted>"
assert record["request"]["headers"]["bevel-app-version"] == "3.2.7"
assert record["request"]["query"] == {"x": "1", "refresh_token": "<redacted>"}
assert record["request"]["body"]["json"]["booleanJournals"][0]["note"] == "tok <redacted>"
assert record["response"]["body"]["json"]["booleanJournals"]["succeeded"] == ["U1"]
hosts = (out / "hosts.txt").read_text()
assert hosts.count("securetoken.googleapis.com /v1/token") == 1, "each host/path logged once"
assert "SECRET" not in hosts
print("bevel_capture addon: OK")
