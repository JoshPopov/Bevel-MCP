/**
 * Structured stderr logger with credential redaction.
 *
 * stdout carries the MCP stdio protocol, so nothing may ever be written there.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export const REDACTED = "<redacted>";

/** Three base64url segments where the first two start with `{"` (encoded as `eyJ`). */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie/i;

export function redactString(input: string): string {
  return input.replace(BEARER_PATTERN, `$1${REDACTED}`).replace(JWT_PATTERN, REDACTED);
}

/** Deep-copies `value`, masking sensitive keys and any token-shaped strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 25) return "[max depth]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

export type LogSink = (line: string) => void;

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly sink: LogSink = (line) => process.stderr.write(`${line}\n`),
  ) {}

  enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redactString(message),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    this.sink(JSON.stringify(record));
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }
  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }
}

/** A logger that discards everything (tests). */
export const silentLogger = new Logger("error", () => {});
