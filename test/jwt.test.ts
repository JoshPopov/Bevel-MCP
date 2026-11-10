import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeJwt, formatDuration, guessProvider, maskIdentifier, summarizeJwt } from "../src/auth/jwt.js";
import { TEST_TOKEN, makeJwt } from "./helpers.js";

describe("summarizeJwt", () => {
  it("extracts non-secret claims and masks the subject", () => {
    const s = summarizeJwt(TEST_TOKEN, 1794331800_000);
    assert.equal(s.issuer, "https://securetoken.google.com/test-project");
    assert.equal(s.providerHint, "Firebase Authentication");
    assert.equal(s.signInProvider, "apple.com");
    assert.equal(s.lifetimeSeconds, 3600);
    assert.equal(s.secondsUntilExpiry, 1800);
    assert.equal(s.expired, false);
    assert.equal(s.issuedAt, "2026-11-10T17:00:00.000Z");
    assert.ok(s.subject && !s.subject.includes("abcdef-1234"));
    assert.deepEqual(s.claimNames, ["aud", "exp", "firebase", "iat", "iss", "sub"]);
  });

  it("flags expired tokens", () => {
    assert.equal(summarizeJwt(makeJwt({ exp: 100 }), 200_000).expired, true);
  });

  it("rejects non-JWT strings", () => {
    assert.throws(() => decodeJwt("not-a-jwt"), /not a JWT/);
    assert.throws(() => decodeJwt("a.b.c"), /not a JWT/);
  });
});

describe("helpers", () => {
  it("guesses common providers", () => {
    assert.equal(guessProvider("https://cognito-idp.us-east-1.amazonaws.com/pool"), "AWS Cognito");
    assert.equal(guessProvider("https://bevel.us.auth0.com/"), "Auth0");
    assert.equal(guessProvider("https://unknown.example"), undefined);
  });
  it("masks identifiers and formats durations", () => {
    assert.equal(maskIdentifier("abc"), "***");
    assert.equal(maskIdentifier("abcdefghij"), "abcd…ij (10 chars)");
    assert.equal(formatDuration(3600), "1h");
    assert.equal(formatDuration(90061), "1d 1h 1m 1s");
    assert.equal(formatDuration(-30), "-30s");
    assert.equal(formatDuration(0), "0s");
  });
});
