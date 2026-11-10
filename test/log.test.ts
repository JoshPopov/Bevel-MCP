import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Logger, REDACTED, redact, redactString } from "../src/log.js";
import { TEST_TOKEN } from "./helpers.js";

describe("redaction", () => {
  it("masks bearer headers and bare JWTs inside strings", () => {
    assert.equal(redactString(`Authorization: Bearer ${TEST_TOKEN}`), `Authorization: Bearer ${REDACTED}`);
    assert.equal(redactString(`token was ${TEST_TOKEN}.`), `token was ${REDACTED}.`);
  });

  it("masks sensitive keys at any depth and leaves other data alone", () => {
    const out = redact({
      headers: { Authorization: "Bearer abc", accept: "*/*" },
      nested: [{ refreshToken: "r", idToken: "i", value: 3 }],
      presetFactorKey: "addedSugar",
    });
    assert.deepEqual(out, {
      headers: { Authorization: REDACTED, accept: "*/*" },
      nested: [{ refreshToken: REDACTED, idToken: REDACTED, value: 3 }],
      presetFactorKey: "addedSugar",
    });
  });

  it("never writes a token through the logger and respects levels", () => {
    const lines: string[] = [];
    const logger = new Logger("info", (line) => lines.push(line));
    logger.info(`using ${TEST_TOKEN}`, { auth: `Bearer ${TEST_TOKEN}`, token: TEST_TOKEN });
    logger.debug("hidden");
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes(TEST_TOKEN));
  });
});
