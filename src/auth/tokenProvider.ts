/**
 * Authentication abstraction. The HTTP client only ever asks a TokenProvider for a bearer token,
 * so a refreshing provider (e.g. Firebase securetoken, once the auth flow is understood) can be
 * dropped in later without touching the API layer.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { DEFAULT_MACOS_TOKEN_COMMAND, type TokenSourceConfig } from "../config.js";
import { BevelAuthError } from "../http/errors.js";
import { redactString } from "../log.js";

export interface TokenProvider {
  /** Short, non-secret description of where the token comes from. */
  readonly source: string;
  getToken(): Promise<string>;
  /** Drop any cached token so the next getToken() reads it again (called after a 401/403). */
  invalidate(): void;
}

/** Accepts "eyJ...", "Bearer eyJ...", or a quoted value, and returns the bare token. */
export function normalizeToken(raw: string): string {
  let token = raw.trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new BevelAuthError("The configured token source returned an empty value");
  if (/\s/.test(token)) throw new BevelAuthError("The configured token contains whitespace; expected a single JWT");
  return token;
}

abstract class CachingTokenProvider implements TokenProvider {
  abstract readonly source: string;
  private cached: string | undefined;
  private pending: Promise<string> | undefined;

  protected abstract load(): Promise<string>;

  async getToken(): Promise<string> {
    if (this.cached) return this.cached;
    this.pending ??= this.load()
      .then((raw) => {
        this.cached = normalizeToken(raw);
        return this.cached;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export class StaticTokenProvider extends CachingTokenProvider {
  constructor(
    private readonly value: string,
    readonly source = "environment variable BEVEL_TOKEN",
  ) {
    super();
  }
  protected async load(): Promise<string> {
    return this.value;
  }
}

export class FileTokenProvider extends CachingTokenProvider {
  readonly source: string;
  constructor(private readonly path: string) {
    super();
    this.source = `file ${path} (BEVEL_TOKEN_FILE)`;
  }
  protected async load(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new BevelAuthError(`Could not read BEVEL_TOKEN_FILE (${code})`);
    }
  }
}

export class CommandTokenProvider extends CachingTokenProvider {
  readonly source: string;
  constructor(
    private readonly command: string,
    private readonly timeoutMs = 15_000,
    private readonly label = "BEVEL_TOKEN_COMMAND",
    private readonly hint = "",
  ) {
    super();
    this.source = label === "BEVEL_TOKEN_COMMAND" ? "command output (BEVEL_TOKEN_COMMAND)" : label;
  }
  protected load(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", this.command],
        { timeout: this.timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            // Never include stdout: on partial failure it could hold the secret.
            const detail = redactString(String(stderr).trim()).slice(0, 300);
            reject(
              new BevelAuthError(
                `${this.label} failed (${error.code ?? error.signal ?? "error"})${detail ? `: ${detail}` : ""}${this.hint}`,
              ),
            );
            return;
          }
          resolve(String(stdout));
        },
      );
    });
  }
}

export function createTokenProvider(config: TokenSourceConfig | undefined): TokenProvider | undefined {
  if (!config) return undefined;
  switch (config.kind) {
    case "env":
      return new StaticTokenProvider(config.value);
    case "file":
      return new FileTokenProvider(config.path);
    case "command":
      return config.command === DEFAULT_MACOS_TOKEN_COMMAND
        ? new CommandTokenProvider(
            config.command,
            15_000,
            "macOS Keychain item bevel-mcp/token",
            ". Run `bevel-mcp token capture` (or `bevel-mcp token set`) to store your token.",
          )
        : new CommandTokenProvider(config.command);
  }
}
