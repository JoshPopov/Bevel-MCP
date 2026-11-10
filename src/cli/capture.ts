import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CaptureOptions {
  mitmdump: string;
  addonPath: string;
  port: number;
  host?: string;
  configDir?: string;
  timeoutMs: number;
  pollMs?: number;
  settleMs?: number;
  onReady?: (signal: AbortSignal) => Promise<void>;
  onFirstToken?: () => void;
  signal?: AbortSignal;
}

export interface CaptureResult {
  token: string;
  distinct: number;
}

export async function captureToken(options: CaptureOptions): Promise<CaptureResult> {
  options.signal?.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), "bevel-token-"));
  try {
    const configDir = options.configDir ?? join(dir, "proxy");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    if (existsSync(join(configDir, "config.yaml"))) {
      throw new Error("The Bevel capture proxy needs its own configuration directory without a config.yaml.");
    }
    options.signal?.throwIfAborted();
    return await runProxy(options, dir, configDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runProxy(options: CaptureOptions, dir: string, configDir: string): Promise<CaptureResult> {
  const out = join(dir, "token");
  const ready = join(dir, "ready");
  const child = spawn(options.mitmdump, [
    "--quiet", "--mode", "regular", "--listen-host", options.host ?? "127.0.0.1",
    "--listen-port", String(options.port), "--allow-hosts", "^api\\.supersethealth\\.com:443$",
    "--set", `confdir=${configDir}`, "--set", "block_global=true",
    "--set", "onboarding=true", "--set", "save_stream_file=",
    "-s", options.addonPath, "--set", `bevel_token_out=${out}`, "--set", `bevel_capture_ready=${ready}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let startupError = "";
  child.stderr.on("data", (chunk: Buffer) => {
    startupError = (startupError + chunk.toString()).slice(-1024);
  });
  const prompt = new AbortController();

  try {
    return await new Promise<CaptureResult>((resolve, reject) => {
      let finished = false;
      let phase: "starting" | "prompt" | "waiting" | "settling" = "starting";
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: unknown) => finish(() => reject(error));
      const onAbort = () => fail(new Error("Capture cancelled."));
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        prompt.abort();
        callback();
      };
      const poll = setInterval(() => {
        if (phase === "starting" && existsSync(ready)) {
          phase = "prompt";
          clearTimeout(timer);
          (options.onReady?.(prompt.signal) ?? Promise.resolve()).then(() => {
            if (finished) return;
            phase = "waiting";
            timer = setTimeout(() => fail(new Error(
              `No request from the Bevel app was seen within ${Math.round(options.timeoutMs / 1000)} s. ` +
              "Check that the iPhone can reach the proxy and trusts the Bevel capture certificate.",
            )), options.timeoutMs);
          }, fail);
        }
        if (phase !== "waiting" || !existsSync(out)) return;
        phase = "settling";
        clearTimeout(timer);
        options.onFirstToken?.();
        timer = setTimeout(() => {
          readFile(out, "utf8").then((text) => {
            const result = JSON.parse(text) as Partial<CaptureResult>;
            if (typeof result.token !== "string") throw new Error("Missing token");
            finish(() => resolve({ token: result.token!, distinct: result.distinct ?? 1 }));
          }).catch(() => fail(new Error("The capture addon did not return a readable token.")));
        }, options.settleMs ?? 6000);
      }, options.pollMs ?? 100);
      timer = setTimeout(() => fail(new Error("The Bevel proxy did not become ready.")), 15_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error: NodeJS.ErrnoException) => fail(new Error(error.code === "ENOENT"
        ? "mitmdump was not found. Install mitmproxy with brew install mitmproxy."
        : "Could not start mitmdump.")));
      child.once("close", (code) => fail(new Error(/address already in use/i.test(startupError)
        ? "Address already in use. Choose a different capture port with --port."
        : `mitmdump stopped before a token was captured (exit ${code ?? "signal"}).`)));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(killTimer);
    }
  }
}
