import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CommandTokenProvider, FileTokenProvider, createTokenProvider, normalizeToken } from "../src/auth/tokenProvider.js";
import { loadConfig, systemTimeZone } from "../src/config.js";
import { BevelAuthError, BevelConfigError } from "../src/http/errors.js";

describe("loadConfig", () => {
  it("applies defaults with writes disabled", () => {
    const c = loadConfig({}, "linux");
    assert.equal(c.baseUrl, "https://api.supersethealth.com");
    assert.equal(c.appVersion, "3.2.7");
    assert.equal(c.timeZone, systemTimeZone(), "defaults to this machine's time zone");
    assert.equal(loadConfig({}, "linux", "Europe/Paris").timeZone, "Europe/Paris");
    assert.equal(loadConfig({ BEVEL_TIMEZONE: "Asia/Tokyo" }, "linux", "Europe/Paris").timeZone, "Asia/Tokyo");
    assert.equal(c.cacheSeconds, 60);
    assert.equal(loadConfig({ BEVEL_CACHE_SECONDS: "0" }).cacheSeconds, 0);
    assert.throws(() => loadConfig({ BEVEL_CACHE_SECONDS: "soon" }), BevelConfigError);
    assert.equal(c.enableWrites, false);
    assert.equal(c.token, undefined);
  });

  it("picks token sources in priority order", () => {
    assert.equal(loadConfig({ BEVEL_TOKEN: "a", BEVEL_TOKEN_FILE: "/f" }).token?.kind, "env");
    assert.equal(loadConfig({ BEVEL_TOKEN: " ", BEVEL_TOKEN_FILE: "/f", BEVEL_TOKEN_COMMAND: "c" }).token?.kind, "file");
    assert.equal(loadConfig({ BEVEL_TOKEN_COMMAND: "c" }).token?.kind, "command");
  });

  it("parses the writes flag strictly", () => {
    assert.equal(loadConfig({ BEVEL_ENABLE_WRITES: "true" }).enableWrites, true);
    assert.equal(loadConfig({ BEVEL_ENABLE_WRITES: "1" }).enableWrites, true);
    assert.equal(loadConfig({ BEVEL_ENABLE_WRITES: "false" }).enableWrites, false);
    assert.throws(() => loadConfig({ BEVEL_ENABLE_WRITES: "sure" }), BevelConfigError);
  });

  it("refuses plain-http base URLs except localhost", () => {
    assert.throws(() => loadConfig({ BEVEL_BASE_URL: "http://api.supersethealth.com" }), BevelConfigError);
    assert.equal(loadConfig({ BEVEL_BASE_URL: "http://127.0.0.1:8080/" }).baseUrl, "http://127.0.0.1:8080");
  });

  it("rejects unknown time zones", () => {
    assert.throws(() => loadConfig({ BEVEL_TIMEZONE: "Mars/Olympus" }), BevelConfigError);
  });
});

describe("token providers", () => {
  it("normalizes pasted tokens", () => {
    assert.equal(normalizeToken("  Bearer eyJabc.eyJdef.sig\n"), "eyJabc.eyJdef.sig");
    assert.equal(normalizeToken('"eyJabc.eyJdef.sig"'), "eyJabc.eyJdef.sig");
    assert.throws(() => normalizeToken("   "), BevelAuthError);
    assert.throws(() => normalizeToken("two words"), BevelAuthError);
  });

  it("reads from a file and re-reads after invalidate()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bevel-mcp-"));
    const path = join(dir, "token");
    writeFileSync(path, "first\n");
    const provider = new FileTokenProvider(path);
    assert.equal(await provider.getToken(), "first");
    writeFileSync(path, "second\n");
    assert.equal(await provider.getToken(), "first", "cached until invalidated");
    provider.invalidate();
    assert.equal(await provider.getToken(), "second");
  });

  it("reports a missing file without leaking contents", async () => {
    await assert.rejects(new FileTokenProvider("/nonexistent/bevel-token").getToken(), /ENOENT/);
  });

  it("runs a command and uses its stdout", async () => {
    assert.equal(await new CommandTokenProvider("printf 'Bearer from-command\\n'").getToken(), "from-command");
  });

  it("surfaces command failures via stderr only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bevel-mcp-"));
    const script = join(dir, "fail.sh");
    writeFileSync(script, "#!/bin/sh\necho secret-on-stdout\necho 'item not found' >&2\nexit 44\n");
    chmodSync(script, 0o755);
    await assert.rejects(
      new CommandTokenProvider(script).getToken(),
      (err: unknown) => err instanceof BevelAuthError && /item not found/.test(err.message) && !err.message.includes("secret-on-stdout"),
    );
  });

  it("labels the default macOS Keychain source and says how to fill it", async () => {
    const provider = createTokenProvider({ kind: "command", command: "/usr/bin/security find-generic-password -s bevel-mcp -a token -w" })!;
    assert.equal(provider.source, "macOS Keychain item bevel-mcp/token");
    const missing = createTokenProvider({ kind: "command", command: "echo 'item could not be found' >&2; exit 44" })!;
    await assert.rejects(missing.getToken(), /BEVEL_TOKEN_COMMAND failed/);
    const keychainLike = new CommandTokenProvider("echo 'item could not be found' >&2; exit 44", 15_000, "macOS Keychain item bevel-mcp/token", ". Run `bevel-mcp token capture`.");
    await assert.rejects(keychainLike.getToken(), /macOS Keychain item bevel-mcp\/token failed \(44\): item could not be found\. Run `bevel-mcp token capture`/);
  });

  it("builds the provider for each config kind", () => {
    assert.equal(createTokenProvider(undefined), undefined);
    assert.match(createTokenProvider({ kind: "env", variable: "BEVEL_TOKEN", value: "x" })!.source, /BEVEL_TOKEN/);
    assert.match(createTokenProvider({ kind: "file", path: "/p" })!.source, /BEVEL_TOKEN_FILE/);
    assert.match(createTokenProvider({ kind: "command", command: "c" })!.source, /BEVEL_TOKEN_COMMAND/);
  });
});
