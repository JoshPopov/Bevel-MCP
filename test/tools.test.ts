import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EXPECTED_TOOLS, TEST_TOKEN, fakeApi, harness, journalPage, json, makeJwt, pulledEntry, pushResponse } from "./helpers.js";

const PULL = "https://api.supersethealth.com/api/journal/v1/user-journal-data/pull";
const PUSH = "https://api.supersethealth.com/api/journal/v1/user-journal-data/push";
const NOV_10_NOON_ET = 1794330000000;
const DAY = 86_400_000;

describe("tools/list", () => {
  it("registers exactly the expected tools", async () => {
    const h = await harness();
    const tools = (await h.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [...EXPECTED_TOOLS].sort());
    await h.close();
  });
});

describe("bevel_auth_status", () => {
  it("decodes claims and never includes the token", async () => {
    const h = await harness();
    const result = await h.call("bevel_auth_status");
    assert.ok(!result.isError);
    assert.ok(!result.text.includes(TEST_TOKEN));
    const status = JSON.parse(result.text);
    assert.equal(status.configured, true);
    assert.equal(status.sourceReadable, true);
    assert.equal(status.claims.providerHint, "Firebase Authentication");
    assert.equal(status.claims.lifetime, "1h");
    assert.equal(h.calls.length, 0, "auth status makes no network request");
    await h.close();
  });

  it("recognises the Bevel-issued token shape (userId/iat/exp, 60-day lifetime)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bevelToken = makeJwt({ userId: "u_123456789", iat: now, exp: now + 5_184_000 });
    const h = await harness({ env: { BEVEL_TOKEN: bevelToken } });
    const status = JSON.parse((await h.call("bevel_auth_status")).text);
    assert.equal(status.claims.providerHint, "Bevel's own auth service (userId claim, no issuer)");
    assert.equal(status.claims.lifetime, "60d");
    assert.deepEqual(status.notes, []);
    await h.close();
  });

  it("warns when the token expires within a week", async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = await harness({ env: { BEVEL_TOKEN: makeJwt({ userId: "u", iat: now - 100, exp: now + 3600 }) } });
    const status = JSON.parse((await h.call("bevel_auth_status")).text);
    assert.match(status.notes.join(" "), /within 7 days/);
    await h.close();
  });

  it("explains when no token is configured", async () => {
    const h = await harness({ noToken: true });
    const status = JSON.parse((await h.call("bevel_auth_status")).text);
    assert.equal(status.configured, false);
    assert.match(status.notes[0], /BEVEL_TOKEN_COMMAND/);
    await h.close();
  });
});

describe("bevel_get_journal", () => {
  it("pulls full history by default and lists entries by local day", async () => {
    const h = await harness({
      responder: fakeApi({
        booleanJournals: [
          pulledEntry(),
          pulledEntry({ uuid: "B", presetFactorKey: "deviceInBed", boolValue: false, identifyingDate: NOV_10_NOON_ET - DAY }),
        ],
      }),
    });
    const result = await h.call("bevel_get_journal");
    assert.ok(!result.isError, result.text);
    assert.equal(h.calls[0]!.url, `${PULL}?offset=0&limit=100&lastSyncDate=0`);
    const out = JSON.parse(result.text);
    assert.equal(out.pagesFetched, 1);
    assert.deepEqual(out.counts, { booleanJournals: 2, booleanJournalDefaults: 0, categoricalJournalDefaults: 0, numericJournalDefaults: 0 });
    assert.deepEqual(
      out.booleanJournals.map((e: any) => [e.day, e.factorKey, e.value]),
      [
        ["2026-11-10", "addedSugar", true],
        ["2026-11-09", "deviceInBed", false],
      ],
    );
    assert.equal(out.booleanJournals[0].factorLabel, "Added Sugar");
    await h.close();
  });

  it("follows pagination and applies date and factor filters", async () => {
    const h = await harness({
      responder: (call) => {
        const offset = Number(new URL(call.url).searchParams.get("offset"));
        return offset === 0
          ? json(journalPage([pulledEntry({ uuid: "P1" })], { moreAvailable: true, offset: 100 }))
          : json(journalPage([pulledEntry({ uuid: "P2", presetFactorKey: "deviceInBed" })], { offset: 200 }));
      },
    });
    const out = JSON.parse((await h.call("bevel_get_journal", { date: "2026-11-10", factorKey: "deviceInBed" })).text);
    assert.equal(h.calls.length, 2);
    assert.equal(out.pagesFetched, 2);
    assert.deepEqual(out.booleanJournals.map((e: any) => e.uuid), ["P2"]);
    await h.close();
  });

  it("passes lastSyncDate through as Unix ms for incremental pulls", async () => {
    const h = await harness({ responder: fakeApi() });
    await h.call("bevel_get_journal", { lastSyncDate: 1794336406840, limit: 50 });
    assert.equal(h.calls[0]!.url, `${PULL}?offset=0&limit=50&lastSyncDate=1794336406840`);
    await h.close();
  });

  it("surfaces entries it cannot parse instead of hiding them", async () => {
    const h = await harness({ responder: fakeApi({ booleanJournals: [{ uuid: "weird", identifyingDate: "2026-11-10" }] }) });
    const out = JSON.parse((await h.call("bevel_get_journal")).text);
    assert.equal(out.unparsedCount, 1);
    await h.close();
  });

  it("reports a changed response shape as an error with a redacted sample", async () => {
    const h = await harness({ responder: () => json({ entries: [], token: "should-not-appear" }) });
    const result = await h.call("bevel_get_journal");
    assert.equal(result.isError, true);
    assert.match(result.text, /does not match the captured shape/);
    assert.ok(!result.text.includes("should-not-appear"));
    await h.close();
  });

  it("returns an MCP error result (not a crash) when the token is rejected", async () => {
    const h = await harness({ responder: () => json({ message: "jwt expired" }, 401) });
    const result = await h.call("bevel_get_journal");
    assert.equal(result.isError, true);
    assert.match(result.text, /rejected the token/);
    await h.close();
  });
});

describe("bevel_get_custom_journal_types", () => {
  it("calls the custom types pull endpoint and unwraps the envelope", async () => {
    const h = await harness({ responder: () => json({ moreAvailable: false, offset: 100, customJournalTypes: [] }) });
    const result = await h.call("bevel_get_custom_journal_types");
    assert.ok(!result.isError, result.text);
    assert.equal(
      h.calls[0]!.url,
      "https://api.supersethealth.com/api/journal/v1/custom-journal-types/pull?offset=0&limit=100&lastSyncDate=0",
    );
    assert.deepEqual(JSON.parse(result.text), { customJournalTypes: [], pagesFetched: 1, truncated: false });
    await h.close();
  });
});

describe("bevel_set_journal_boolean", () => {
  const writes = { BEVEL_ENABLE_WRITES: "true" };

  it("refuses before any network call when BEVEL_ENABLE_WRITES is not set", async () => {
    const h = await harness({ responder: fakeApi() });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /BEVEL_ENABLE_WRITES=true/);
    assert.equal(h.calls.length, 0);
    await h.close();
  });

  it("looks up only recent changes for the day (day − 30 days)", async () => {
    const h = await harness({ env: writes, responder: fakeApi() });
    await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.equal(h.calls[0]!.url, `${PULL}?offset=0&limit=100&lastSyncDate=${NOV_10_NOON_ET - 30 * DAY}`);
    await h.close();
  });

  it("creates a new entry with the captured shape when none exists", async () => {
    const h = await harness({ env: writes, responder: fakeApi() });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.ok(!result.isError, result.text);
    const push = h.calls.find((c) => c.method === "POST")!;
    assert.equal(push.url, PUSH);
    assert.deepEqual(JSON.parse(push.body!), {
      booleanJournalDefaults: [],
      customJournalTypes: [],
      booleanJournals: [
        {
          identifyingDate: NOV_10_NOON_ET,
          uuid: "00000000-0000-4000-8000-000000000001",
          presetFactorKey: "addedSugar",
          boolValue: true,
          startTime: NOV_10_NOON_ET,
          updatedAt: 1794334952292.573,
          isNotSet: false,
          createdAt: 1794334952292.573,
          endTime: NOV_10_NOON_ET,
        },
      ],
      numericJournalDefaults: [],
      categoricalJournalDefaults: [],
    });
    const out = JSON.parse(result.text);
    assert.equal(out.written, true);
    assert.equal(out.action, "created");
    await h.close();
  });

  it("updates the existing entry in place, keeping uuid and createdAt (as the app does)", async () => {
    const existing = pulledEntry({ uuid: "EXISTING-UUID", boolValue: true, createdAt: 1794334952292.411 });
    const h = await harness({ env: writes, responder: fakeApi({ booleanJournals: [existing] }) });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: false, date: "2026-11-10" });
    assert.ok(!result.isError, result.text);
    const sent = JSON.parse(h.calls.find((c) => c.method === "POST")!.body!).booleanJournals[0];
    assert.equal(sent.uuid, "EXISTING-UUID");
    assert.equal(sent.createdAt, 1794334952292.411);
    assert.equal(sent.updatedAt, 1794334952292.573);
    assert.equal(sent.boolValue, false);
    const out = JSON.parse(result.text);
    assert.equal(out.action, "updated");
    assert.equal(out.existing.value, true);
    await h.close();
  });

  it("does nothing when the day already has that value", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ booleanJournals: [pulledEntry({ boolValue: true })] }) });
    const out = JSON.parse((await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" })).text);
    assert.equal(out.action, "unchanged");
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
    await h.close();
  });

  it("dryRun performs the lookup but never pushes, even with writes disabled", async () => {
    const h = await harness({ responder: fakeApi({ booleanJournals: [pulledEntry({ uuid: "E1", boolValue: true })] }) });
    const result = await h.call("bevel_set_journal_boolean", {
      factorKey: "addedSugar",
      value: false,
      date: "2026-11-10",
      dryRun: true,
    });
    assert.ok(!result.isError, result.text);
    assert.deepEqual(h.calls.map((c) => c.method), ["GET"]);
    const out = JSON.parse(result.text);
    assert.equal(out.dryRun, true);
    assert.equal(out.action, "updated");
    assert.equal(out.request.body.booleanJournals[0].uuid, "E1");
    await h.close();
  });

  it("refuses to write when pulled entries have an unknown shape (cannot rule out a duplicate)", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ booleanJournals: [{ id: 1, day: "2026-11-10" }] }) });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.equal(result.isError, true);
    assert.match(result.text, /does not recognise/);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
    await h.close();
  });

  it("reports failure (with the uuid) when the server does not list it as succeeded", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ push: () => json(pushResponse([])) }) });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.equal(result.isError, true);
    assert.match(result.text, /did not confirm/);
    assert.match(result.text, /00000000-0000-4000-8000-000000000001/);
    await h.close();
  });

  it("does not retry a write whose response was lost, and explains that re-running is safe", async () => {
    const h = await harness({
      env: writes,
      responder: fakeApi({
        push: () => {
          throw new TypeError("socket hang up");
        },
      }),
    });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.equal(result.isError, true);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
    assert.match(result.text, /Re-running this tool is safe/);
    await h.close();
  });

  it("requires an explicit opt-in for unverified factor keys", async () => {
    const h = await harness({ responder: fakeApi() });
    const refused = await h.call("bevel_set_journal_boolean", { factorKey: "caffeine", value: true, dryRun: true });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not a known factor key/);
    const allowed = await h.call("bevel_set_journal_boolean", {
      factorKey: "caffeine",
      value: true,
      dryRun: true,
      allowUnverifiedFactorKey: true,
    });
    assert.ok(!allowed.isError, allowed.text);
    assert.match(allowed.text, /unverifiedKey/);
    await h.close();
  });

  it("rejects malformed input", async () => {
    const h = await harness({ responder: fakeApi() });
    const bad = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "11/10/2026", dryRun: true });
    assert.equal(bad.isError, true);
    const impossible = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-02-30", dryRun: true });
    assert.equal(impossible.isError, true);
    assert.match(impossible.text, /Not a real calendar date/);
    assert.equal(h.calls.length, 0);
    await h.close();
  });
});

describe("bevel_auth_status truncation diagnosis", () => {
  it("spots a JWT cut off by the 128-character macOS prompt and explains the fix", async () => {
    // Header + payload alone exceed 128 characters, so the cut lands inside the payload (as with real tokens).
    const full = makeJwt({ userId: "cm".padEnd(64, "x"), iat: 1794336406, exp: 1799520406 });
    const truncated = full.slice(0, 128);
    const h = await harness({ env: { BEVEL_TOKEN: truncated } });
    const result = await h.call("bevel_auth_status");
    assert.ok(!result.text.includes(truncated), "never echoes the token");
    const status = JSON.parse(result.text);
    assert.deepEqual(status.credentialShape, { length: 128, segments: 2 });
    assert.match(status.notes[0], /looks truncated/);
    assert.match(status.notes[0], /bevel-mcp token set/);
    await h.close();
  });
});

describe("live server shape", () => {
  const live = JSON.parse(readFileSync(new URL("./fixtures/journal-pull-live-shape.response.json", import.meta.url), "utf8"));
  const liveApi = () => fakeApi({ booleanJournals: live.journalData.booleanJournals });

  it("bevel_get_journal shows a cleared factor as value null", async () => {
    const h = await harness({ responder: liveApi() });
    const out = JSON.parse((await h.call("bevel_get_journal", { date: "2026-11-10" })).text);
    assert.equal(out.unparsedCount, undefined);
    assert.deepEqual(out.booleanJournals.map((e: any) => [e.factorKey, e.value, e.cleared]), [["addedSugar", null, true]]);
    assert.equal(out.booleanJournals[0].updatedAt, "2026-11-10T19:01:20.180Z");
    await h.close();
  });

  it("setting a value on a cleared day updates that entry instead of creating another", async () => {
    const h = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: liveApi() });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.ok(!result.isError, result.text);
    const out = JSON.parse(result.text);
    assert.equal(out.action, "updated");
    assert.equal(out.existing.cleared, true);
    const sent = JSON.parse(h.calls.find((c) => c.method === "POST")!.body!).booleanJournals[0];
    assert.equal(sent.uuid, "11111111-2222-4333-8444-555555555555");
    assert.equal(sent.isNotSet, false);
    assert.equal(sent.boolValue, true);
    assert.equal(typeof sent.updatedAt, "number");
    assert.equal(sent.createdAt, 1794334952292.411);
    await h.close();
  });

  it("lateMeal (seen in live data) is accepted without the unverified-key flag", async () => {
    const h = await harness({ responder: liveApi() });
    const result = await h.call("bevel_set_journal_boolean", { factorKey: "lateMeal", value: true, date: "2026-11-10", dryRun: true });
    assert.ok(!result.isError, result.text);
    assert.equal(JSON.parse(result.text).action, "created");
    await h.close();
  });
});

describe("discovering new Journal entry types", () => {
  it("surfaces collections the client has never seen instead of dropping them", async () => {
    const h = await harness({
      responder: () => {
        const page: any = journalPage([]);
        page.journalData.numericJournals = [{ presetFactorKey: "someFactor", numericValue: 1 }];
        page.journalData.booleanJournalDefaults = [{ presetFactorKey: "someDefault" }];
        return json(page);
      },
    });
    const out = JSON.parse((await h.call("bevel_get_journal")).text);
    assert.deepEqual(out.unknownCollections, { numericJournals: [{ presetFactorKey: "someFactor", numericValue: 1 }] });
    assert.deepEqual(out.otherCollections, { booleanJournalDefaults: [{ presetFactorKey: "someDefault" }] });
    await h.close();
  });
});

describe("bevel_clear_journal_boolean", () => {
  const writes = { BEVEL_ENABLE_WRITES: "true" };

  it("clears the day's entry exactly like the app: same uuid/createdAt, isNotSet true, no boolValue key", async () => {
    const existing = pulledEntry({ uuid: "SET-UUID", boolValue: true, createdAt: 1794334952292.411 });
    const h = await harness({ env: writes, responder: fakeApi({ booleanJournals: [existing] }) });
    const result = await h.call("bevel_clear_journal_boolean", { factorKey: "addedSugar", date: "2026-11-10" });
    assert.ok(!result.isError, result.text);
    const body = JSON.parse(h.calls.find((c) => c.method === "POST")!.body!);
    const sent = body.booleanJournals[0];
    assert.deepEqual(Object.keys(sent).sort(), [
      "createdAt",
      "endTime",
      "identifyingDate",
      "isNotSet",
      "presetFactorKey",
      "startTime",
      "updatedAt",
      "uuid",
    ]);
    assert.equal(sent.uuid, "SET-UUID");
    assert.equal(sent.isNotSet, true);
    assert.equal(sent.createdAt, 1794334952292.411);
    assert.equal(JSON.parse(result.text).action, "cleared");
    await h.close();
  });

  it("does nothing when there is no entry, or it is already cleared", async () => {
    const none = await harness({ env: writes, responder: fakeApi() });
    assert.equal(JSON.parse((await none.call("bevel_clear_journal_boolean", { factorKey: "addedSugar", date: "2026-11-10" })).text).action, "nothing_to_clear");
    assert.equal(none.calls.filter((c) => c.method === "POST").length, 0);
    await none.close();

    const cleared = await harness({ env: writes, responder: fakeApi({ booleanJournals: [pulledEntry({ isNotSet: true, boolValue: undefined })] }) });
    assert.equal(JSON.parse((await cleared.call("bevel_clear_journal_boolean", { factorKey: "addedSugar", date: "2026-11-10" })).text).action, "unchanged");
    assert.equal(cleared.calls.filter((c) => c.method === "POST").length, 0);
    await cleared.close();
  });

  it("is refused without BEVEL_ENABLE_WRITES and supports dryRun", async () => {
    const h = await harness({ responder: fakeApi({ booleanJournals: [pulledEntry()] }) });
    const refused = await h.call("bevel_clear_journal_boolean", { factorKey: "addedSugar", date: "2026-11-10" });
    assert.equal(refused.isError, true);
    assert.equal(h.calls.length, 0);
    const dry = JSON.parse((await h.call("bevel_clear_journal_boolean", { factorKey: "addedSugar", date: "2026-11-10", dryRun: true })).text);
    assert.equal(dry.action, "cleared");
    assert.equal("boolValue" in dry.request.body.booleanJournals[0], false);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
    await h.close();
  });
});

describe("read cache and writes", () => {
  it("lookups before a write ignore the cache, and a write clears it for later reads", async () => {
    const h = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: fakeApi() });
    const pulls = () => h.calls.filter((c) => c.method === "GET").length;
    await h.call("bevel_get_journal", { date: "2026-11-10" });
    await h.call("bevel_get_journal", { date: "2026-11-10" });
    assert.equal(pulls(), 1, "second read served from the cache");
    await h.call("bevel_set_journal_boolean", { factorKey: "addedSugar", value: true, date: "2026-11-10" });
    assert.equal(pulls(), 2, "the write's lookup went to Bevel");
    await h.call("bevel_get_journal", { date: "2026-11-10" });
    assert.equal(pulls(), 3, "the push cleared the cache");
    await h.close();
  });
});

it("serializes concurrent writes to the same Journal factor and day", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let firstPull!: () => void;
  const started = new Promise<void>((resolve) => { firstPull = resolve; });
  let entry: unknown;
  let reads = 0;
  const h = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: async (call) => {
    if (call.method === "POST") {
      const next = JSON.parse(call.body!).booleanJournals[0];
      entry = next;
      return json(pushResponse([next.uuid]));
    }
    const page = journalPage(entry ? [entry] : []);
    if (++reads === 1) {
      firstPull();
      await blocked;
    }
    return json(page);
  } });
  try {
    const args = { factorKey: "addedSugar", date: "2026-11-10", value: true };
    const first = h.call("bevel_set_journal_boolean", args);
    await started;
    const second = h.call("bevel_set_journal_boolean", args);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((result) => JSON.parse(result.text).action), ["created", "unchanged"]);
    assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    release();
    await h.close();
  }
});

describe("bevel_auth_status checkApi", () => {
  const env = { BEVEL_TOKEN: makeJwt({ userId: "test", exp: Math.floor(Date.now() / 1000) + 3600 }) };

  it("confirms with one tiny request that Bevel accepts the token", async () => {
    const h = await harness({ env, responder: () => json({ moreAvailable: false, offset: 1, customJournalTypes: [] }) });
    const out = JSON.parse((await h.call("bevel_auth_status", { checkApi: true })).text);
    assert.deepEqual(out.api, { ok: true, message: "Bevel accepted the token." });
    const url = new URL(h.calls[0]!.url);
    assert.equal(url.pathname, "/api/journal/v1/custom-journal-types/pull");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.ok(Number(url.searchParams.get("lastSyncDate")) > Date.now() - 60_000, "asks only for changes since now");
    await h.close();
  });

  it("reports a rejected token", async () => {
    const h = await harness({ env, responder: () => json({ message: "jwt expired" }, 401) });
    const out = JSON.parse((await h.call("bevel_auth_status", { checkApi: true })).text);
    assert.equal(out.api.ok, false);
    assert.match(out.api.message, /rejected the token/);
    await h.close();
  });
});
