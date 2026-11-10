/**
 * `bevel-mcp <command>`: helper commands. With no command, bevel-mcp runs the MCP server.
 *
 *   bevel-mcp setup [--client code|desktop|grok|other|prompt] [--writes | --read-only]
 *   bevel-mcp doctor [--client code|desktop]
 *   bevel-mcp token capture [--port 8080] [--timeout 300] [--file PATH]
 *   bevel-mcp token set [--file PATH]      token from the clipboard (or piped stdin)
 *   bevel-mcp status [--check]
 *
 * `bevel-mcp serve [--writes] [--file PATH] [--timezone TZ]` runs the server; src/index.ts handles it.
 *
 * The token is never printed.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { decodeJwt, summarizeJwt } from "../auth/jwt.js";
import { normalizeToken, StaticTokenProvider } from "../auth/tokenProvider.js";
import { DEFAULT_BASE_URL, loadConfig } from "../config.js";
import { redactString, silentLogger } from "../log.js";
import type { FetchLike } from "../http/client.js";
import { buildDeps } from "../server.js";
import { checkApi, getAuthStatus, type ApiCheck } from "../tools/auth.js";
import { SERVER_VERSION } from "../version.js";
import { captureToken } from "./capture.js";
import { prepareIphoneProfile } from "./iphoneProfile.js";
import { lanAddresses } from "./network.js";
import {
  CAPTURE_CONFIG_DIR, FileStore, KeychainStore, defaultRunner, defaultStore, type Runner, type TokenStore,
} from "./tokenStore.js";
import { runDoctor, runSetup, type Launch, type LaunchCheck, type Prompt } from "./setup.js";
import { createUi, detectColor, startSpinner, stripAnsi, type Spinner, type Ui } from "./ui.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ADDON_PATH = join(PACKAGE_ROOT, "capture", "token_capture.py");

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Overrides for tests. */
  store?: TokenStore;
  run?: Runner;
  readInput?: () => Promise<string>;
  settleMs?: number;
  fetch?: FetchLike;
  lan?: () => string[];
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  prompt?: Prompt;
  homeDir?: string;
  captureConfigDir?: string;
  verifyLaunch?: (launch: Launch) => Promise<LaunchCheck>;
  /** Use colour, the logo and spinners (an interactive terminal). Off by default. */
  color?: boolean;
  /** Terminal width, used to fit the logo and boxes. */
  columns?: number;
  /** Raw stdout writes for the spinner. */
  write?: (chunk: string) => void;
}

/** The real terminal: colour and animation only where the stream is an interactive terminal. */
export function terminalIo(signal: AbortSignal): CliIo {
  const color = detectColor(process.stdout);
  const errColor = detectColor(process.stderr);
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${errColor ? line : stripAnsi(line)}\n`),
    ...(color ? { write: (chunk: string) => process.stdout.write(chunk) } : {}),
    color,
    columns: process.stdout.columns,
    signal,
  };
}

const COMMANDS: Array<[string, string]> = [
  ["setup", "Connect Bevel to Claude, Grok Build or another MCP client (macOS)"],
  ["doctor", "Check your Claude setup and print a shareable report"],
  ["serve", "Run the MCP server (your AI app starts this for you)"],
  ["status", "Show your token source and expiry"],
  ["token capture", "Get a new token from Bevel on your iPhone"],
  ["token set", "Save a token from the clipboard or stdin"],
];

const OPTIONS: Array<[string, string]> = [
  ["--client NAME", "Setup: code, desktop, grok, other or prompt"],
  ["--writes", "Setup or serve: let your AI change your Bevel data"],
  ["--read-only", "Setup or serve: read only (the default)"],
  ["--port N", "Capture proxy port (default 8080)"],
  ["--timeout S", "Seconds to wait for Bevel (default 300)"],
  ["--file PATH", "Use a token file instead of Keychain"],
  ["--timezone TZ", "Serve: time zone for dates (default: this computer's)"],
  ["--app-version V", "Serve: Bevel app version to send"],
  ["--force", "Allow capture to replace a newer or different token"],
  ["--check", "Have status check the token with Bevel"],
  ["-h, --help", "Show this help"],
];

function help(ui: Ui, columns?: number): string {
  const key = (name: string) => ui.accent(name);
  return [
    ...(ui.color ? ui.heading("help", "Bevel Health tools for your AI", SERVER_VERSION, columns) : [`Bevel MCP ${SERVER_VERSION}`, ""]),
    ui.bold("Usage"),
    `  bevel-mcp ${ui.dim("[command] [options]")}`,
    "",
    ui.bold("Commands"),
    ...ui.rows(COMMANDS, { indent: "  ", key }),
    "",
    ui.dim("With no command, bevel-mcp runs the MCP server, like serve."),
    "",
    ui.bold("Options"),
    ...ui.rows(OPTIONS, { indent: "  ", key }),
  ].join("\n");
}

function storeFor(io: CliIo, file: string | undefined): TokenStore {
  if (file) return new FileStore(file);
  if (io.store) return io.store;
  const platform = io.platform ?? process.platform;
  return platform === "darwin" ? new KeychainStore(io.run ?? defaultRunner) : defaultStore(platform);
}

/** Validates a Bevel token and returns its expiry facts; throws with a clear message otherwise. */
export function checkBevelToken(token: string, nowMs = Date.now()) {
  let summary;
  try {
    summary = summarizeJwt(token, nowMs);
  } catch {
    throw new Error(
      `That doesn't look like a Bevel token (it should be three dot-separated parts, ${token.length} characters received). ` +
        "Copy the whole Authorization value.",
    );
  }
  const { userId, exp } = decodeJwt(token).payload;
  if (typeof userId !== "string" || !userId) throw new Error("That token has no valid userId claim.");
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new Error("That token has no valid expiry.");
  if (summary.expired) throw new Error(`That token expired on ${summary.expiresAt}. Capture a fresh one.`);
  return summary;
}

async function saveAndReport(io: CliIo, raw: string, store: TokenStore): Promise<void> {
  const ui = createUi(io.color === true);
  const token = normalizeToken(raw);
  const summary = checkBevelToken(token);
  await store.save(token);
  const days = summary.secondsUntilExpiry !== undefined ? Math.round(summary.secondsUntilExpiry / 86400) : undefined;
  io.out(ui.ok(ui.bold(`Token saved to ${store.description}.`)));
  const facts: Array<[string, string]> = [];
  if (summary.issuedAt) facts.push(["Issued", summary.issuedAt]);
  if (summary.expiresAt) facts.push(["Expires", `${summary.expiresAt}${days !== undefined ? ui.green(` (in ${days} days)`) : ""}`]);
  for (const line of ui.rows(facts, { indent: "  " })) io.out(line);
  if (store instanceof KeychainStore) {
    io.out(`  ${ui.dim("The server reads this token from macOS Keychain.")}`);
  } else if (store instanceof FileStore) {
    io.out(`  Point the server at it with BEVEL_TOKEN_FILE=${store.description.replace(/^file /, "")}`);
  }
  io.out(`  ${ui.dim("A running server picks up the new token when Bevel rejects the old one.")}`);
}

async function tokenCapture(io: CliIo, values: Record<string, unknown>, ask?: Prompt, mitmdump?: string): Promise<void> {
  const port = Number(values.port ?? 8080);
  const timeoutS = Number(values.timeout ?? 300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a port number");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS * 1000 > 2_147_483_647) {
    throw new Error("--timeout must be a positive number of seconds within the timer limit");
  }
  const config = loadConfig(process.env, io.platform ?? process.platform);
  if (config.baseUrl !== DEFAULT_BASE_URL) {
    throw new Error("Token capture verification requires Bevel’s default API. Remove BEVEL_BASE_URL and retry.");
  }
  const file = values.file as string | undefined ?? (config.token?.kind === "file" ? config.token.path : undefined);
  const store = storeFor(io, file);
  const ui = createUi(io.color === true);
  const question = ask && ((text: string, signal?: AbortSignal) => ask(ui.question(text), signal));
  const indent = ask ? "   " : "";
  const detail = indent + "   ";
  const report = (line: string) => io.out(indent + line);
  const say = (line = "") => io.out(line ? detail + line : "");
  const place = (text: string) => ui.bold(text);
  let phoneStep = 0;
  const step = (title: string) => io.out(`\n${indent}${ui.step(++phoneStep, title)}\n`);
  const spin = (text: string) => startSpinner(ui, io.out, io.write, text);
  if (!ask) {
    for (const line of ui.heading("token capture", "Get a fresh token from the Bevel app", SERVER_VERSION, io.columns)) io.out(line);
  }

  const addresses = (io.lan ?? lanAddresses)();
  let host = addresses[0];
  if (!host) throw new Error("No LAN IPv4 address was found. Connect the Mac and iPhone to the same Wi-Fi and retry.");
  if (question && addresses.length > 1) {
    report("Choose the Mac address on the same Wi-Fi as your iPhone.");
    io.out("");
    addresses.forEach((address, index) => say(`${ui.accent(`${index + 1}.`)} ${address}`));
    const selection = (await question(`\n${detail}Address [1] `)).trim();
    host = addresses[Number(selection || "1") - 1];
    if (!host) throw new Error("Choose an address from the list and rerun setup.");
    io.out("");
  }
  const proxyHost = host;

  const configDir = io.captureConfigDir ?? CAPTURE_CONFIG_DIR;
  let phoneInstructionsShown = false;
  let waiting = undefined as Spinner | undefined;
  if (ask) report(ui.bold("iPhone setup"));
  report(`Starting the proxy. ${ui.dim("Press Ctrl+C to cancel.")}`);
  let captured;
  try {
    captured = await captureToken({
      mitmdump: mitmdump ?? (process.env.BEVEL_MITMDUMP || "mitmdump"),
      addonPath: ADDON_PATH,
      configDir,
      host: proxyHost,
      port,
      timeoutMs: timeoutS * 1000,
      settleMs: io.settleMs,
      onReady: async (signal) => {
        if (question) {
          step("Install the certificate");
          const keys = ui.rows([["Enter", "Prepare the iPhone profile"], ["S", "Skip if you already trust this proxy"]], {
            indent: detail,
            key: (name) => ui.accent(ui.bold(name)),
          });
          for (const line of keys) io.out(line);
          const choice = await question(`\n${detail}Continue [Enter/S] `, signal);
          if (choice.trim().toLowerCase() !== "s") {
            const profile = await prepareIphoneProfile(configDir);
            signal.throwIfAborted();
            io.out("");
            try {
              await (io.run ?? defaultRunner)("/usr/bin/open", ["-R", profile]);
              say(ui.ok("Finder opened with the profile selected."));
            } catch {
              say(`In Finder, choose ${place("Go › Go to Folder")} and enter this path.`);
              say(ui.accent(configDir));
              say(`Select ${place("Bevel Capture Certificate.mobileconfig")}.`);
            }
            signal.throwIfAborted();
            say(`Right-click it and choose ${place("Share › AirDrop › your iPhone")}.`);
            say();
            say(`On your iPhone, go to ${place("Settings › Profile Downloaded")}.`);
            say(`Install ${place("Bevel Capture Certificate")}.`);
            say();
            say(`Go to ${place("Settings › General › About › Certificate Trust Settings")}.`);
            say(`Turn on full trust for ${place("mitmproxy")}.`);
            await question(`\n${detail}Press Enter when the certificate is trusted. `, signal);
          }
        }
        phoneInstructionsShown = true;
        step("Set the Wi-Fi proxy");
        say("Connect your iPhone and Mac to the same Wi-Fi.");
        say(`On your iPhone, go to ${place("Settings › Wi-Fi › (i)")}.`);
        say(`Choose ${place("Configure Proxy › Manual")}, then enter these values.`);
        say();
        const proxy = ui.rows([["Server", ui.accent(ui.bold(proxyHost))], ["Port", ui.accent(ui.bold(String(port)))]]);
        for (const line of ui.box(proxy, { indent: detail, tone: "accent" })) io.out(line);
        if (question) {
          await question(`\n${detail}Tap Save on your iPhone, then press Enter here. `, signal);
        } else {
          say();
          say(ui.dim("For first-time setup, use bevel-mcp setup on macOS."));
          say(ui.dim("You can also open http://mitm.it in iPhone Safari and select iOS."));
        }
        step("Open Bevel");
        say("Open the Bevel app or pull to refresh if it is already open.");
        waiting = spin(`${detail}Waiting for Bevel…`);
      },
      onFirstToken: () => {
        waiting?.stop(detail + ui.ok("Token received."));
        waiting = spin(`${detail}Checking briefly for a newer one…`);
      },
      signal: io.signal,
    });
  } finally {
    waiting?.stop();
    if (phoneInstructionsShown) {
      step("Turn the proxy off");
      say(`On your iPhone, go to ${place("Settings › Wi-Fi › (i)")}.`);
      say(`Choose ${place("Configure Proxy › Off")}, then tap Save.`);
    }
  }
  if (question) await question(`\n${detail}Press Enter when the proxy is off. `);
  io.out("");
  if (captured.distinct > 1) {
    report(`Bevel sent ${captured.distinct} tokens. Using the one that expires last.`);
  }

  const token = normalizeToken(captured.token);
  checkBevelToken(token);
  const saved = await store.load?.();
  const decision = compareWithSaved(saved, token);
  if (decision.refuse && !values.force) throw new Error(decision.message);
  async function verify(candidate: string): Promise<ApiCheck> {
    return checkApi(buildDeps(config, {
      logger: silentLogger,
      tokenProvider: new StaticTokenProvider(candidate),
      fetch: io.fetch,
    }));
  }

  if (saved && decision.keep && !values.force) {
    const current = await verify(saved);
    if (current.ok) {
      report(ui.ok(decision.message));
      return;
    }
    if (current.reason !== "credential") {
      throw new Error("Could not verify the saved token with Bevel. Run bevel-mcp doctor and try again.");
    }
  }
  const checking = spin(`${indent}Checking the token with Bevel…`);
  let accepted: ApiCheck;
  try {
    accepted = await verify(token);
  } finally {
    checking.stop();
  }
  if (!accepted.ok) {
    throw new Error("Bevel could not verify the captured token. Your saved credential was preserved. Run bevel-mcp doctor.");
  }
  await saveAndReport({ ...io, out: report }, token, store);
}

/**
 * Guards automatic capture: never swap the saved token for one that expires sooner (keep), and never
 * for another Bevel account's token (refuse). --force overrides both.
 */
function compareWithSaved(
  saved: string | undefined,
  capturedToken: string,
): { keep?: boolean; refuse?: boolean; message: string } {
  if (!saved) return { message: "" };
  let savedClaims: Record<string, unknown>;
  try {
    savedClaims = decodeJwt(saved).payload;
  } catch {
    return { message: "" };
  }
  const capturedClaims = decodeJwt(capturedToken).payload;
  const savedExp = typeof savedClaims.exp === "number" ? savedClaims.exp : 0;
  const capturedExp = typeof capturedClaims.exp === "number" ? capturedClaims.exp : 0;
  if (typeof savedClaims.userId === "string" && savedClaims.userId !== capturedClaims.userId) {
    return {
      refuse: true,
      message:
        "The captured token belongs to a different Bevel account than the saved one, so it was not saved. " +
        "Use --force if you really want to switch accounts.",
    };
  }
  if (savedExp * 1000 <= Date.now()) return { message: "" };
  if (saved === capturedToken) {
    return { keep: true, message: `Your saved token is already the newest one (expires ${new Date(savedExp * 1000).toISOString()}).` };
  }
  if (savedExp >= capturedExp) {
    return {
      keep: true,
      message:
        `Kept your saved token: it expires ${new Date(savedExp * 1000).toISOString()}, later than the one just captured ` +
        `(${new Date(capturedExp * 1000).toISOString()}). Use --force to replace it anyway.`,
    };
  }
  return { message: "" };
}

async function readClipboard(run: Runner): Promise<string> {
  return (await run("/usr/bin/pbpaste", [])).stdout;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function tokenSet(io: CliIo, values: Record<string, unknown>): Promise<number> {
  const store = storeFor(io, values.file as string | undefined);
  const run = io.run ?? defaultRunner;
  const fromClipboard = !io.readInput && process.stdin.isTTY;
  const raw = io.readInput ? await io.readInput() : fromClipboard ? await readClipboard(run) : await readStdin();
  if (!raw.trim()) throw new Error(fromClipboard ? "The clipboard is empty. Copy the Authorization value first." : "No token received on stdin.");
  await saveAndReport(io, raw, store);
  if (fromClipboard) {
    await run("/usr/bin/pbcopy", [], "");
    io.out("  Clipboard cleared.");
  }
  return 0;
}

async function status(io: CliIo, values: Record<string, unknown>): Promise<number> {
  const ui = createUi(io.color === true);
  const config = loadConfig(process.env, io.platform ?? process.platform);
  const deps = buildDeps(config, { logger: silentLogger, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const s = await getAuthStatus(deps);
  const rows: Array<[string, string]> = [["Token source", s.source ?? ui.dim("(none configured)")]];
  if (s.sourceError) rows.push(["Read error", ui.red(s.sourceError)]);
  if (s.claims) {
    rows.push(["Provider", s.claims.providerHint ?? ui.dim("(unknown)")]);
    if (s.claims.account) rows.push(["Account", s.claims.account]);
    if (s.claims.issuedAt) rows.push(["Issued", s.claims.issuedAt]);
    const left = s.claims.secondsUntilExpiry;
    const tone = s.claims.expired ? ui.red : left !== undefined && left < 7 * 86400 ? ui.yellow : ui.green;
    rows.push(["Expires", `${s.claims.expiresAt ?? "(no exp)"}${s.claims.expiresIn ? tone(` (in ${s.claims.expiresIn})`) : s.claims.expired ? tone(" (expired)") : ""}`]);
  }
  if (s.claimsError) rows.push(["Decode error", ui.red(s.claimsError)]);
  rows.push(["Time zone", s.timeZone]);
  rows.push(["Writes", s.writesEnabled ? ui.yellow("enabled") : `disabled ${ui.dim("(set BEVEL_ENABLE_WRITES=true to allow)")}`]);
  let apiOk = true;
  if (values.check && s.sourceReadable && !s.claimsError && !s.claims?.expired) {
    const api = await checkApi(deps);
    apiOk = api.ok;
    rows.push(["API", api.ok ? ui.ok(api.message) : ui.fail(api.message)]);
  }
  for (const line of ui.rows(rows)) io.out(line);
  for (const note of s.notes) io.out(`${ui.yellow("Note:")} ${note}`);
  if (!s.configured || s.sourceReadable === false) io.out("Run `bevel-mcp token capture` (or `bevel-mcp token set`) to store a token.");
  return s.sourceReadable && !s.claimsError && !s.claims?.expired && apiOk ? 0 : 1;
}

/** Returns a process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const ui = createUi(io.color === true);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        port: { type: "string" },
        timeout: { type: "string" },
        force: { type: "boolean" },
        check: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        client: { type: "string" },
        writes: { type: "boolean" },
        "read-only": { type: "boolean" },
      },
    });
    const [command, sub] = positionals;
    if (values.help || command === "help" || !command) {
      io.out(help(ui, io.columns));
      return 0;
    }
    if (values.writes || values["read-only"]) {
      if (command !== "setup") throw new Error("--writes and --read-only apply only to setup.");
      if (values.writes && values["read-only"]) throw new Error("Choose either --writes or --read-only, not both.");
    }
    const setupOptions = { writes: values.writes ? true : values["read-only"] ? false : undefined };
    if (command === "token" && sub === "capture") {
      await tokenCapture(io, values);
      return 0;
    }
    if (command === "doctor") return await runDoctor(io, values.client);
    if (command === "setup") {
      if ((io.platform ?? process.platform) !== "darwin") throw new Error("The setup wizard requires macOS.");
      if (io.prompt) {
        return await runSetup(io, values.client, io.prompt, (ask, file, mitmdump) =>
          tokenCapture(io, { ...values, file }, ask, mitmdump), setupOptions);
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run setup in an interactive terminal.");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      terminal.on("SIGINT", cancel);
      terminal.on("close", cancel);
      io.signal?.addEventListener("abort", cancel, { once: true });
      if (io.signal?.aborted) cancel();
      const setupIo = { ...io, signal: controller.signal };
      const ask: Prompt = (message, signal) => terminal.question(message, { signal: signal ?? controller.signal });
      try {
        return await runSetup(setupIo, values.client, ask, (prompt, file, mitmdump) =>
          tokenCapture(setupIo, { ...values, file }, prompt, mitmdump), setupOptions);
      } finally {
        io.signal?.removeEventListener("abort", cancel);
        terminal.close();
      }
    }
    if (command === "token" && sub === "set") return await tokenSet(io, values);
    if (command === "status") return await status(io, values);
    io.err(`${ui.fail(`Unknown command: ${positionals.join(" ")}`)}\n\n${help(ui, io.columns)}`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err("");
    io.err(ui.fail(io.signal?.aborted ? "Cancelled." : redactString(message)));
    return 1;
  }
}


