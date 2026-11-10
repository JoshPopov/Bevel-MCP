import { redactString } from "../log.js";

export class BevelError extends Error {
  override name = "BevelError";
}

/** Invalid or missing local configuration. */
export class BevelConfigError extends BevelError {
  override name = "BevelConfigError";
}

/** No token, unreadable token, or the API rejected the token (401/403). */
export class BevelAuthError extends BevelError {
  override name = "BevelAuthError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Non-2xx response that is not an auth failure. */
export class BevelHttpError extends BevelError {
  override name = "BevelHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodySnippet?: string,
  ) {
    super(message);
  }
}

/**
 * The request failed before a response arrived (DNS, TLS, reset, timeout).
 * For writes the server may still have applied the change: the outcome is unknown.
 */
export class BevelNetworkError extends BevelError {
  override name = "BevelNetworkError";
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
  }
}

export interface PushFailureDetail {
  collection: string;
  id: string;
  reason: "failed" | "missing";
  serverDetail?: unknown;
}

/** HTTP 200 from a push endpoint, but not every submitted id was reported as succeeded. */
export class BevelPushError extends BevelError {
  override name = "BevelPushError";
  constructor(
    message: string,
    readonly failures: PushFailureDetail[],
    readonly response: unknown,
  ) {
    super(message);
  }
}

/** A write tool was called while BEVEL_ENABLE_WRITES is not "true". */
export class BevelWritesDisabledError extends BevelError {
  override name = "BevelWritesDisabledError";
}

const SNIPPET_LIMIT = 500;

const VERSION_REJECTION = /(app|client)[^.]{0,20}version|update (the|your) app|upgrade required|outdated|minimum (app )?version|force[ _-]?update/i;

/**
 * If Bevel seems to reject the request because of the app version this client claims
 * (bevel-app-version header), a hint on how to fix it; otherwise "". Bevel's exact response for this
 * has not been seen, so this matches HTTP 426 or version/update wording.
 */
export function appVersionHint(status: number, body: string, appVersion: string): string {
  if (status !== 426 && !VERSION_REJECTION.test(body)) return "";
  return (
    ` Bevel may require a newer app version than ${appVersion}: set BEVEL_APP_VERSION to the version shown in the` +
    " Bevel app (Settings › About) and restart the server."
  );
}

export function bodySnippet(text: string): string {
  const cleaned = redactString(text);
  return cleaned.length > SNIPPET_LIMIT ? `${cleaned.slice(0, SNIPPET_LIMIT)}…` : cleaned;
}

/** A 2xx response whose JSON does not match the shape observed in captures. */
export class BevelSchemaError extends BevelError {
  override name = "BevelSchemaError";
  constructor(
    message: string,
    readonly path: string,
    readonly raw: unknown,
  ) {
    super(message);
  }
}
