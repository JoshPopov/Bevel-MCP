import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { itemId, verifyPush } from "../src/api/push.js";
import { BevelPushError } from "../src/http/errors.js";

describe("verifyPush (shared by Journal, Nutrition, Fitness)", () => {
  const collections = ["foodLogs", "recipes"] as const;
  const bucket = (succeeded: string[] = [], failed: unknown[] = []) => ({ succeeded, failed });

  it("identifies items by uuid or id", () => {
    assert.equal(itemId({ uuid: "U" }), "U");
    assert.equal(itemId({ id: "I" }), "I");
    assert.equal(itemId({ other: 1 }), undefined);
  });

  it("accepts a response that lists every submitted id, allowing extra buckets", () => {
    const response = verifyPush(collections, { foodLogs: [{ id: "A" }], recipes: [] }, {
      foodLogs: bucket(["a"]),
      recipes: bucket(),
      exerciseNotes: bucket(),
    });
    assert.deepEqual(response.foodLogs?.succeeded, ["a"]);
  });

  it("reports failed and missing ids", () => {
    assert.throws(
      () =>
        verifyPush(collections, { foodLogs: [{ id: "A" }, { id: "B" }] }, { foodLogs: bucket([], [{ id: "A", error: "x" }]) }),
      (err: unknown) =>
        err instanceof BevelPushError &&
        err.failures.map((f) => `${f.id}:${f.reason}`).join(",") === "A:failed,B:missing",
    );
  });

  it("rejects malformed responses", () => {
    assert.throws(() => verifyPush(collections, { foodLogs: [{ id: "A" }] }, { foodLogs: "ok" }), BevelPushError);
  });
});
