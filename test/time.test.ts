import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayToIdentifyingDate, parseDay, todayInTimeZone, zonedTimeToUtcMs } from "../src/time.js";

describe("dayToIdentifyingDate", () => {
  it("matches the captured identifyingDate for 2026-11-10 in US Eastern (local noon)", () => {
    assert.equal(dayToIdentifyingDate("2026-11-10", "America/New_York"), 1794330000000);
  });

  it("uses local noon on both sides of a DST change", () => {
    // US DST ends 2026-11-01: EDT (UTC-4) before, EST (UTC-5) after.
    assert.equal(new Date(dayToIdentifyingDate("2026-10-31", "America/New_York")).toISOString(), "2026-10-31T16:00:00.000Z");
    assert.equal(new Date(dayToIdentifyingDate("2026-11-01", "America/New_York")).toISOString(), "2026-11-01T17:00:00.000Z");
    // DST starts 2026-03-08.
    assert.equal(new Date(dayToIdentifyingDate("2026-03-08", "America/New_York")).toISOString(), "2026-03-08T16:00:00.000Z");
  });

  it("works for other zones", () => {
    assert.equal(new Date(dayToIdentifyingDate("2026-11-10", "Europe/London")).toISOString(), "2026-11-10T12:00:00.000Z");
    assert.equal(new Date(dayToIdentifyingDate("2026-11-10", "Asia/Tokyo")).toISOString(), "2026-11-10T03:00:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    assert.throws(() => parseDay("2026-2-1"), RangeError);
    assert.throws(() => parseDay("2026-02-30"), RangeError);
    assert.throws(() => dayToIdentifyingDate("yesterday", "America/New_York"), RangeError);
  });
});

describe("todayInTimeZone", () => {
  it("reports the local calendar day, not the UTC day", () => {
    const lateEveningEastern = Date.parse("2026-11-11T03:30:00Z"); // 22:30 EST on Nov 10
    assert.equal(todayInTimeZone("America/New_York", lateEveningEastern), "2026-11-10");
    assert.equal(todayInTimeZone("UTC", lateEveningEastern), "2026-11-11");
  });
});

describe("zonedTimeToUtcMs", () => {
  it("round-trips a wall-clock time", () => {
    const ms = zonedTimeToUtcMs({ year: 2026, month: 7, day: 4 }, 9, 30, "America/Los_Angeles");
    assert.equal(new Date(ms).toISOString(), "2026-07-04T16:30:00.000Z");
  });
});
