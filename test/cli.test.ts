import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { captureToken } from "../src/cli/capture.js";
import { ADDON_PATH, checkBevelToken, runCli, type CliIo } from "../src/cli/index.js";
import { lanAddresses } from "../src/cli/network.js";
import { parseCodeStatus } from "../src/cli/setup.js";
import { stripAnsi } from "../src/cli/ui.js";
import { FileStore, KeychainStore, defaultRunner, type Runner, type TokenStore } from "../src/cli/tokenStore.js";
import { DEFAULT_MACOS_TOKEN_COMMAND, loadConfig } from "../src/config.js";
import { fakeFetch, json, makeJwt } from "./helpers.js";

const now = Math.floor(Date.now() / 1000);
const BEVEL_TOKEN = makeJwt({ userId: "u_1", iat: now, exp: now + 60 * 86400 });
const work = mkdtempSync(join(tmpdir(), "bevel-cli-test-"));
const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Sets environment variables for one test (undefined removes one) and restores them afterwards. */
function withEnv(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}

/** A home folder with the claude CLI, a token file, and optionally a user-scope bevel entry for Claude Code. */
function codeHome(t: TestContext, entry?: (file: string) => unknown) {
  const home = mkdtempSync(join(work, "code-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "claude"), "", { mode: 0o700 });
  const file = join(home, "token");
  writeFileSync(file, BEVEL_TOKEN, { mode: 0o600 });
  if (entry) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { bevel: entry(file) } }));
  withEnv(t, { BEVEL_TOKEN_FILE: file, CLAUDE_CONFIG_DIR: undefined, BEVEL_TIMEZONE: undefined, BEVEL_APP_VERSION: undefined });
  return { home, file };
}

/**
 * A home folder for the other AI apps: the given CLIs in ~/.local/bin, a token file, and a PATH with
 * only Node on it, so a real grok on this machine can't change the result.
 */
function appHome(t: TestContext, clis: string[] = []) {
  const home = mkdtempSync(join(work, "apps-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  for (const cli of clis) writeFileSync(join(home, ".local", "bin", cli), "", { mode: 0o700 });
  const file = join(home, "token");
  writeFileSync(file, BEVEL_TOKEN, { mode: 0o600 });
  withEnv(t, {
    BEVEL_TOKEN_FILE: file, PATH: dirname(process.execPath), CLAUDE_CONFIG_DIR: undefined,
    BEVEL_TIMEZONE: undefined, BEVEL_APP_VERSION: undefined,
  });
  return { home, file };
}

/** Records every command (with its program) and what was sent to the clipboard. */
function recorder() {
  const calls: string[][] = [];
  const clipboard: string[] = [];
  const run: Runner = async (file, args, input) => {
    calls.push([file.split("/").pop()!, ...args]);
    if (file === "/usr/bin/pbcopy" && input !== undefined) clipboard.push(input);
    return { stdout: "" };
  };
  return { calls, clipboard, run };
}

/** An entry as setup writes it, with writes on or off. */
function managedEntry(writes: string | undefined) {
  return (file: string) => ({
    type: "stdio",
    command: process.execPath,
    args: [ENTRY],
    env: { ...(writes === undefined ? {} : { BEVEL_ENABLE_WRITES: writes }), BEVEL_TOKEN_FILE: file },
  });
}

/** A fake `claude` CLI that records its arguments and answers `mcp get` with the given output. */
function claudeCli(status: string | Error) {
  const commands: string[][] = [];
  const run: Runner = async (_file, args) => {
    commands.push(args);
    if (args[1] !== "get") return { stdout: "" };
    if (status instanceof Error) throw status;
    return { stdout: status };
  };
  return { commands, run };
}

/**
 * A stand-in for mitmdump that behaves like the addon: writes {token, distinct} to the
 * bevel_token_out path after a delay ("two" writes an older token, then a newer one), or misbehaves.
 */
function fakeMitmdump(mode: "token" | "two" | "fail" | "hang", token = BEVEL_TOKEN, newer = BEVEL_TOKEN): string {
  const path = join(work, `mitmdump-${mode}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync, renameSync } from "node:fs";
const out = process.argv.find((a) => a.startsWith("bevel_token_out="))?.split("=")[1];
const ready = process.argv.find((a) => a.startsWith("bevel_capture_ready="))?.split("=")[1];
if (${JSON.stringify(mode)} === "fail") { console.error("Error starting proxy server: Address already in use"); process.exit(1); }
writeFileSync(ready, "");
const write = (token, distinct) => { writeFileSync(out + ".tmp", JSON.stringify({ token, distinct }), { mode: 0o600 }); renameSync(out + ".tmp", out); };
if (${JSON.stringify(mode)} === "token") setTimeout(() => write(${JSON.stringify(token)}, 1), 100);
if (${JSON.stringify(mode)} === "two") { setTimeout(() => write(${JSON.stringify(token)}, 1), 100); setTimeout(() => write(${JSON.stringify(newer)}, 2), 200); }
setInterval(() => {}, 1000);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

class MemoryStore implements TokenStore {
  readonly description = "test store";
  saved: string[] = [];
  constructor(private existing?: string) {}
  async save(token: string) {
    this.saved.push(token);
  }
  async load() {
    return this.saved.at(-1) ?? this.existing;
  }
}

function io(overrides: Partial<CliIo> = {}): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { out: (l) => lines.push(l), err: (l) => errors.push(l), lan: () => ["192.168.1.23"], settleMs: 300, captureConfigDir: join(work, "proxy"),
    fetch: fakeFetch(() => json({ moreAvailable: false, offset: 1, customJournalTypes: [] })).fetch,
    lines, errors, ...overrides };
}

after(() => {
  delete process.env.BEVEL_MITMDUMP;
});

describe("token capture", () => {
  it("ships the mitmproxy addon with the package", () => {
    assert.ok(existsSync(ADDON_PATH), ADDON_PATH);
  });

  it("returns the token the addon writes, stops mitmdump and removes the temp dir", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("bevel-token-")));
    const result = await captureToken({ mitmdump: fakeMitmdump("token"), addonPath: ADDON_PATH, port: 8080, timeoutMs: 5000, pollMs: 20, settleMs: 50 });
    assert.deepEqual(result, { token: BEVEL_TOKEN, distinct: 1 });
    const leftover = readdirSync(tmpdir()).filter((d) => d.startsWith("bevel-token-") && !before.has(d));
    assert.deepEqual(leftover, [], "the private temp dir is deleted");
  });

  it("explains a proxy that fails to start, a missing mitmdump, and a timeout", async () => {
    await assert.rejects(
      captureToken({ mitmdump: fakeMitmdump("fail"), addonPath: ADDON_PATH, port: 8080, timeoutMs: 5000, pollMs: 20 }),
      /Address already in use/,
    );
    await assert.rejects(
      captureToken({ mitmdump: join(work, "no-such-mitmdump"), addonPath: ADDON_PATH, port: 8080, timeoutMs: 5000 }),
      /brew install mitmproxy/,
    );
    await assert.rejects(
      captureToken({ mitmdump: fakeMitmdump("hang"), addonPath: ADDON_PATH, port: 8080, timeoutMs: 200, pollMs: 20, settleMs: 50 }),
      /No request from the Bevel app/,
    );
  });

  it("bevel-mcp token capture: shows proxy settings, saves the token, never prints it", async () => {
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token");
    const store = new MemoryStore();
    const cli = io({ store });
    const code = await runCli(["token", "capture", "--port", "8899"], cli);
    assert.equal(code, 0, cli.errors.join("\n"));
    assert.deepEqual(store.saved, [BEVEL_TOKEN]);
    const output = cli.lines.join("\n");
    assert.match(output, /Server\s+192\.168\.1\.23/);
    assert.match(output, /Port\s+8899/);
    assert.match(output, /Expires .* \(in (59|60) days\)/);
    assert.match(output, /turn the proxy off/i);
    assert.ok(!output.includes(BEVEL_TOKEN));
  });

  it("waits after the first token and keeps the one that expires last", async () => {
    const older = makeJwt({ userId: "u_1", iat: now - 20 * 86400, exp: now + 39 * 86400 });
    process.env.BEVEL_MITMDUMP = fakeMitmdump("two", older, BEVEL_TOKEN);
    const store = new MemoryStore();
    const cli = io({ store });
    assert.equal(await runCli(["token", "capture"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(store.saved, [BEVEL_TOKEN]);
    assert.match(cli.lines.join("\n"), /sent 2 tokens\. Using the one that expires last/);
  });

  it("never replaces a saved token with one that expires sooner (unless --force)", async () => {
    const older = makeJwt({ userId: "u_1", iat: now - 20 * 86400, exp: now + 39 * 86400 });
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token", older);
    const store = new MemoryStore(BEVEL_TOKEN);
    const cli = io({ store });
    assert.equal(await runCli(["token", "capture"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(store.saved, [], "the longer-lived saved token is kept");
    assert.match(cli.lines.join("\n"), /Kept your saved token/);

    const forced = io({ store });
    assert.equal(await runCli(["token", "capture", "--force"], forced), 0, forced.errors.join("\n"));
    assert.deepEqual(store.saved, [older]);
  });

  it("refuses a token for a different Bevel account (unless --force)", async () => {
    const otherAccount = makeJwt({ userId: "someone_else", iat: now, exp: now + 60 * 86400 + 100 });
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token", otherAccount);
    const store = new MemoryStore(BEVEL_TOKEN);
    const cli = io({ store });
    assert.equal(await runCli(["token", "capture"], cli), 1);
    assert.match(cli.errors.join("\n"), /different Bevel account/);
    assert.deepEqual(store.saved, []);
  });

  it("replaces an expired saved token, and says when the saved one is already current", async () => {
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token");
    const expiredStore = new MemoryStore(makeJwt({ userId: "u_1", iat: 1, exp: 2 }));
    const cli = io({ store: expiredStore });
    assert.equal(await runCli(["token", "capture"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(expiredStore.saved, [BEVEL_TOKEN]);

    const same = new MemoryStore(BEVEL_TOKEN);
    const again = io({ store: same });
    assert.equal(await runCli(["token", "capture"], again), 0);
    assert.match(again.lines.join("\n"), /already the newest one/);
    assert.deepEqual(same.saved, []);
  });

  it("refuses expired or non-Bevel tokens without saving them", async () => {
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token", makeJwt({ userId: "u", iat: 1, exp: 2 }));
    const store = new MemoryStore();
    const cli = io({ store });
    assert.equal(await runCli(["token", "capture"], cli), 1);
    assert.match(cli.errors.join("\n"), /expired/);
    assert.deepEqual(store.saved, []);
    assert.throws(() => checkBevelToken(makeJwt({ sub: "x", exp: now + 100 })), /userId/);
    assert.throws(() => checkBevelToken("abc.def"), /three dot-separated parts/);
  });
});

describe("token set", () => {
  it("saves a pasted token (Bearer prefix and whitespace tolerated)", async () => {
    const store = new MemoryStore();
    const cli = io({ store, readInput: async () => `  Bearer ${BEVEL_TOKEN}\n` });
    assert.equal(await runCli(["token", "set"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(store.saved, [BEVEL_TOKEN]);
    assert.ok(!cli.lines.join("\n").includes(BEVEL_TOKEN));
  });

  it("rejects a token cut off at 128 characters", async () => {
    const long = makeJwt({ userId: "u".repeat(80), iat: now, exp: now + 1000 });
    const cli = io({ store: new MemoryStore(), readInput: async () => long.slice(0, 128) });
    assert.equal(await runCli(["token", "set"], cli), 1);
    assert.match(cli.errors.join("\n"), /128 characters received/);
  });

  it("--file writes an owner-only file", async () => {
    const file = join(work, "sub", "token");
    const cli = io({ readInput: async () => BEVEL_TOKEN });
    assert.equal(await runCli(["token", "set", "--file", file], cli), 0, cli.errors.join("\n"));
    assert.equal(readFileSync(file, "utf8"), BEVEL_TOKEN);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

describe("token stores", () => {
  it("Keychain store loads the saved item, or nothing when it is missing", async () => {
    const present: Runner = async () => ({ stdout: `${BEVEL_TOKEN}\n` });
    assert.equal(await new KeychainStore(present).load(), BEVEL_TOKEN);
    const missing: Runner = async () => {
      throw new Error("security failed (44): The specified item could not be found in the keychain.");
    };
    assert.equal(await new KeychainStore(missing).load(), undefined);
  });

  it("Keychain store updates the item and verifies it by reading back", async () => {
    const calls: string[][] = [];
    let stored = "";
    const run: Runner = async (_file, args, input) => {
      calls.push(args);
      if (args[0] === "-i") stored = JSON.parse(input!.trim().split(" -w ")[1]!);
      return { stdout: args[0] === "find-generic-password" ? `${stored}\n` : "" };
    };
    await new KeychainStore(run).save(BEVEL_TOKEN);
    assert.deepEqual(calls[0], ["-i"]);
    assert.equal(stored, BEVEL_TOKEN);

    const broken: Runner = async (_f, args) => ({ stdout: args[0] === "find-generic-password" ? "something else" : "" });
    await assert.rejects(new KeychainStore(broken).save(BEVEL_TOKEN), /did not read back/);
  });

  it("command errors never include the arguments (which may hold the token)", async () => {
    await assert.rejects(defaultRunner("/bin/sh", ["-c", "echo nope >&2; exit 3", "sh", BEVEL_TOKEN]), (error: Error) => {
      assert.match(error.message, /nope/);
      assert.ok(!error.message.includes(BEVEL_TOKEN));
      return true;
    });
  });

  it("FileStore creates the folder", async () => {
    const file = join(work, "deep", "er", "token");
    await new FileStore(file).save("x.y.z");
    assert.equal(readFileSync(file, "utf8"), "x.y.z");
  });
});

describe("defaults and helpers", () => {
  it("on macOS the server reads the Keychain item by default", () => {
    assert.deepEqual(loadConfig({}, "darwin").token, { kind: "command", command: DEFAULT_MACOS_TOKEN_COMMAND });
    assert.equal(loadConfig({}, "linux").token, undefined);
    assert.equal(loadConfig({ BEVEL_TOKEN_FILE: "/f" }, "darwin").token?.kind, "file", "explicit settings win");
  });

  it("lists LAN addresses with Wi-Fi first", () => {
    const addresses = lanAddresses({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "", mac: "", cidr: null }],
      bridge0: [{ address: "10.0.0.5", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false, netmask: "", mac: "", cidr: null, scopeid: 0 },
        { address: "192.168.1.23", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null },
      ],
    });
    assert.deepEqual(addresses, ["192.168.1.23", "10.0.0.5"]);
  });

  it("prints help, and rejects unknown commands", async () => {
    const help = io();
    assert.equal(await runCli(["help"], help), 0);
    assert.match(help.lines.join("\n"), /token capture/);
    const bad = io();
    assert.equal(await runCli(["frobnicate"], bad), 2);
  });
});

describe("status", () => {
  it("--check confirms with Bevel, and fails clearly when the token is rejected", async () => {
    const saved = process.env.BEVEL_TOKEN;
    process.env.BEVEL_TOKEN = BEVEL_TOKEN;
    try {
      const ok = fakeFetch(() => json({ moreAvailable: false, offset: 1, customJournalTypes: [] }));
      const good = io({ platform: "linux", fetch: ok.fetch });
      assert.equal(await runCli(["status", "--check"], good), 0, good.errors.join("\n"));
      const out = good.lines.join("\n");
      assert.match(out, /API\s+✓ Bevel accepted the token/);
      assert.match(out, /Account\s+\*\*\*/, "short ids are fully masked");
      assert.ok(!out.includes(BEVEL_TOKEN));

      const rejected = fakeFetch(() => json({ message: "jwt expired" }, 401));
      const bad = io({ platform: "linux", fetch: rejected.fetch });
      assert.equal(await runCli(["status", "--check"], bad), 1);
      assert.match(bad.lines.join("\n"), /API\s+✗ .*token capture/);

      const offline = io({ platform: "linux", fetch: rejected.fetch });
      assert.equal(await runCli(["status"], offline), 0, "without --check no request is made");
      assert.equal(rejected.calls.length, 2, "the 401 path re-read the token once, then stopped");
    } finally {
      if (saved === undefined) delete process.env.BEVEL_TOKEN;
      else process.env.BEVEL_TOKEN = saved;
    }
  });
});

describe("setup and doctor", () => {
  it("preserves Desktop settings, skips a working token, and reuses a matching setup", async (t) => {
    const home = mkdtempSync(join(work, "desktop-"));
    const dir = join(home, "Library", "Application Support", "Claude");
    mkdirSync(dir, { recursive: true });
    const config = join(dir, "claude_desktop_config.json");
    const other = { command: "/path/to/other" };
    writeFileSync(config, JSON.stringify({ theme: "dark", mcpServers: { other } }));
    const file = join(home, "token");
    writeFileSync(file, BEVEL_TOKEN, { mode: 0o600 });
    const before = process.env.BEVEL_TOKEN_FILE;
    process.env.BEVEL_TOKEN_FILE = file;
    t.after(() => { if (before === undefined) delete process.env.BEVEL_TOKEN_FILE; else process.env.BEVEL_TOKEN_FILE = before; });

    let prompts = 0;
    const cli = io({
      homeDir: home,
      platform: "darwin",
      prompt: async () => { prompts++; return "yes"; },
      verifyLaunch: async (launch) => {
        assert.equal(launch.env.BEVEL_TOKEN_FILE, file);
        assert.equal(launch.env.BEVEL_ENABLE_WRITES, "false");
        assert.ok(launch.command.startsWith("/"));
        return "ok";
      },
    });
    assert.equal(await runCli(["setup", "--client", "desktop"], cli), 0, cli.errors.join("\n"));
    assert.equal(await runCli(["setup", "--client", "desktop"], cli), 0, cli.errors.join("\n"));
    assert.equal(prompts, 1);
    const setup = cli.lines.join("\n");
    assert.deepEqual([...setup.matchAll(/^(\d\. .+)$/gm)].slice(0, 4).map((match) => match[1]), [
      "1. Choose where to use Bevel",
      "2. Connect to Bevel",
      "3. Review the settings",
      "4. Verify the connection",
    ]);
    assert.match(setup, /Access +Read-only/);
    assert.match(setup, /saved token\. iPhone setup skipped/);
    assert.equal(await runCli(["doctor", "--client", "desktop"], cli), 0);
    const saved = readFileSync(config, "utf8");
    assert.equal(JSON.parse(saved).theme, "dark");
    assert.deepEqual(JSON.parse(saved).mcpServers.other, other);
    assert.ok(!saved.includes(BEVEL_TOKEN));
    assert.ok(!cli.lines.join("\n").includes(BEVEL_TOKEN));
  });

  it("uses the Claude Code CLI to register and verify the new server", async (t) => {
    const home = mkdtempSync(join(work, "code-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), "", { mode: 0o700 });
    const file = join(home, "token");
    writeFileSync(file, BEVEL_TOKEN, { mode: 0o600 });
    const before = process.env.BEVEL_TOKEN_FILE;
    process.env.BEVEL_TOKEN_FILE = file;
    t.after(() => { if (before === undefined) delete process.env.BEVEL_TOKEN_FILE; else process.env.BEVEL_TOKEN_FILE = before; });
    const commands: string[][] = [];
    const cli = io({
      homeDir: home,
      platform: "darwin",
      prompt: async () => "yes",
      verifyLaunch: async () => "ok",
      run: async (_file, args) => {
        commands.push(args);
        return { stdout: args[1] === "get" ? "  Status: ✓ Connected\n" : "" };
      },
    });
    assert.equal(await runCli(["setup", "--client", "code"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(commands[0]?.slice(0, 3), ["mcp", "add-json", "bevel"]);
    assert.deepEqual(commands[0]?.slice(-2), ["--scope", "user"]);
    const entry = JSON.parse(commands[0]![3]!);
    assert.equal(entry.type, "stdio");
    assert.equal(entry.env.BEVEL_ENABLE_WRITES, "false");
    assert.ok(!JSON.stringify(entry).includes(BEVEL_TOKEN));
    assert.deepEqual(commands[1], ["mcp", "get", "bevel"]);
  });

  it("prepares the active proxy’s iPhone profile before configuring Wi-Fi and preserves the token on failed verification", async () => {
    const home = mkdtempSync(join(work, "capture-setup-"));
    const dir = join(home, "Library", "Application Support", "Claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude_desktop_config.json"), "{}");
    const older = makeJwt({ userId: "u_1", iat: now - 3600, exp: now - 1 });
    process.env.BEVEL_MITMDUMP = fakeMitmdump("token");
    const store = new MemoryStore(older);
    const captureConfigDir = join(home, "proxy");
    mkdirSync(captureConfigDir);
    const ca = readFileSync(new URL("./fixtures/capture-test-ca.pem", import.meta.url));
    writeFileSync(join(captureConfigDir, "mitmproxy-ca-cert.pem"), ca);
    const prompts: string[] = [];
    const commands: string[][] = [];
    const cli = io({
      homeDir: home,
      platform: "darwin",
      captureConfigDir,
      store,
      prompt: async (message) => { prompts.push(message); return ""; },
      run: async (file, args) => {
        commands.push([file, ...args]);
        return { stdout: "" };
      },
      fetch: fakeFetch(() => json({ message: "token rejected" }, 401)).fetch,
    });
    assert.equal(await runCli(["setup", "--client", "desktop"], cli), 1);
    assert.match(cli.errors.join("\n"), /saved credential was preserved/);
    assert.match(cli.lines.join("\n"), /turn the proxy off/i);
    const output = cli.lines.join("\n");
    assert.ok(!output.includes("mitm.it"));
    assert.deepEqual([...output.matchAll(/^   (\d\. .+)$/gm)].map((match) => match[1]), [
      "1. Install the certificate",
      "2. Set the Wi-Fi proxy",
      "3. Open Bevel",
      "4. Turn the proxy off",
    ]);
    assert.deepEqual(prompts.map((prompt) => prompt.trim()), [
      "Continue [Enter/S]",
      "Press Enter when the certificate is trusted.",
      "Tap Save on your iPhone, then press Enter here.",
      "Press Enter when the proxy is off.",
    ]);
    const profile = join(captureConfigDir, "Bevel Capture Certificate.mobileconfig");
    assert.deepEqual(commands, [["/usr/bin/open", "-R", profile]]);
    const xml = readFileSync(profile, "utf8");
    assert.match(xml, /<string>com\.apple\.security\.root<\/string>/);
    const data = [...xml.matchAll(/<data>([A-Za-z0-9+/=]+)<\/data>/g)];
    assert.equal(data.length, 1);
    assert.deepEqual(Buffer.from(data[0]![1]!, "base64"), new X509Certificate(ca).raw);
    assert.deepEqual(store.saved, []);
  });

  it("keeps a Claude Code entry that already allows writes, without asking", async (t) => {
    const { home } = codeHome(t, managedEntry("true"));
    const claude = claudeCli("bevel:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n");
    const prompts: string[] = [];
    const cli = io({
      homeDir: home, platform: "darwin", run: claude.run,
      prompt: async (message) => { prompts.push(message); return "yes"; },
      verifyLaunch: async (launch) => { assert.equal(launch.env.BEVEL_ENABLE_WRITES, "true"); return "ok"; },
    });
    assert.equal(await runCli(["setup", "--client", "code"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(prompts, []);
    assert.deepEqual(claude.commands, [["mcp", "get", "bevel"]], "nothing is added or removed");
    const output = cli.lines.join("\n");
    assert.match(output, /Access +Read and write/);
    assert.match(output, /Using your existing Bevel entry/);
    assert.match(output, /Claude Code is connected/);
    assert.match(output, /npm run setup -- --read-only/);
  });

  it("--writes updates a read-only Claude Code entry after one confirmation; --read-only keeps it", async (t) => {
    const { home } = codeHome(t, managedEntry(undefined));
    const claude = claudeCli("  Status: ✓ Connected\n");
    const prompts: string[] = [];
    const cli = io({
      homeDir: home, platform: "darwin", run: claude.run, verifyLaunch: async () => "ok",
      prompt: async (message) => { prompts.push(message.trim()); return "y"; },
    });
    assert.equal(await runCli(["setup", "--client", "code", "--writes"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(prompts, ["Update your Bevel entry? [y/N]"]);
    assert.deepEqual(claude.commands.map((args) => args.slice(0, 3)), [
      ["mcp", "remove", "bevel"], ["mcp", "add-json", "bevel"], ["mcp", "get", "bevel"],
    ]);
    assert.deepEqual(claude.commands[0], ["mcp", "remove", "bevel", "--scope", "user"]);
    assert.deepEqual(claude.commands[1]?.slice(-2), ["--scope", "user"]);
    assert.equal(JSON.parse(claude.commands[1]![3]!).env.BEVEL_ENABLE_WRITES, "true");
    assert.match(cli.lines.join("\n"), /Access +Read and write \(was Read-only\)/);

    const again = claudeCli("  Status: ✓ Connected\n");
    const readOnly = io({
      homeDir: home, platform: "darwin", run: again.run, verifyLaunch: async () => "ok",
      prompt: async () => assert.fail("an unchanged entry needs no confirmation"),
    });
    assert.equal(await runCli(["setup", "--client", "code", "--read-only"], readOnly), 0, readOnly.errors.join("\n"));
    assert.deepEqual(again.commands, [["mcp", "get", "bevel"]]);
  });

  it("--read-only rewrites a Claude Desktop entry that allows writes and keeps other settings", async (t) => {
    const home = mkdtempSync(join(work, "desktop-writes-"));
    const dir = join(home, "Library", "Application Support", "Claude");
    mkdirSync(dir, { recursive: true });
    const config = join(dir, "claude_desktop_config.json");
    const file = join(home, "token");
    writeFileSync(file, BEVEL_TOKEN, { mode: 0o600 });
    withEnv(t, { BEVEL_TOKEN_FILE: file, BEVEL_TIMEZONE: undefined, BEVEL_APP_VERSION: undefined });
    const other = { command: "/path/to/other" };
    writeFileSync(config, JSON.stringify({ theme: "dark", mcpServers: { other, bevel: managedEntry("true")(file) } }));
    const prompts: string[] = [];
    const cli = io({
      homeDir: home, platform: "darwin", verifyLaunch: async () => "ok",
      prompt: async (message) => { prompts.push(message.trim()); return "yes"; },
    });
    assert.equal(await runCli(["setup", "--client", "desktop", "--read-only"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(prompts, ["Update your Bevel entry? [y/N]"]);
    const saved = JSON.parse(readFileSync(config, "utf8"));
    assert.equal(saved.mcpServers.bevel.env.BEVEL_ENABLE_WRITES, "false");
    assert.deepEqual(saved.mcpServers.other, other);
    assert.equal(saved.theme, "dark");
    assert.match(cli.lines.join("\n"), /Access +Read-only \(was Read and write\)/);
  });

  it("rejects conflicting access flags and a Claude Code entry that setup did not write", async (t) => {
    const both = io({ platform: "darwin", prompt: async () => "" });
    assert.equal(await runCli(["setup", "--writes", "--read-only"], both), 1);
    assert.match(both.errors.join("\n"), /either --writes or --read-only/);
    const elsewhere = io();
    assert.equal(await runCli(["doctor", "--writes"], elsewhere), 1);
    assert.match(elsewhere.errors.join("\n"), /apply only to setup/);

    const { home } = codeHome(t, () => ({ command: "/usr/bin/python3", args: ["other_server.py"] }));
    const claude = claudeCli("  Status: ✓ Connected\n");
    const foreign = io({ homeDir: home, platform: "darwin", run: claude.run, prompt: async () => "yes", verifyLaunch: async () => "ok" });
    assert.equal(await runCli(["setup", "--client", "code", "--writes"], foreign), 1);
    assert.match(foreign.errors.join("\n"), /different user-scope bevel entry/);
    assert.deepEqual(claude.commands, []);
  });

  it("reads Claude Code's status line, treating unrecognised output as unknown rather than failed", () => {
    assert.equal(parseCodeStatus("bevel:\n  Scope: User config\n  Status: ✓ Connected\n"), "connected");
    assert.equal(parseCodeStatus("\u001b[32m  Status: ✔ connected\u001b[39m"), "connected");
    assert.equal(parseCodeStatus("  Status: ✗ Failed to connect"), "failed");
    assert.equal(parseCodeStatus("  Status: Not connected"), "failed");
    assert.equal(parseCodeStatus("  Scope: Local config (private to you in this project)\n  Status: ✓ Connected"), "failed");
    assert.equal(parseCodeStatus("  Status: starting"), "unknown");
    assert.equal(parseCodeStatus("bevel: healthy"), "unknown");
    assert.equal(parseCodeStatus(""), "unknown");
  });

  it("setup and doctor warn, but succeed, when Claude Code's status can't be read", async (t) => {
    const { home } = codeHome(t, managedEntry("false"));
    for (const status of ["bevel: everything is fine\n", new Error("claude failed (1): unexpected output")]) {
      const claude = claudeCli(status);
      const cli = io({ homeDir: home, platform: "darwin", run: claude.run, prompt: async () => "yes", verifyLaunch: async () => "ok" });
      assert.equal(await runCli(["setup", "--client", "code"], cli), 0, cli.errors.join("\n"));
      assert.match(cli.lines.join("\n"), /! Claude Code’s status could not be read\. The server itself was verified/);

      const doctor = io({ homeDir: home, run: claude.run, verifyLaunch: async () => "ok" });
      assert.equal(await runCli(["doctor", "--client", "code"], doctor), 0, doctor.lines.join("\n"));
      assert.match(doctor.lines.join("\n"), /! Claude Code’s status could not be read/);
      assert.match(doctor.lines.join("\n"), /No problems found\. See the note above\./);
    }
  });

  it("setup and doctor fail when Claude Code reports a failure or a missing entry", async (t) => {
    const { home } = codeHome(t, managedEntry("false"));
    const failed = claudeCli("  Status: ✗ Failed to connect\n");
    const cli = io({ homeDir: home, platform: "darwin", run: failed.run, prompt: async () => "yes", verifyLaunch: async () => "ok" });
    assert.equal(await runCli(["setup", "--client", "code"], cli), 1);
    assert.match(cli.errors.join("\n"), /Claude Code did not report Connected/);

    const missing = claudeCli(new Error("claude failed (1): No MCP server found with name: bevel"));
    const doctor = io({ homeDir: home, run: missing.run, verifyLaunch: async () => "ok" });
    assert.equal(await runCli(["doctor", "--client", "code"], doctor), 1);
    assert.match(doctor.lines.join("\n"), /✗ Claude Code did not report Connected/);
    assert.match(doctor.lines.join("\n"), /Some checks failed/);
  });

  it("styles output for a colour terminal without changing the words", async (t) => {
    const { home } = codeHome(t, managedEntry("false"));
    const claude = claudeCli("  Status: ✓ Connected\n");
    const cli = io({ homeDir: home, platform: "darwin", run: claude.run, prompt: async () => "yes", verifyLaunch: async () => "ok", color: true, columns: 100 });
    assert.equal(await runCli(["setup", "--client", "code"], cli), 0, cli.errors.join("\n"));
    const raw = cli.lines.join("\n");
    assert.ok(raw.includes("\u001b["), "colour codes are present");
    const text = stripAnsi(raw);
    assert.ok(text.includes("██████╗"), "the logo is shown");
    assert.deepEqual([...text.matchAll(/^(\d\. .+)$/gm)].map((match) => match[1]), [
      "1. Choose where to use Bevel",
      "2. Connect to Bevel",
      "3. Review the settings",
      "4. Verify the connection",
    ]);
    assert.match(text, /╭─ Setup complete ─+╮/);

    const help = io({ color: true, columns: 100 });
    assert.equal(await runCli(["--help"], help), 0);
    assert.match(stripAnsi(help.lines.join("\n")), /--writes +Setup or serve: let your AI change your Bevel data/);
    const plainHelp = io();
    assert.equal(await runCli(["--help"], plainHelp), 0);
    assert.ok(!plainHelp.lines.join("\n").includes("\u001b"), "no colour codes without a terminal");
  });

  it("gives Grok Build's add command, a JSON config for any MCP client, and a prompt for any AI", async (t) => {
    const { home, file } = appHome(t);
    const grok = recorder();
    const grokCli = io({ homeDir: home, platform: "darwin", run: grok.run, verifyLaunch: async () => "ok", prompt: async () => "" });
    assert.equal(await runCli(["setup", "--client", "grok"], grokCli), 0, grokCli.errors.join("\n"));
    assert.match(grok.clipboard[0]!, /^grok mcp add bevel -- \S+ \S+index\.js serve --file \S+$/);
    assert.match(grokCli.lines.join("\n"), /The Grok app and Grok Bot can’t reach a server on your Mac/);

    const other = recorder();
    const otherCli = io({ homeDir: home, platform: "darwin", run: other.run, verifyLaunch: async () => "ok", prompt: async () => "" });
    assert.equal(await runCli(["setup", "--client", "other", "--writes"], otherCli), 0, otherCli.errors.join("\n"));
    const config = JSON.parse(other.clipboard[0]!);
    assert.deepEqual(config.mcpServers.bevel.args, [ENTRY, "serve", "--writes", "--file", file]);
    assert.ok(config.mcpServers.bevel.command.startsWith("/"), "an absolute Node path works without a PATH");
    assert.match(otherCli.lines.join("\n"), /npx @modelcontextprotocol\/inspector /);

    const prompt = recorder();
    const promptCli = io({ homeDir: home, platform: "darwin", run: prompt.run, verifyLaunch: async () => "ok", prompt: async () => "" });
    assert.equal(await runCli(["setup", "--client", "prompt"], promptCli), 0, promptCli.errors.join("\n"));
    const text = prompt.clipboard[0]!;
    assert.match(text, /under\nthe name "bevel"/);
    assert.ok(text.includes(JSON.stringify([ENTRY, "serve", "--file", file])));
    assert.match(text, /call bevel_auth_status with\n {2}checkApi set to true/);
    assert.match(text, /from the token file named in its arguments/);
    assert.ok(text.split("\n").every((line) => line.length <= 80 || line.includes(ENTRY)), "short lines, apart from paths");
    assert.match(text, /Access is read-only/);
    assert.ok(!text.includes(BEVEL_TOKEN) && !promptCli.lines.join("\n").includes(BEVEL_TOKEN));
  });

  it("offers every option in a menu when no client is given", async (t) => {
    const { home } = appHome(t, ["claude"]);
    const record = recorder();
    const prompts: string[] = [];
    const cli = io({
      homeDir: home, platform: "darwin", run: record.run, verifyLaunch: async () => "ok",
      prompt: async (message) => { prompts.push(message.trim()); return "5"; },
    });
    assert.equal(await runCli(["setup"], cli), 0, cli.errors.join("\n"));
    assert.deepEqual(prompts, ["Choose [1]"], "Claude Code was found, so it is the default");
    const output = cli.lines.join("\n");
    for (const option of ["1. Claude Code", "2. Claude Desktop", "3. Grok Build", "4. Another MCP client", "5. A prompt for any AI"]) {
      assert.ok(output.includes(option), option);
    }
    assert.match(output, /1\. Claude Code +found/);
    assert.match(output, /3\. Grok Build +not found/);
    assert.ok(!/ChatGPT|Codex/.test(output));
    assert.match(record.clipboard[0]!, /Please connect the Bevel Health MCP server/);

    const wrong = io({ homeDir: home, platform: "darwin", prompt: async () => "9" });
    assert.equal(await runCli(["setup"], wrong), 1);
    assert.match(wrong.errors.join("\n"), /Choose a number from 1 to 5/);
    const unknown = io({ platform: "darwin", prompt: async () => "" });
    assert.equal(await runCli(["setup", "--client", "codex"], unknown), 1);
    assert.match(unknown.errors.join("\n"), /--client must be code, desktop, grok, other or prompt/);
    const doctor = io();
    assert.equal(await runCli(["doctor", "--client", "grok"], doctor), 1);
    assert.match(doctor.errors.join("\n"), /status --check/);
  });
});
