import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FitnessApi } from "../api/fitness.js";
import type { GoalsApi } from "../api/goals.js";
import type { JournalApi } from "../api/journal.js";
import type { NutritionApi } from "../api/nutrition.js";
import type { TokenProvider } from "../auth/tokenProvider.js";
import type { BevelConfig } from "../config.js";
import {
  BevelAuthError,
  BevelError,
  BevelHttpError,
  BevelNetworkError,
  BevelPushError,
  BevelSchemaError,
  BevelWritesDisabledError,
} from "../http/errors.js";
import { redact, redactString, type Logger } from "../log.js";

export interface ToolDeps {
  config: BevelConfig;
  tokenProvider: TokenProvider | undefined;
  journal: JournalApi;
  goals: GoalsApi;
  nutrition: NutritionApi;
  fitness: FitnessApi;
  logger: Logger;
  /** Unix ms with fractional precision. */
  now: () => number;
  newUuid: () => string;
}

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(redact(value), null, 2) }] };
}

export function errorResult(message: string, details?: unknown): CallToolResult {
  const text = details === undefined ? message : `${message}\n\n${JSON.stringify(redact(details), null, 2)}`;
  return { isError: true, content: [{ type: "text", text: redactString(text) }] };
}

export function describeError(error: unknown): { message: string; details?: unknown } {
  if (error instanceof BevelPushError) {
    return { message: error.message, details: { failures: error.failures, response: error.response } };
  }
  if (error instanceof BevelSchemaError) {
    return { message: error.message, details: { path: error.path, rawSnippet: snippet(error.raw) } };
  }
  if (error instanceof BevelHttpError) {
    return { message: error.message, details: { status: error.status } };
  }
  if (error instanceof BevelNetworkError) {
    return { message: error.message, details: { outcomeUnknown: error.outcomeUnknown } };
  }
  if (error instanceof BevelAuthError || error instanceof BevelError) {
    return { message: error.message };
  }
  if (error instanceof Error) return { message: `${error.name}: ${error.message}` };
  return { message: String(error) };
}

/** Wraps a tool body so thrown errors become MCP error results instead of protocol errors. */
export function safeHandler<A>(
  name: string,
  logger: Logger,
  body: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await body(args);
    } catch (error) {
      const { message, details } = describeError(error);
      logger.error(`Tool ${name} failed`, { error: message });
      return errorResult(message, details);
    }
  };
}

/** Top-level keys and array sizes of an unknown JSON value, to make raw pull output scannable. */
export function shapeSummary(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        Array.isArray(inner) ? `array(${inner.length})` : inner === null ? "null" : typeof inner,
      ]),
    );
  }
  return typeof value;
}

function snippet(value: unknown, limit = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(redact(value)) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Every write tool calls this first: dry runs are always allowed, real writes need BEVEL_ENABLE_WRITES. */
export function requireWrites(config: BevelConfig, dryRun: boolean | undefined): void {
  if (dryRun || config.enableWrites) return;
  throw new BevelWritesDisabledError(
    "Writes are disabled. Set BEVEL_ENABLE_WRITES=true in the MCP server's environment to allow this tool to write to Bevel.",
  );
}
