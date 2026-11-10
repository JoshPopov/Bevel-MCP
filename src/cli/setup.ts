import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decodeJwt } from "../auth/jwt.js";
import { StaticTokenProvider } from "../auth/tokenProvider.js";
import { DEFAULT_BASE_URL, DEFAULT_MACOS_TOKEN_COMMAND, loadConfig, type BevelConfig } from "../config.js";
import { silentLogger } from "../log.js";
import { buildDeps } from "../server.js";
import { serveArgs } from "../serve.js";
import { checkApi } from "../tools/auth.js";
import { SERVER_VERSION } from "../version.js";
import type { CliIo } from "./index.js";
import { defaultRunner, KeychainStore } from "./tokenStore.js";
import { createUi, startSpinner, stripAnsi, type Ui } from "./ui.js";

export type Prompt = (message: string, signal?: AbortSignal) => Promise<string>;
type ClaudeKind = "code" | "desktop";
type ClientKind = ClaudeKind | "grok" | "other" | "prompt";
type JsonObject = Record<string, unknown>;
export interface Launch { command: string; args: string[]; env: Record<string, string> }
export type LaunchCheck = "ok" | "launch" | "credential" | "network" | "api";

const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const CLIENT_NAME: Record<ClientKind, string> = {
  code: "Claude Code",
  desktop: "Claude Desktop",
  grok: "Grok Build",
  other: "Another MCP client",
  prompt: "A prompt for any AI",
};
/** The setup menu, in order. */
const MENU: ClientKind[] = ["code", "desktop", "grok", "other", "prompt"];
/** Who gets access, for "<agent> can change your Bevel data". */
const AGENT: Record<ClientKind, string> = {
  code: "Claude",
  desktop: "Claude",
  grok: "Grok",
  other: "Your AI app",
  prompt: "Your AI app",
};

function isClaude(kind: ClientKind): kind is ClaudeKind {
  return kind === "code" || kind === "desktop";
}

function selectedClient(value: string | undefined): ClientKind | undefined {
  if (value === undefined) return undefined;
  if (Object.hasOwn(CLIENT_NAME, value)) return value as ClientKind;
  throw new Error("--client must be code, desktop, grok, other or prompt.");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readClient(path: string) {
  const text = await optionalText(path);
  const data: unknown = text === undefined ? {} : JSON.parse(text);
  if (!isObject(data)) throw new Error("Invalid Claude configuration.");
  const servers = data.mcpServers ?? {};
  if (!isObject(servers)) throw new Error("Invalid Claude MCP configuration.");
  return { text, data, servers };
}

async function writeDesktop(path: string, snapshot: Awaited<ReturnType<typeof readClient>>, launch: Launch) {
  const target = snapshot.text === undefined ? path : await realpath(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(target), ".bevel-"));
  try {
    const next = join(temporary, "config.json");
    const data = { ...snapshot.data, mcpServers: { ...snapshot.servers, bevel: launch } };
    await writeFile(next, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    if (await optionalText(path) !== snapshot.text) throw new Error("Claude Desktop configuration changed. Rerun setup.");
    await rename(next, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function executable(name: string, home: string): Promise<string | undefined> {
  const candidates = name.includes("/") ? [resolve(name)] : [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => resolve(dir, name)),
    join(home, ".local", "bin", name),
    join("/opt/homebrew/bin", name),
    join("/usr/local/bin", name),
  ];
  for (const path of new Set(candidates)) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
}

async function discoverClients(home: string) {
  const claude = await executable("claude", home);
  const code = join(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json");
  const desktop = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const desktopInstalled = (await Promise.all([
    "/Applications/Claude.app", join(home, "Applications", "Claude.app"), desktop,
  ].map((path) => access(path).then(() => true, () => false)))).some(Boolean);
  const grokCli = await executable("grok", home);
  return { claude, code, desktop, desktopInstalled, grokCli };
}

function keychain(io: CliIo) {
  return io.store ?? new KeychainStore(io.run ?? defaultRunner);
}

function authDeps(io: CliIo, config: BevelConfig, token?: string) {
  const store = keychain(io);
  const provider = token !== undefined
    ? new StaticTokenProvider(token)
    : config.token?.kind === "command" && config.token.command === DEFAULT_MACOS_TOKEN_COMMAND
      ? {
          source: "macOS Keychain",
          async getToken() {
            const saved = await store.load?.();
            if (!saved) throw new Error("Keychain token is unavailable.");
            return saved;
          },
          invalidate() {},
        }
      : undefined;
  return buildDeps(config, { fetch: io.fetch, logger: silentLogger, tokenProvider: provider });
}

async function probe(io: CliIo, config: BevelConfig): Promise<LaunchCheck> {
  if (config.baseUrl !== DEFAULT_BASE_URL) return "api";
  const deps = authDeps(io, config);
  try {
    const token = await deps.tokenProvider?.getToken();
    if (!token) return "credential";
    const exp = decodeJwt(token).payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return "credential";
    const api = await checkApi(deps);
    return api.ok ? "ok" : api.reason;
  } catch {
    return "credential";
  }
}

async function verifyLaunch(launch: Launch): Promise<LaunchCheck> {
  const client = new Client({ name: "bevel-doctor", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ ...launch, stderr: "ignore" }), { timeout: 10_000 });
    const tools = await client.listTools({}, { timeout: 10_000 });
    if (!tools.tools.some((tool) => tool.name === "bevel_auth_status")) return "launch";
    const result = await client.callTool({ name: "bevel_auth_status", arguments: { checkApi: true } }, undefined, { timeout: 35_000 });
    const part = Array.isArray(result.content) ? result.content.find((entry) => entry.type === "text") : undefined;
    if (result.isError || !part || typeof part.text !== "string") return "api";
    const status = JSON.parse(part.text);
    if (!status.sourceReadable || status.claims?.expired || status.claimsError) return "credential";
    if (status.api?.ok === true) return "ok";
    return status.api?.reason === "credential" || status.api?.reason === "network" ? status.api.reason : "api";
  } catch {
    return "launch";
  } finally {
    await client.close();
  }
}

function explain(check: LaunchCheck): string {
  switch (check) {
    case "ok": return "Bevel accepted a read-only API request.";
    case "launch": return "The MCP launch or handshake failed. Run npm ci in the Bevel-MCP folder, then rerun setup.";
    case "credential": return "The token is missing, unreadable, expired or rejected. Run bevel-mcp token capture, or rerun setup.";
    case "network": return "Bevel could not be reached. Check your internet connection and retry.";
    case "api": return "The API check failed. Check Bevel’s availability and BEVEL_APP_VERSION, then run status --check for local details.";
  }
}

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["", "0", "false", "no", "off"];

/** BEVEL_ENABLE_WRITES as the server reads it, or undefined for a value the server would reject. */
function writesFlag(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return TRUE_VALUES.includes(normalized) ? true : FALSE_VALUES.includes(normalized) ? false : undefined;
}

function accessLabel(writes: boolean): string {
  return writes ? "Read and write" : "Read-only";
}

async function compatibleEntry(entry: unknown, launch: Launch, legacyNode?: string): Promise<boolean> {
  if (!isObject(entry) || (entry.type !== undefined && entry.type !== "stdio") ||
      !Array.isArray(entry.args) || entry.args.length !== 1 || entry.args[0] !== launch.args[0] ||
      typeof entry.command !== "string") return false;
  const command = isAbsolute(entry.command) ? entry.command : entry.command === "node" ? legacyNode : undefined;
  if (!command || await realpath(command).catch(() => undefined) !== await realpath(launch.command)) return false;
  const env = entry.env ?? {};
  return isObject(env) && Object.entries(launch.env).every(([key, value]) =>
    key === "BEVEL_ENABLE_WRITES"
      ? writesFlag(env[key]) !== undefined && writesFlag(env[key]) === writesFlag(value)
      : env[key] === value,
  ) && Object.keys(env).every((key) => Object.hasOwn(launch.env, key));
}

/** An entry that setup wrote (or could have): this build's server, this Node, and only settings setup knows. */
async function managedLaunch(entry: unknown, legacyNode?: string): Promise<Launch | undefined> {
  if (!isObject(entry) || !Array.isArray(entry.args) || entry.args.length !== 1 || entry.args[0] !== ENTRY ||
      typeof entry.command !== "string" || (entry.type !== undefined && entry.type !== "stdio")) return undefined;
  const command = isAbsolute(entry.command) ? entry.command : entry.command === "node" ? legacyNode : undefined;
  if (!command || await realpath(command).catch(() => undefined) !== await realpath(process.execPath)) return undefined;
  const env = entry.env ?? {};
  const supported = ["BEVEL_ENABLE_WRITES", "BEVEL_TOKEN_FILE", "BEVEL_TIMEZONE", "BEVEL_APP_VERSION"];
  if (!isObject(env) || !Object.entries(env).every(([key, value]) => supported.includes(key) && typeof value === "string")) {
    return undefined;
  }
  return { command, args: [ENTRY], env: env as Record<string, string> };
}

export type Connection = "connected" | "failed" | "unknown";

/**
 * Reads the output of `claude mcp get bevel`. Only a clear status line counts either way. Anything
 * unrecognised is "unknown", so a wording change in Claude Code can't make a working setup look broken.
 */
export function parseCodeStatus(output: string): Connection {
  const text = stripAnsi(output);
  // A local or project entry named bevel overrides the user-scope entry that setup manages.
  if (/^\s*Scope:\s*(?:Local|Project)\b/im.test(text)) return "failed";
  const status = text.match(/^\s*Status:\s*(.+?)\s*$/im)?.[1];
  if (!status) return "unknown";
  if (/^(?:[✓✔]\s*)?Connected\b/i.test(status)) return "connected";
  if (/[✗✘]|fail|error|disconnected|disabled|not connected|needs auth/i.test(status)) return "failed";
  return "unknown";
}

async function codeConnection(io: CliIo, cli: string): Promise<Connection> {
  try {
    return parseCodeStatus((await (io.run ?? defaultRunner)(cli, ["mcp", "get", "bevel"])).stdout);
  } catch (error) {
    return /No MCP server found/i.test(error instanceof Error ? error.message : "") ? "failed" : "unknown";
  }
}

const CODE_NOT_CONNECTED = "The MCP launch worked, but Claude Code did not report Connected. Run claude mcp get bevel to check its configuration.";
const CODE_STATUS_UNKNOWN = "Claude Code’s status could not be read. The server itself was verified; confirm with claude mcp list.";

export interface SetupOptions {
  /** true for --writes, false for --read-only; undefined keeps the current entry's setting (or read-only). */
  writes?: boolean;
}

/** Quotes a word for a POSIX shell only when it needs it. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function commandLine(launch: Launch): string {
  return [launch.command, ...launch.args].map(shellQuote).join(" ");
}

async function copyToClipboard(io: CliIo, text: string): Promise<boolean> {
  try {
    await (io.run ?? defaultRunner)("/usr/bin/pbcopy", [], text);
    return true;
  } catch {
    return false;
  }
}

/** Setup instructions for an AI agent. Contains the launch command and no secrets. */
export function aiPrompt(launch: Launch, writes: boolean, tokenFile?: string): string {
  return [
    "Please connect the Bevel Health MCP server to this AI app, so you can help me",
    "with my Bevel data.",
    "",
    "It's a local stdio MCP server on this Mac. Add it to your MCP settings under",
    "the name \"bevel\":",
    "",
    `  command: ${launch.command}`,
    `  args: ${JSON.stringify(launch.args)}`,
    "",
    "As one command line:",
    `  ${commandLine(launch)}`,
    "",
    "Setup notes:",
    "- Don't add a token, API key or other secret. The server reads its own token",
    tokenFile ? "  from the token file named in its arguments." : "  from my macOS Keychain.",
    "- It needs no environment variables, network ports or installs.",
    "- If this app can't run local stdio MCP servers (a web-only chat, for example),",
    "  tell me so instead of trying a workaround.",
    "- Once it's added, reload your MCP servers and call bevel_auth_status with",
    "  checkApi set to true. It should say that Bevel accepted the token. Then tell",
    "  me which settings file you changed.",
    "",
    "What it offers: my Bevel Journal, meals and nutrition, macro goals, workout",
    "routines and completed workouts, read from Bevel.",
    "",
    "When you use it:",
    "- This is private health data. Don't share it with other tools, websites or",
    "  people unless I ask.",
    "- Dates are in my local time zone. Ask me when a date is unclear.",
    ...(writes
      ? [
          "- You can change my Bevel data. Before any change, run the write tool with",
          "  dryRun first, show me what will change, and wait for my OK.",
        ]
      : [
          "- Access is read-only, so write tools will refuse. If I ask for a change,",
          "  tell me to run npm run setup -- --client prompt --writes in the Bevel-MCP",
          "  folder.",
        ]),
  ].join("\n");
}

export async function runSetup(
  io: CliIo,
  requested: string | undefined,
  ask: Prompt,
  capture: (ask: Prompt, file?: string, mitmdump?: string) => Promise<void>,
  options: SetupOptions = {},
): Promise<number> {
  const target = selectedClient(requested);
  const ui = createUi(io.color === true);
  const say = (line = "") => io.out(line ? `   ${line}` : "");
  const confirm = async (text: string) => /^y(es)?$/i.test((await ask(ui.question(`\n   ${text} [y/N] `))).trim());
  const spin = (text: string) => startSpinner(ui, io.out, io.write, `   ${text}`);

  for (const line of ui.heading("setup", "Connect your Bevel data to your AI", SERVER_VERSION, io.columns)) io.out(line);
  io.out(ui.dim("Four steps. Nothing is added to an AI app until you confirm in step 3. Ctrl+C cancels."));
  io.out(`\n${ui.step(1, "Choose where to use Bevel")}\n`);
  const home = io.homeDir ?? homedir();
  const clients = await discoverClients(home);
  const found: Partial<Record<ClientKind, boolean>> = {
    code: Boolean(clients.claude),
    desktop: clients.desktopInstalled,
    grok: Boolean(clients.grokCli),
  };
  let kind: ClientKind = target ?? MENU.find((option) => found[option]) ?? "other";
  if (!target) {
    const notes: Partial<Record<ClientKind, string>> = {
      other: "shows the settings to paste in",
      prompt: "copies instructions for an AI to follow",
    };
    const width = Math.max(...MENU.map((option) => CLIENT_NAME[option].length));
    MENU.forEach((option, index) => {
      const state = found[option] === true ? ui.green("found") : found[option] === false ? ui.dim("not found") : ui.dim(notes[option] ?? "");
      say(`${ui.accent(`${index + 1}.`)} ${CLIENT_NAME[option].padEnd(width)}  ${state}`);
    });
    const fallback = String(MENU.indexOf(kind) + 1);
    const choice = (await ask(ui.question(`\n   Choose [${fallback}] `))).trim() || fallback;
    const picked = /^\d+$/.test(choice) ? MENU[Number(choice) - 1] : undefined;
    if (!picked) throw new Error(`Choose a number from 1 to ${MENU.length} and rerun setup.`);
    kind = picked;
    io.out("");
  }
  if ((kind === "code" && !clients.claude) || (kind === "desktop" && !clients.desktopInstalled)) {
    throw new Error(`${CLIENT_NAME[kind]} was not found. Install it and rerun setup.`);
  }
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Install Node.js 20 or newer.");
  await access(ENTRY).catch(() => { throw new Error("Run npm ci to build Bevel-MCP, then rerun setup."); });
  const snapshot = isClaude(kind)
    ? await readClient(clients[kind]).catch(() => {
        throw new Error(`${CLIENT_NAME[kind]} configuration could not be read. Fix it before rerunning setup.`);
      })
    : undefined;
  say(ui.ok(isClaude(kind) ? `Node.js and ${CLIENT_NAME[kind]} are ready.` : "Node.js is ready."));
  if (kind === "grok") say(ui.dim("The Grok app and Grok Bot can’t reach a server on your Mac. Grok Build, the terminal agent, can."));
  io.out(`\n${ui.step(2, "Connect to Bevel")}\n`);

  const config = loadConfig(process.env, "darwin");
  if (config.baseUrl !== DEFAULT_BASE_URL) throw new Error("Remove BEVEL_BASE_URL before running setup for your Bevel account.");
  const file = config.token?.kind === "file" ? resolve(config.token.path) : undefined;
  const node = await executable("node", home);
  const legacyNode = kind === "code" ? node : undefined;
  const runningNode = await realpath(process.execPath);
  const existing = snapshot?.servers.bevel;
  const managed = snapshot ? await managedLaunch(existing, legacyNode) : undefined;
  const before = managed ? writesFlag(managed.env.BEVEL_ENABLE_WRITES) ?? false : undefined;
  const writes = options.writes ?? before ?? false;
  const command = node && await realpath(node).catch(() => undefined) === runningNode ? node : runningNode;
  const timeZone = process.env.BEVEL_TIMEZONE ? config.timeZone : undefined;
  const appVersion = process.env.BEVEL_APP_VERSION ? config.appVersion : undefined;
  // Claude entries keep their settings in env, as they always have. Other apps get `serve` arguments,
  // because every MCP client can pass arguments but they differ in how they set environment variables.
  const launch: Launch = isClaude(kind)
    ? {
        command,
        args: [ENTRY],
        env: {
          BEVEL_ENABLE_WRITES: writes ? "true" : "false",
          ...(file ? { BEVEL_TOKEN_FILE: file } : {}),
          ...(timeZone ? { BEVEL_TIMEZONE: timeZone } : {}),
          ...(appVersion ? { BEVEL_APP_VERSION: appVersion } : {}),
        },
      }
    : { command, args: [ENTRY, ...serveArgs({ writes, tokenFile: file, timeZone, appVersion })], env: {} };
  const already = snapshot ? await compatibleEntry(existing, launch, legacyNode) : false;
  if (!already && existing !== undefined && kind === "code" && !managed) {
    throw new Error("Claude Code already has a different user-scope bevel entry. Review it with claude mcp get bevel, then remove or rename it before rerunning setup.");
  }
  const checking = spin("Checking for a saved token…");
  let effective: LaunchCheck;
  try {
    effective = await probe(io, config);
  } finally {
    checking.stop();
  }
  if (effective === "credential") {
    say(ui.warn("No working token yet. Next, get one from the Bevel app on your iPhone."));
    const mitmdump = await executable(process.env.BEVEL_MITMDUMP || "mitmdump", home);
    if (!mitmdump) throw new Error("Install mitmproxy with brew install mitmproxy, then rerun setup.");
    io.out("");
    await capture(ask, file, mitmdump);
  } else if (effective !== "ok") {
    throw new Error(explain(effective));
  } else if (config.token && !file &&
             !(config.token.kind === "command" && config.token.command === DEFAULT_MACOS_TOKEN_COMMAND)) {
    say(ui.ok("Bevel accepted your token."));
    const store = keychain(io);
    const token = await authDeps(io, config).tokenProvider!.getToken();
    // Check the exact credential again if a command provider can rotate between reads.
    if (!(await checkApi(authDeps(io, config, token))).ok) throw new Error("Bevel could not verify the token for Keychain.");
    const saved = await store.load?.();
    if (saved !== token) {
      let account: unknown;
      if (saved) {
        try { account = decodeJwt(saved).payload.userId; } catch { /* Replace malformed local credentials after confirmation. */ }
      }
      if (typeof account === "string" && account !== decodeJwt(token).payload.userId) {
        throw new Error("Keychain already holds a different Bevel account. Select the intended account before setup.");
      }
      if (!await confirm("Save the token to Keychain for your AI app?")) return declined(io, ui);
      await store.save(token);
    }
  } else {
    say(ui.ok("Bevel accepted your saved token. iPhone setup skipped."));
  }

  io.out(`\n${ui.step(3, "Review the settings")}\n`);
  const changed = before !== undefined && before !== writes ? ui.dim(` (was ${accessLabel(before)})`) : "";
  const review: Array<[string, string]> = [
    ["Use with", CLIENT_NAME[kind]],
    ["Access", (writes ? ui.yellow : ui.green)(accessLabel(writes)) + changed],
  ];
  if (isClaude(kind)) review.push(["Node", launch.command], ["Server", ENTRY]);
  else review.push(["Command", launch.command], ["Arguments", launch.args.map(shellQuote).join(" ")]);
  review.push(["Token source", file ?? "macOS Keychain"]);
  if (isClaude(kind) && timeZone) review.push(["Time zone", timeZone]);
  if (isClaude(kind) && appVersion) review.push(["App version", appVersion]);
  for (const line of ui.box(ui.rows(review), { indent: "   ", maxWidth: io.columns })) io.out(line);
  io.out("");
  say(writes
    ? ui.warn(`${AGENT[kind]} can change your Bevel data. Use --read-only to turn this off.`)
    : ui.dim(`${AGENT[kind]} can read your Bevel data but not change it. Use --writes to allow changes.`));
  const cli = kind === "grok" ? clients.grokCli : undefined;
  const cliName = "Grok Build";
  if (already) {
    io.out("");
    say(ui.ok("Using your existing Bevel entry."));
  } else if (isClaude(kind)) {
    const action = existing === undefined ? "Add Bevel to Claude?" : managed ? "Update your Bevel entry?" : "Replace the existing Bevel entry?";
    if (!await confirm(action)) return declined(io, ui);
  } else if (cli) {
    if (!await confirm(`Add Bevel to ${cliName}?`)) return declined(io, ui);
  }

  io.out(`\n${ui.step(4, "Verify the connection")}\n`);
  const verifying = spin("Starting the server and asking Bevel…");
  let checked: LaunchCheck;
  try {
    checked = await (io.verifyLaunch ?? verifyLaunch)(launch);
  } finally {
    verifying.stop();
  }
  if (checked !== "ok") throw new Error(explain(checked));
  say(ui.ok("The MCP server started and Bevel accepted a read-only request."));
  io.signal?.throwIfAborted();

  const run = io.run ?? defaultRunner;
  if (kind === "desktop") {
    if (!already) await writeDesktop(clients.desktop, snapshot!, launch);
    say(ui.ok("Claude Desktop is configured."));
    say(ui.warn("Quit and reopen Claude Desktop to load Bevel."));
  } else if (kind === "code") {
    if (!already) {
      if (managed) {
        try {
          await run(clients.claude!, ["mcp", "remove", "bevel", "--scope", "user"]);
        } catch {
          throw new Error("Claude Code could not remove the old bevel entry. Check it with claude mcp get bevel, then rerun setup.");
        }
      }
      try {
        await run(clients.claude!, [
          "mcp", "add-json", "bevel", JSON.stringify({ type: "stdio", ...launch }), "--scope", "user",
        ]);
      } catch {
        throw new Error(managed
          ? "Claude Code removed the old bevel entry but could not save the new one. Rerun setup to add it."
          : "Claude Code could not save the bevel entry. Check for an existing entry with claude mcp get bevel.");
      }
    }
    const asking = spin("Asking Claude Code for its status…");
    let connection: Connection;
    try {
      connection = await codeConnection(io, clients.claude!);
    } finally {
      asking.stop();
    }
    if (connection === "failed") throw new Error(CODE_NOT_CONNECTED);
    say(connection === "connected" ? ui.ok("Claude Code is connected.") : ui.warn(CODE_STATUS_UNKNOWN));
  } else if (cli) {
    try {
      await run(cli, ["mcp", "add", "bevel", "--", launch.command, ...launch.args]);
    } catch (error) {
      const reason = error instanceof Error ? ` (${error.message})` : "";
      throw new Error(`${cliName} could not add Bevel${reason}. If Bevel is already there, remove it first, then rerun setup.`);
    }
    say(ui.ok(`${cliName} added Bevel.`));
    say(ui.warn("Start a new Grok Build session to load Bevel."));
  } else {
    await showManualSteps(io, ui, kind, launch, writes, file);
  }

  io.out("");
  const tryAsking: Record<ClientKind, string> = {
    code: "Try asking Claude",
    desktop: "Try asking Claude",
    grok: "Try asking Grok Build",
    other: "Once it’s added, try asking",
    prompt: "Once your AI has set it up, try asking",
  };
  const flag = writes ? "--read-only" : "--writes";
  const next = ui.rows([
    [writes ? "Make read-only" : "Allow writes", `npm run setup -- ${isClaude(kind) ? "" : `--client ${kind} `}${flag}`],
    isClaude(kind) ? ["Check later", "npm run doctor"] : ["Check the token", "npm run status"],
  ]);
  const done = [tryAsking[kind], ui.accent("“What did I log in my Journal yesterday?”"), "", ...next];
  for (const line of ui.box(done, { title: "Setup complete", indent: "   ", tone: "green", maxWidth: io.columns })) io.out(line);
  io.out("");
  return 0;
}

/** For apps setup can't configure itself: shows (and copies) exactly what to add. */
async function showManualSteps(
  io: CliIo, ui: Ui, kind: ClientKind, launch: Launch, writes: boolean, tokenFile: string | undefined,
): Promise<void> {
  const say = (line = "") => io.out(line ? `   ${line}` : "");
  const show = (lines: string[]) => {
    for (const line of ui.box(lines, { indent: "   ", tone: "accent", maxWidth: io.columns })) io.out(line);
  };
  const copied = async (text: string, what: string) => {
    io.out("");
    say(await copyToClipboard(io, text) ? ui.ok(`Copied ${what} to your clipboard.`) : ui.dim(`Copy ${what} from above.`));
  };
  io.out("");
  if (kind === "grok") {
    const command = `grok mcp add bevel -- ${commandLine(launch)}`;
    say("Install Grok Build, then run this command to add Bevel:");
    show([ui.accent(command)]);
    await copied(command, "the command");
  } else if (kind === "other") {
    const json = JSON.stringify({ mcpServers: { bevel: { command: launch.command, args: launch.args } } }, null, 2);
    say("Add this to your MCP client’s settings. Most clients use this JSON format:");
    show(json.split("\n").map((line) => ui.accent(line)));
    await copied(json + "\n", "the JSON");
    say(ui.dim("Clients with separate fields need only the command and the arguments."));
    say(ui.dim("To try the server without an AI app, run the MCP Inspector:"));
    say(ui.accent(`npx @modelcontextprotocol/inspector ${commandLine(launch)}`));
  } else {
    const prompt = aiPrompt(launch, writes, tokenFile);
    const rule = ui.dim("─".repeat(Math.min(80, Math.max(20, (io.columns ?? 80) - 6))));
    say("Give this prompt to an AI agent that can change its own MCP settings:");
    io.out("");
    say(rule);
    for (const line of prompt.split("\n")) say(line);
    say(rule);
    await copied(prompt + "\n", "the prompt");
  }
}

function declined(io: CliIo, ui: Ui): number {
  io.out("");
  io.out(`   ${ui.dim("Nothing was changed. Rerun setup when you’re ready.")}`);
  return 1;
}

export async function runDoctor(io: CliIo, requested: string | undefined): Promise<number> {
  const target = selectedClient(requested);
  if (target && !isClaude(target)) {
    throw new Error("Doctor checks Claude Code and Claude Desktop. For other apps, run bevel-mcp status --check.");
  }
  const ui = createUi(io.color === true);
  const say = (line: string) => io.out(`   ${line}`);
  const home = io.homeDir ?? homedir();
  const clients = await discoverClients(home);
  const kinds: ClaudeKind[] = target ? [target] : [
    ...(clients.claude ? ["code" as const] : []), ...(clients.desktopInstalled ? ["desktop" as const] : []),
  ];
  for (const line of ui.heading("doctor", "A shareable report: no tokens or health data", SERVER_VERSION, io.columns)) io.out(line);
  const built = await access(ENTRY).then(() => true, () => false);
  say(built ? ui.ok("Server build is present.") : ui.fail("Server build is missing. Run npm ci."));
  if (!kinds.length) {
    const config = (() => { try { return loadConfig(); } catch { return undefined; } })();
    const credential = config ? await probe(io, config) : "api";
    io.out("");
    say(credential === "ok" ? ui.ok(explain(credential)) : ui.fail(explain(credential)));
    say(ui.fail("Install Claude Code or Claude Desktop, then run bevel-mcp setup."));
    return 1;
  }
  let success = built;
  let warnings = 0;
  for (const kind of kinds) {
    io.out(`\n${ui.bold(CLIENT_NAME[kind])}\n`);
    const state = await readClient(clients[kind]).catch(() => undefined);
    if (!state) {
      say(ui.fail("The settings file is unreadable or contains invalid JSON."));
      success = false;
      continue;
    }
    const legacyNode = kind === "code" ? await executable("node", home) : undefined;
    const entry = await managedLaunch(state.servers.bevel, legacyNode);
    if (!entry) {
      say(ui.fail(`No matching Bevel entry. Run bevel-mcp setup --client ${kind}.`));
      success = false;
      continue;
    }
    say(`${ui.dim("Access")}  ${accessLabel(writesFlag(entry.env.BEVEL_ENABLE_WRITES) ?? false)}`);
    const verifying = startSpinner(ui, io.out, io.write, "   Starting the server and asking Bevel…", { echo: false });
    let checked: LaunchCheck;
    try {
      checked = built ? await (io.verifyLaunch ?? verifyLaunch)(entry).catch(() => "launch" as const) : "launch";
    } finally {
      verifying.stop();
    }
    say(checked === "ok" ? ui.ok(explain(checked)) : ui.fail(explain(checked)));
    if (checked === "credential" && entry.env.BEVEL_TOKEN_FILE) {
      say(ui.dim("Renew the token with token capture --file PATH."));
    }
    success &&= checked === "ok";
    if (checked === "ok" && kind === "code") {
      if (!clients.claude) {
        say(ui.fail("The claude command was not found, so Claude Code’s status can’t be checked."));
        success = false;
        continue;
      }
      const connection = await codeConnection(io, clients.claude);
      if (connection === "connected") {
        say(ui.ok("Claude Code reports Connected."));
      } else if (connection === "unknown") {
        say(ui.warn(CODE_STATUS_UNKNOWN));
        warnings++;
      } else {
        say(ui.fail("Claude Code did not report Connected. Run claude mcp get bevel."));
        success = false;
      }
    }
  }
  io.out("");
  if (!success) io.out(ui.fail(ui.bold("Some checks failed. Fix the ✗ items above, then run doctor again.")));
  else io.out(ui.ok(ui.bold(warnings ? "No problems found. See the note above." : "No problems found.")));
  return success ? 0 : 1;
}
