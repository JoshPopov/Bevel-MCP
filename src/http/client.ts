/**
 * The single place that talks HTTP to the Bevel API. Every request goes through `request()`,
 * which attaches auth and the observed client headers and applies retry/redaction policy.
 *
 * Retry policy:
 *  - GET: retried on network errors, 429 and 5xx (idempotent reads).
 *  - POST: never retried automatically. A lost response leaves the outcome unknown, and a blind
 *    retry could duplicate an entry. The caller gets a BevelNetworkError with outcomeUnknown=true.
 *  - 401/403 (any method): the token is re-read once and the request repeated. A rejected token
 *    means the server did not process the request, so repeating it cannot duplicate data.
 */
import { randomUUID } from "node:crypto";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { Logger } from "../log.js";
import {
  BevelAuthError,
  BevelHttpError,
  BevelNetworkError,
  appVersionHint,
  bodySnippet,
} from "./errors.js";

export type HttpMethod = "GET" | "POST";
export type QueryValue = string | number | boolean | undefined;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BevelHttpClientOptions {
  baseUrl: string;
  appVersion: string;
  userAgent: string;
  tokenProvider: TokenProvider | undefined;
  logger: Logger;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxGetRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Reuse successful GET responses for this long (ms). 0 disables. Default 0. */
  cacheTtlMs?: number;
  clock?: () => number;
}

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Skip the read cache (used by every lookup that precedes a write). */
  fresh?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BevelHttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxGetRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private cacheGeneration = 0;
  private pushesInFlight = 0;

  constructor(private readonly options: BevelHttpClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxGetRetries = options.maxGetRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get hasToken(): boolean {
    return this.options.tokenProvider !== undefined;
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Drops every cached read. Called automatically after any write (/push) request. */
  clearCache(): void {
    this.cacheGeneration++;
    this.cache.clear();
  }

  async request<T = unknown>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const ttl = this.options.cacheTtlMs ?? 0;
    const now = this.options.clock ?? Date.now;
    if (method === "POST" && path.endsWith("/push")) {
      this.pushesInFlight++;
      this.clearCache();
      try {
        return await this.send<T>(method, path, opts);
      } finally {
        this.clearCache();
        this.pushesInFlight--;
      }
    }
    const generation = this.cacheGeneration;
    const cacheKey =
      method === "GET" && ttl > 0 && this.pushesInFlight === 0 ? this.buildUrl(path, opts.query) : undefined;
    if (cacheKey && !opts.fresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && now() - hit.at < ttl) return structuredClone(hit.value) as T;
    }
    const value = await this.send<T>(method, path, opts);
    if (cacheKey && generation === this.cacheGeneration) {
      this.cache.set(cacheKey, { at: now(), value: structuredClone(value) });
    }
    return value;
  }

  private async send<T>(method: HttpMethod, path: string, opts: RequestOptions): Promise<T> {
    const provider = this.options.tokenProvider;
    if (!provider) {
      throw new BevelAuthError(
        "No Bevel token configured. Set BEVEL_TOKEN_COMMAND, BEVEL_TOKEN_FILE or BEVEL_TOKEN (see README).",
      );
    }
    const { logger } = this.options;
    const url = this.buildUrl(path, opts.query);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    let attempt = 0;
    let reauthenticated = false;

    for (;;) {
      const token = await provider.getToken();
      // Mirrors the app: JSON Accept on reads, */* on writes, and a fresh uppercase request-id per request.
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: method === "GET" ? "application/json" : "*/*",
        "bevel-app-version": this.options.appVersion,
        "User-Agent": this.options.userAgent,
        "request-id": randomUUID().toUpperCase(),
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (method === "GET" && attempt < this.maxGetRetries) {
          attempt += 1;
          logger.warn("Network error, retrying GET", { path, attempt, reason });
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        logger.error("Network error", { method, path, reason });
        const outcomeUnknown = method !== "GET";
        throw new BevelNetworkError(
          outcomeUnknown
            ? `Network error during ${method} ${path} (${reason}). The server may or may not have applied the change; verify before retrying.`
            : `Network error during ${method} ${path} (${reason}).`,
          method,
          path,
          outcomeUnknown,
        );
      }

      logger.debug("HTTP response", { method, path, status: response.status, ms: Date.now() - started });

      if (response.status === 401 || response.status === 403) {
        const text = await safeText(response);
        if (!reauthenticated) {
          reauthenticated = true;
          provider.invalidate();
          logger.warn("Auth rejected, re-reading token once", { path, status: response.status });
          continue;
        }
        const versionHint = appVersionHint(response.status, text, this.options.appVersion);
        throw new BevelAuthError(
          (versionHint
            ? `Bevel rejected the request (HTTP ${response.status}).${versionHint}`
            : `Bevel rejected the token (HTTP ${response.status}). It has probably expired or been revoked: run ` +
              `\`bevel-mcp token capture\` (token source: ${provider.source}).`) +
            (text ? ` Server said: ${bodySnippet(text)}` : ""),
          response.status,
        );
      }

      if (method === "GET" && (response.status === 429 || response.status >= 500) && attempt < this.maxGetRetries) {
        await safeText(response);
        attempt += 1;
        const delay = retryAfterMs(response) ?? this.backoffMs(attempt);
        logger.warn("Retryable HTTP status, retrying GET", { path, status: response.status, attempt, delay });
        await this.sleep(delay);
        continue;
      }

      const text = await safeText(response);
      if (!response.ok) {
        throw new BevelHttpError(
          `Bevel API returned HTTP ${response.status} for ${method} ${path}` +
            (text ? `: ${bodySnippet(text)}` : "") +
            appVersionHint(response.status, text, this.options.appVersion),
          response.status,
          method,
          path,
          text ? bodySnippet(text) : undefined,
        );
      }
      if (logger.enabled("debug")) logger.debug("HTTP response body", { path, body: bodySnippet(text) });
      if (text.trim() === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BevelHttpError(
          `Expected JSON from ${method} ${path} but got: ${bodySnippet(text)}`,
          response.status,
          method,
          path,
          bodySnippet(text),
        );
      }
    }
  }

  private backoffMs(attempt: number): number {
    const base = this.retryBaseDelayMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * this.retryBaseDelayMs);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  return undefined;
}
