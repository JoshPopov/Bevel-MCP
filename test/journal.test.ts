import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildBooleanJournalEntry,
  buildBooleanJournalUpdate,
  buildJournalPushRequest,
  findBooleanEntries,
  parseBooleanEntries,
  verifyPushResponse,
} from "../src/api/journal.js";
import { pullAllPages } from "../src/api/pull.js";
import { CustomJournalTypesPullPageSchema, JournalPullPageSchema } from "../src/api/types.js";
import { BevelPushError, BevelSchemaError } from "../src/http/errors.js";
import { pulledEntry, pushResponse } from "./helpers.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("Boolean Journal push payload", () => {
  it("matches the captured request structure exactly", () => {
    const captured = fixture("journal-push-boolean.request.json");
    const entry = buildBooleanJournalEntry({
      uuid: captured.booleanJournals[0].uuid,
      factorKey: "addedSugar",
      value: true,
      identifyingDate: 1794330000000,
      now: 1794334952292.573,
    });
    const built = buildJournalPushRequest({ booleanJournals: [entry] });

    assert.deepEqual(Object.keys(built), Object.keys(captured));
    assert.deepEqual(Object.keys(built.booleanJournals[0]!), Object.keys(captured.booleanJournals[0]));
    assert.equal(built.booleanJournals[0]!.startTime, captured.booleanJournals[0].startTime);
    assert.equal(built.booleanJournals[0]!.endTime, captured.booleanJournals[0].endTime);
    assert.equal(built.booleanJournals[0]!.identifyingDate, captured.booleanJournals[0].identifyingDate);
    assert.equal(built.booleanJournals[0]!.isNotSet, false);
  });
});

describe("verifyPushResponse", () => {
  const request = buildJournalPushRequest({
    booleanJournals: [
      buildBooleanJournalEntry({ uuid: "AAAA-1", factorKey: "addedSugar", value: true, identifyingDate: 1, now: 2 }),
    ],
  });

  it("accepts the captured success response", () => {
    const captured = fixture("journal-push-boolean.response.json");
    const req = buildJournalPushRequest({
      booleanJournals: [
        buildBooleanJournalEntry({ uuid: captured.booleanJournals.succeeded[0], factorKey: "addedSugar", value: true, identifyingDate: 1, now: 2 }),
      ],
    });
    assert.deepEqual(verifyPushResponse(req, captured).booleanJournals?.succeeded, captured.booleanJournals.succeeded);
  });

  it("matches UUIDs case-insensitively", () => {
    assert.doesNotThrow(() => verifyPushResponse(request, pushResponse(["aaaa-1"])));
  });

  it("throws when the UUID is in failed", () => {
    assert.throws(
      () => verifyPushResponse(request, pushResponse([], [{ uuid: "AAAA-1", error: "invalid" }])),
      (err: unknown) =>
        err instanceof BevelPushError && err.failures[0]?.reason === "failed" && err.failures[0]?.id === "AAAA-1",
    );
  });

  it("throws when the UUID is missing from both arrays (HTTP 200 is not success)", () => {
    assert.throws(
      () => verifyPushResponse(request, pushResponse([])),
      (err: unknown) => err instanceof BevelPushError && err.failures[0]?.reason === "missing",
    );
  });

  it("throws on an unexpected response shape", () => {
    assert.throws(() => verifyPushResponse(request, { ok: true, booleanJournals: "yes" }), BevelPushError);
    assert.throws(() => verifyPushResponse(request, undefined), BevelPushError);
  });

  it("treats a response without the booleanJournals bucket as missing", () => {
    assert.throws(
      () => verifyPushResponse(request, {}),
      (err: unknown) => err instanceof BevelPushError && err.failures[0]?.reason === "missing",
    );
  });
});

describe("Boolean Journal update (same uuid + createdAt, new value + updatedAt)", () => {
  it("matches the captured edit structure", () => {
    const created = fixture("journal-push-boolean.request.json").booleanJournals[0];
    const captured = fixture("journal-push-boolean-update.request.json");
    const update = buildBooleanJournalUpdate(created, false, 1794336600000.25);
    const built = buildJournalPushRequest({ booleanJournals: [update] });
    assert.deepEqual(built, captured, "deepEqual ignores key order, which the app does not keep stable");
    assert.equal(update.uuid, created.uuid);
    assert.equal(update.createdAt, created.createdAt);
  });
});

describe("pull parsing", () => {
  it("accepts the captured empty Journal pull envelope", () => {
    const page = JournalPullPageSchema.parse(fixture("journal-pull-empty.response.json"));
    assert.equal(page.moreAvailable, false);
    assert.equal(page.offset, 100);
    assert.deepEqual(page.journalData.booleanJournals, []);
  });

  it("splits Boolean entries into recognised and unrecognised", () => {
    const { entries, unparsed } = parseBooleanEntries([pulledEntry(), { uuid: "x", identifyingDate: "2026-11-10" }]);
    assert.equal(entries.length, 1);
    assert.equal(unparsed.length, 1);
  });

  it("finds entries by factor and local day, newest first", () => {
    const { entries } = parseBooleanEntries([
      pulledEntry({ uuid: "OLD", updatedAt: 1 }),
      pulledEntry({ uuid: "NEW", updatedAt: 2 }),
      pulledEntry({ uuid: "OTHER-FACTOR", presetFactorKey: "deviceInBed" }),
      pulledEntry({ uuid: "OTHER-DAY", identifyingDate: 1794330000000 - 86_400_000 }),
      // Logged while travelling: noon in Los Angeles is still Nov 10 in New York.
      pulledEntry({ uuid: "TRAVEL", identifyingDate: Date.parse("2026-11-10T20:00:00Z"), updatedAt: 0 }),
    ]);
    const found = findBooleanEntries(entries, "addedSugar", "2026-11-10", "America/New_York").map((e) => e.uuid);
    assert.deepEqual(found, ["NEW", "OLD", "TRAVEL"]);
  });
});

describe("pullAllPages", () => {
  const page = (moreAvailable: boolean, offset: number) => ({ moreAvailable, offset, customJournalTypes: [offset] });

  it("follows moreAvailable using the returned offset", async () => {
    const seen: number[] = [];
    const result = await pullAllPages(
      "/p",
      async (q) => {
        seen.push(q.offset);
        return q.offset === 0 ? page(true, 100) : page(false, 200);
      },
      CustomJournalTypesPullPageSchema,
      { lastSyncDate: 0, limit: 100, maxPages: 10 },
    );
    assert.deepEqual(seen, [0, 100]);
    assert.equal(result.pages.length, 2);
    assert.equal(result.truncated, false);
  });

  it("stops at maxPages and reports truncation", async () => {
    const result = await pullAllPages("/p", async (q) => page(true, q.offset + 100), CustomJournalTypesPullPageSchema, {
      lastSyncDate: 0,
      limit: 100,
      maxPages: 3,
    });
    assert.equal(result.pages.length, 3);
    assert.equal(result.truncated, true);
  });

  it("advances even if the server repeats the offset", async () => {
    const seen: number[] = [];
    await pullAllPages(
      "/p",
      async (q) => {
        seen.push(q.offset);
        return page(seen.length < 3, 0);
      },
      CustomJournalTypesPullPageSchema,
      { lastSyncDate: 0, limit: 50, maxPages: 10 },
    );
    assert.deepEqual(seen, [0, 50, 100]);
  });

  it("throws BevelSchemaError on an unexpected shape", async () => {
    await assert.rejects(
      pullAllPages("/p", async () => ({ items: [] }), CustomJournalTypesPullPageSchema, { lastSyncDate: 0, limit: 1, maxPages: 1 }),
      BevelSchemaError,
    );
  });
});

describe("pulled entries in the live server shape", () => {
  const live = fixture("journal-pull-live-shape.response.json");

  it("parses ISO updatedAt and cleared entries without boolValue", () => {
    const page = JournalPullPageSchema.parse(live);
    const { entries, unparsed } = parseBooleanEntries(page.journalData.booleanJournals);
    assert.equal(unparsed.length, 0);
    const [cleared, set] = entries;
    assert.equal(cleared!.isNotSet, true);
    assert.equal(cleared!.boolValue, undefined);
    assert.equal(cleared!.updatedAt, Date.parse("2026-11-10T19:01:20.180Z"));
    assert.equal(cleared!.createdAt, 1794334952292.411, "createdAt keeps the client's fractional ms");
    assert.equal(set!.boolValue, true);
  });

  it("re-setting a cleared entry reuses it and sends numbers, not the server's ISO string", () => {
    const { entries } = parseBooleanEntries(live.journalData.booleanJournals);
    const update = buildBooleanJournalUpdate(entries[0]!, true, 1794340000000.5);
    assert.deepEqual(update, {
      identifyingDate: 1794330000000,
      uuid: "11111111-2222-4333-8444-555555555555",
      presetFactorKey: "addedSugar",
      boolValue: true,
      startTime: 1794330000000,
      updatedAt: 1794340000000.5,
      isNotSet: false,
      createdAt: 1794334952292.411,
      endTime: 1794330000000,
    });
  });

  it("still rejects an entry that is neither set nor cleared", () => {
    const { unparsed } = parseBooleanEntries([pulledEntry({ boolValue: undefined, isNotSet: false })]);
    assert.equal(unparsed.length, 1);
  });

  it("rejects an unparseable updatedAt string", () => {
    const { unparsed } = parseBooleanEntries([pulledEntry({ updatedAt: "yesterday" })]);
    assert.equal(unparsed.length, 1);
  });
});
