import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FitnessApi } from "./api/fitness.js";
import { GoalsApi } from "./api/goals.js";
import { JournalApi } from "./api/journal.js";
import { NutritionApi } from "./api/nutrition.js";
import { createTokenProvider, type TokenProvider } from "./auth/tokenProvider.js";
import type { BevelConfig } from "./config.js";
import { BevelHttpClient, type FetchLike } from "./http/client.js";
import { Logger } from "./log.js";
import { nowMs } from "./time.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerFitnessTools } from "./tools/fitness.js";
import { registerGoalTools } from "./tools/goals.js";
import { registerJournalTools } from "./tools/journal.js";
import { registerNutritionTools } from "./tools/nutrition.js";
import type { ToolDeps } from "./tools/shared.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const INSTRUCTIONS = `Personal client for Bevel Health's private, undocumented API (reverse-engineered; may break without notice).
- Start with bevel_auth_status to check the token (Bevel tokens last 60 days).
- Every write tool supports dryRun and needs BEVEL_ENABLE_WRITES=true for real writes; prefer a dry run first.
- Journal: bevel_get_journal / bevel_set_journal_boolean / bevel_clear_journal_boolean work on one entry per factor per day.
- Meals: bevel_search_food, then bevel_log_food with an fdbId; Bevel files foods into meals by time.
- Goals: bevel_get_macro_goals / bevel_set_macro_goals. Workouts: bevel_get_workout_data, bevel_save_routine,
  bevel_delete_routine, bevel_create_custom_exercise. Completed workouts cannot be logged yet.`;

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerAuthTools(server, deps);
  registerJournalTools(server, deps);
  registerGoalTools(server, deps);
  registerNutritionTools(server, deps);
  registerFitnessTools(server, deps);
  return server;
}

/** Wires the real dependencies from configuration. `fetch` is injectable for tests. */
export function buildDeps(
  config: BevelConfig,
  overrides: { fetch?: FetchLike; logger?: Logger; tokenProvider?: TokenProvider } = {},
): ToolDeps {
  const logger = overrides.logger ?? new Logger(config.logLevel);
  const tokenProvider = overrides.tokenProvider ?? createTokenProvider(config.token);
  const http = new BevelHttpClient({
    baseUrl: config.baseUrl,
    appVersion: config.appVersion,
    userAgent: config.userAgent,
    tokenProvider,
    logger,
    cacheTtlMs: config.cacheSeconds * 1000,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  return {
    config,
    tokenProvider,
    journal: new JournalApi(http),
    goals: new GoalsApi(http),
    nutrition: new NutritionApi(http),
    fitness: new FitnessApi(http),
    logger,
    now: nowMs,
    // Bevel's iOS client is Swift, whose UUID().uuidString is uppercase.
    newUuid: () => randomUUID().toUpperCase(),
  };
}
