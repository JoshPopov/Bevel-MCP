import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StaticTokenProvider, type TokenProvider } from "../src/auth/tokenProvider.js";
import { BevelHttpClient } from "../src/http/client.js";
import { BevelAuthError, BevelHttpError, BevelNetworkError } from "../src/http/errors.js";
import { silentLogger } from "../src/log.js";
import { TEST_TOKEN, fakeFetch, json, type Responder } from "./helpers.js";

function client(
  responder: Responder,
  tokenProvider: TokenProvider | null = new StaticTokenProvider(TEST_TOKEN),
  extra: { cacheTtlMs?: number; clock?: () => number } = {},
) {
  const { fetch, calls } = fakeFetch(responder);
  const sleeps: number[] = [];
  const http = new BevelHttpClient({
    baseUrl: "https://api.supersethealth.com",
    appVersion: "3.2.7",
    userAgent: "bevel-mcp/test",
    tokenProvider: tokenProvider ?? undefined,
    logger: silentLogger,
    fetch,
    retryBaseDelayMs: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { http, calls, sleeps };
}

class RotatingProvider implements TokenProvider {
  readonly source = "test rotating provider";
  reads = 0;
  invalidations = 0;
  constructor(private readonly tokens: string[]) {}
  async getToken() {
    return this.tokens[Math.min(this.reads++, this.tokens.length - 1)]!;
  }
  invalidate() {
    this.invalidations++;
  }
}

describe("BevelHttpClient", () => {
  it("sends the observed headers and query string", async () => {
    const { http, calls } = client(() => json({ ok: true }));
    const result = await http.request("GET", "/api/journal/v1/user-journal-data/pull", {
      query: { offset: 0, limit: 50, lastSyncDate: undefined },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[0]!.url, "https://api.supersethealth.com/api/journal/v1/user-journal-data/pull?offset=0&limit=50");
    assert.equal(calls[0]!.headers.Authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(calls[0]!.headers["bevel-app-version"], "3.2.7");
    assert.equal(calls[0]!.headers.Accept, "application/json");
    assert.match(calls[0]!.headers["request-id"]!, /^[0-9A-F-]{36}$/);
    assert.equal(calls[0]!.headers["Content-Type"], undefined, "GET has no body, so no content type");
  });

  it("serializes POST bodies as JSON, preserving fractional milliseconds", async () => {
    const { http, calls } = client(() => json({}));
    await http.request("POST", "/x", { body: { createdAt: 1794334952292.411 } });
    assert.equal(calls[0]!.headers["Content-Type"], "application/json");
    assert.equal(calls[0]!.headers.Accept, "*/*");
    assert.equal(calls[0]!.body, '{"createdAt":1794334952292.411}');
  });

  it("fails clearly when no token is configured", async () => {
    const { http, calls } = client(() => json({}), null);
    await assert.rejects(http.request("GET", "/x"), BevelAuthError);
    assert.equal(calls.length, 0);
  });

  it("re-reads the token once after a 401, then succeeds", async () => {
    const provider = new RotatingProvider(["old", "new"]);
    const { http, calls } = client((call) => (call.headers.Authorization === "Bearer new" ? json({ ok: 1 }) : json({}, 401)), provider);
    assert.deepEqual(await http.request("POST", "/push", { body: {} }), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(provider.invalidations, 1);
  });

  it("raises BevelAuthError after a second 401", async () => {
    const provider = new RotatingProvider(["old", "still-old"]);
    const { http, calls } = client(() => json({ error: "jwt expired" }, 401), provider);
    await assert.rejects(http.request("GET", "/x"), (err: unknown) => err instanceof BevelAuthError && err.status === 401);
    assert.equal(calls.length, 2);
  });

  it("retries GET on 503 and 429", async () => {
    const statuses = [503, 429, 200];
    const { http, calls } = client((_, i) => json({ i }, statuses[i]));
    assert.deepEqual(await http.request("GET", "/x"), { i: 2 });
    assert.equal(calls.length, 3);
  });

  it("gives up on GET after maxGetRetries", async () => {
    const { http, calls } = client(() => json({}, 500));
    await assert.rejects(http.request("GET", "/x"), (err: unknown) => err instanceof BevelHttpError && err.status === 500);
    assert.equal(calls.length, 4);
  });

  it("never retries a POST on 5xx", async () => {
    const { http, calls } = client(() => json({}, 503));
    await assert.rejects(http.request("POST", "/push", { body: {} }), BevelHttpError);
    assert.equal(calls.length, 1);
  });

  it("never retries a POST on network failure and reports the outcome as unknown", async () => {
    const { http, calls } = client(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      http.request("POST", "/push", { body: {} }),
      (err: unknown) => err instanceof BevelNetworkError && err.outcomeUnknown,
    );
    assert.equal(calls.length, 1);
  });

  it("retries GET on network failure", async () => {
    const { http, calls } = client((_, i) => {
      if (i === 0) throw new TypeError("fetch failed");
      return json({ ok: true });
    });
    assert.deepEqual(await http.request("GET", "/x"), { ok: true });
    assert.equal(calls.length, 2);
  });

  it("redacts tokens echoed in error bodies", async () => {
    const { http } = client(() => new Response(`bad request for Bearer ${TEST_TOKEN}`, { status: 400 }));
    await assert.rejects(http.request("GET", "/x"), (err: unknown) => err instanceof BevelHttpError && !err.message.includes(TEST_TOKEN));
  });

  it("rejects non-JSON success bodies", async () => {
    const { http } = client(() => new Response("<html>", { status: 200 }));
    await assert.rejects(http.request("GET", "/x"), /Expected JSON/);
  });
});

describe("read cache", () => {
  let t = 0;
  const clock = () => t;
  const make = (ttl = 1000) => {
    t = 0;
    let n = 0;
    return client(() => json({ n: ++n }), new StaticTokenProvider(TEST_TOKEN), { cacheTtlMs: ttl, clock });
  };

  it("reuses a GET within the TTL and refetches after it", async () => {
    const { http, calls } = make();
    assert.deepEqual(await http.request("GET", "/pull", { query: { limit: 1 } }), { n: 1 });
    t = 999;
    assert.deepEqual(await http.request("GET", "/pull", { query: { limit: 1 } }), { n: 1 });
    assert.equal(calls.length, 1);
    t = 1000;
    assert.deepEqual(await http.request("GET", "/pull", { query: { limit: 1 } }), { n: 2 });
    assert.equal(calls.length, 2);
  });

  it("keys on the full URL, and fresh: true bypasses it", async () => {
    const { http, calls } = make();
    await http.request("GET", "/pull", { query: { limit: 1 } });
    await http.request("GET", "/pull", { query: { limit: 2 } });
    await http.request("GET", "/pull", { query: { limit: 1 }, fresh: true });
    assert.equal(calls.length, 3);
  });

  it("any /push clears it; a search POST does not", async () => {
    const { http, calls } = make();
    await http.request("GET", "/pull");
    await http.request("POST", "/api/nutrition/v2/search/query", { body: {} });
    await http.request("GET", "/pull");
    assert.equal(calls.length, 2, "search left the cache alone");
    await http.request("POST", "/api/x/push", { body: {} });
    await http.request("GET", "/pull");
    assert.equal(calls.length, 4, "push cleared it");
  });

  it("does not cache reads that overlap an in-flight push", async () => {
    let releaseRead!: () => void;
    const delayedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    let beginRead!: () => void;
    const reading = new Promise<void>((resolve) => { beginRead = resolve; });
    let releasePush!: () => void;
    const delayedPush = new Promise<void>((resolve) => { releasePush = resolve; });
    let beginPush!: () => void;
    const writing = new Promise<void>((resolve) => { beginPush = resolve; });
    let reads = 0;
    let value = "before";
    const { http } = client(async (call) => {
      if (call.method === "POST") {
        beginPush();
        await delayedPush;
        value = "after";
        return json({});
      }
      const response = json({ value });
      if (++reads === 1) {
        beginRead();
        await delayedRead;
      }
      return response;
    }, new StaticTokenProvider(TEST_TOKEN), { cacheTtlMs: 1000 });

    const oldRead = http.request("GET", "/pull");
    await reading;
    const push = http.request("POST", "/x/push");
    await writing;
    assert.deepEqual(await http.request("GET", "/pull"), { value: "before" });
    releasePush();
    await push;
    releaseRead();
    assert.deepEqual(await oldRead, { value: "before" });
    assert.deepEqual(await http.request("GET", "/pull"), { value: "after" });
    assert.deepEqual(await http.request("GET", "/pull"), { value: "after" });
    assert.equal(reads, 3);
  });

  it("hands out copies, and is off when the TTL is 0", async () => {
    const { http } = make();
    const first = await http.request<{ n: number }>("GET", "/pull");
    first.n = 99;
    assert.deepEqual(await http.request("GET", "/pull"), { n: 1 });
    const off = make(0);
    await off.http.request("GET", "/pull");
    await off.http.request("GET", "/pull");
    assert.equal(off.calls.length, 2);
  });
});

describe("app version rejection hints", () => {
  it("recognises version wording or HTTP 426, not ordinary errors", async () => {
    const { appVersionHint } = await import("../src/http/errors.js");
    assert.match(appVersionHint(426, "", "3.2.7"), /BEVEL_APP_VERSION/);
    assert.match(appVersionHint(400, "Please update the app to continue", "3.2.7"), /newer app version than 3\.2\.7/);
    assert.match(appVersionHint(403, '{"error":"client version unsupported"}', "3.2.7"), /BEVEL_APP_VERSION/);
    assert.equal(appVersionHint(401, '{"message":"jwt expired"}', "3.2.7"), "");
    assert.equal(appVersionHint(500, "Internal Server Error", "3.2.7"), "");
  });

  it("says 'update the app version' instead of 'token expired' when Bevel asks for a newer app", async () => {
    const { http } = client(() => json({ error: "Please update the app" }, 403));
    await assert.rejects(http.request("GET", "/x"), (err: unknown) => {
      assert.ok(err instanceof BevelAuthError);
      assert.match(err.message, /BEVEL_APP_VERSION/);
      assert.doesNotMatch(err.message, /expired/);
      return true;
    });
    const expired = client(() => json({ message: "jwt expired" }, 401));
    await assert.rejects(expired.http.request("GET", "/x"), /bevel-mcp token capture/);
    const upgrade = client(() => json({}, 426));
    await assert.rejects(upgrade.http.request("GET", "/x"), /BEVEL_APP_VERSION/);
  });
});
