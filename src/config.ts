import { z } from "zod";
import type { LogLevel } from "./log.js";
import { BevelConfigError } from "./http/errors.js";
import { assertValidTimeZone } from "./time.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.supersethealth.com";
/** App version observed in captured traffic (Bevel iOS 3.2.7). */
export const DEFAULT_APP_VERSION = "3.2.7";
/** Used only if the system time zone can't be determined. */
export const FALLBACK_TIME_ZONE = "America/New_York";

/** The machine's IANA time zone (e.g. "America/New_York"), as Node reports it. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export type TokenSourceConfig =
  | { kind: "env"; variable: "BEVEL_TOKEN"; value: string }
  | { kind: "file"; path: string }
  | { kind: "command"; command: string };

export interface BevelConfig {
  baseUrl: string;
  appVersion: string;
  userAgent: string;
  timeZone: string;
  enableWrites: boolean;
  logLevel: LogLevel;
  /** How long reads are reused within a session; 0 disables. Writes always clear it. */
  cacheSeconds: number;
  token: TokenSourceConfig | undefined;
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const booleanFlag = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === "") return false;
    const normalized = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    ctx.addIssue({ code: "custom", message: `expected true/false, got "${v}"` });
    return z.NEVER;
  });

const EnvSchema = z.object({
  BEVEL_TOKEN: optionalString,
  BEVEL_TOKEN_FILE: optionalString,
  BEVEL_TOKEN_COMMAND: optionalString,
  BEVEL_BASE_URL: optionalString,
  BEVEL_APP_VERSION: optionalString,
  BEVEL_USER_AGENT: optionalString,
  BEVEL_TIMEZONE: optionalString,
  BEVEL_ENABLE_WRITES: booleanFlag,
  BEVEL_CACHE_SECONDS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: "custom", message: `expected a number of seconds >= 0, got "${v}"` });
        return z.NEVER;
      }
      return n;
    }),
  BEVEL_LOG_LEVEL: z
    .enum(["error", "warn", "info", "debug"])
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BevelConfigError(`BEVEL_BASE_URL is not a valid URL: ${raw}`);
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Never send the bearer token over plain HTTP except to a local mock server.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new BevelConfigError("BEVEL_BASE_URL must use https:// (http:// is allowed only for localhost)");
  }
  return url.origin;
}

/** Where `bevel-mcp token capture` / `token set` save the token on macOS; read by default there. */
export const DEFAULT_MACOS_TOKEN_COMMAND = "/usr/bin/security find-generic-password -s bevel-mcp -a token -w";

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  defaultTimeZone: string = systemTimeZone(),
): BevelConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BevelConfigError(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;

  let token: TokenSourceConfig | undefined;
  if (e.BEVEL_TOKEN) token = { kind: "env", variable: "BEVEL_TOKEN", value: e.BEVEL_TOKEN };
  else if (e.BEVEL_TOKEN_FILE) token = { kind: "file", path: e.BEVEL_TOKEN_FILE };
  else if (e.BEVEL_TOKEN_COMMAND) token = { kind: "command", command: e.BEVEL_TOKEN_COMMAND };
  else if (platform === "darwin") token = { kind: "command", command: DEFAULT_MACOS_TOKEN_COMMAND };

  const timeZone = e.BEVEL_TIMEZONE ?? defaultTimeZone;
  assertValidTimeZone(timeZone);

  return {
    baseUrl: validateBaseUrl(e.BEVEL_BASE_URL ?? DEFAULT_BASE_URL),
    appVersion: e.BEVEL_APP_VERSION ?? DEFAULT_APP_VERSION,
    userAgent: e.BEVEL_USER_AGENT ?? `${SERVER_NAME}/${SERVER_VERSION}`,
    timeZone,
    enableWrites: e.BEVEL_ENABLE_WRITES,
    logLevel: e.BEVEL_LOG_LEVEL ?? "info",
    cacheSeconds: e.BEVEL_CACHE_SECONDS ?? 60,
    token,
  };
}
