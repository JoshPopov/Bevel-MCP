import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  buildFoodLog,
  headline,
  scaleNutrients,
  toLoggedFood,
  type FoodLog,
  type SearchFood,
} from "../api/foodMapping.js";
import {
  FOOD_PULL_PAGE_SIZE,
  NUTRITION_PATHS,
  PulledFoodLogSchema,
  buildFoodLogEdit,
  logNutrients,
  pulledLogNutrients,
  type PulledFoodLog,
} from "../api/nutrition.js";
import { parseItems } from "../api/pull.js";
import { BevelNetworkError } from "../http/errors.js";
import {
  localDayOf,
  localTimeOf,
  parseDay,
  parseTimeOfDay,
  todayInTimeZone,
  zonedTimeToUtcMs,
} from "../time.js";
import { describeError, errorResult, jsonResult, requireWrites, safeHandler, type ToolDeps } from "./shared.js";

const DAY_MS = 86_400_000;
/** A log for day D cannot have last changed before D; 30 days is generous slack (as for the Journal). */
const LOOKUP_WINDOW_MS = 30 * DAY_MS;
const LOOKUP_MAX_PAGES = 50;

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24-hour)");

function servingGrams(serving: SearchFood["servingOptions"][number]): number | undefined {
  const p = serving.portion;
  return p.standardUnit === "g" && typeof p.standardUnitAmount === "number" ? p.standardUnitAmount : undefined;
}

function summarizeSearchFood(food: SearchFood) {
  return {
    fdbId: food.fdbId,
    name: food.foodName,
    ...(food.brandName ? { brand: food.brandName } : {}),
    defaultServing: { servingId: food.defaultServing.fdbServingId, label: food.defaultServing.portion.portionDisplayName },
    perDefaultServing: headline(scaleNutrients(food.defaultServing.nutrients, 1)),
    servingOptions: food.servingOptions.map((s) => ({
      servingId: s.fdbServingId,
      label: s.portion.portionDisplayName,
      ...(servingGrams(s) !== undefined ? { grams: servingGrams(s) } : {}),
    })),
  };
}

function summarizeLog(log: PulledFoodLog, timeZone: string) {
  const entry = log.compoundFood.foods[0];
  return {
    id: log.id,
    day: localDayOf(log.loggedAt, timeZone),
    time: localTimeOf(log.loggedAt, timeZone),
    title: log.title,
    servings: log.numServings,
    ...(entry ? { servingLabel: entry.servingDefinition.portion.portionDisplayName } : {}),
    ...(log.compoundFood.foods.length > 1 ? { components: log.compoundFood.foods.length } : {}),
    ...(log.compoundFood.customFoods.length ? { customFoods: log.compoundFood.customFoods.length } : {}),
    nutrients: headline(pulledLogNutrients(log)),
    ...(log.deletedAt ? { deleted: true } : {}),
  };
}

/** The pulled food logs whose loggedAt falls on `day`, or an error result if they can't be trusted. */
async function logsForDay(
  deps: ToolDeps,
  day: string,
  options: { forWrite: boolean },
): Promise<{ logs: PulledFoodLog[]; unparsed: unknown[]; truncated: boolean } | { error: CallToolResult }> {
  const { timeZone } = deps.config;
  const dayStart = zonedTimeToUtcMs(parseDay(day), 0, 0, timeZone);
  const pulled = await deps.nutrition.pullFoodLogs({
    fresh: options.forWrite,
    lastSyncDate: Math.max(0, dayStart - LOOKUP_WINDOW_MS),
    limit: FOOD_PULL_PAGE_SIZE,
    maxPages: LOOKUP_MAX_PAGES,
  });
  const { items, unparsed } = parseItems(PulledFoodLogSchema, pulled.foodLogs);
  if (options.forWrite && (pulled.truncated || unparsed.length > 0)) {
    return {
      error: errorResult(
        pulled.truncated
          ? "Could not read all recent food logs, so nothing was written."
          : "Pulled food logs have a shape this client does not recognise, so it cannot safely edit them. Nothing was written. " +
              "Please share this (token-free) sample so the parser can be updated.",
        unparsed.length ? { sample: unparsed.slice(0, 1), unparsedCount: unparsed.length } : undefined,
      ),
    };
  }
  const logs = items.filter((log) => localDayOf(log.loggedAt, timeZone) === day);
  return { logs, unparsed, truncated: pulled.truncated };
}

/** A dry-run friendly copy of a food log: bulky per-food arrays are replaced by counts. */
function abbreviate(log: FoodLog): unknown {
  const copy = JSON.parse(JSON.stringify(log)) as Record<string, any>;
  for (const component of copy.compoundFood?.components ?? []) {
    const food = component.food;
    if (food?.servingOptions) food.servingOptions = `<${food.servingOptions.length} serving options>`;
    if (food?.defaultServing?.nutrients) food.defaultServing.nutrients = `<${food.defaultServing.nutrients.length} nutrients>`;
    if (component.serving?.nutrients) component.serving.nutrients = `<${component.serving.nutrients.length} nutrients>`;
  }
  return copy;
}

async function pushLog(
  deps: ToolDeps,
  log: FoodLog,
  action: string,
  details: Record<string, unknown>,
  dryRun: boolean | undefined,
): Promise<CallToolResult> {
  const id = log.id;
  if (dryRun) {
    return jsonResult({
      dryRun: true,
      writesEnabled: deps.config.enableWrites,
      action,
      id,
      ...details,
      request: { method: "POST", path: NUTRITION_PATHS.foodPush, foodLog: abbreviate(log) },
    });
  }
  try {
    const response = await deps.nutrition.pushFoodLogs([log]);
    deps.logger.info("Food log written", { action, id });
    return jsonResult({
      written: true,
      action,
      id,
      ...details,
      server: response.foodLogs,
      nextStep: "Force-quit and reopen Bevel, then check Nutrition for this day.",
    });
  } catch (error) {
    const { message, details: errorDetails } = describeError(error);
    const unknownOutcome = error instanceof BevelNetworkError && error.outcomeUnknown;
    return errorResult(
      unknownOutcome ? `${message} Check bevel_get_food_logs for id ${id} before retrying.` : message,
      { action, id, ...details, ...(errorDetails && typeof errorDetails === "object" ? errorDetails : {}) },
    );
  }
}

export function registerNutritionTools(server: McpServer, deps: ToolDeps): void {
  const { logger } = deps;

  server.registerTool(
    "bevel_search_food",
    {
      title: "Search Bevel's food database",
      description:
        "Searches foods the way the app does (generic + branded, 5 each). Returns fdbId, serving options and per-serving " +
        "calories, protein, carbohydrate, fat, fiber, sugar and caffeine. Use an fdbId from here with bevel_log_food.",
      inputSchema: { query: z.string().min(1).max(100).describe("Food name, e.g. 'banana' or 'greek yogurt'.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_search_food", logger, async (args) => {
      const { foods, unparsed } = await deps.nutrition.search(args.query);
      return jsonResult({
        query: args.query,
        results: foods.map(summarizeSearchFood),
        ...(unparsed.length ? { unparsedCount: unparsed.length } : {}),
        note: "Nutrient amounts are as reported by Bevel's food database.",
      });
    }),
  );

  server.registerTool(
    "bevel_log_food",
    {
      title: "Log a food in Bevel",
      description:
        "Logs a food (from bevel_search_food) to the Nutrition log, building the exact entry the app sends. Bevel files a log " +
        "into breakfast/lunch/dinner by its time; there is no separate meal field. Requires BEVEL_ENABLE_WRITES=true unless " +
        "dryRun is set.",
      inputSchema: {
        fdbId: z.string().min(1).describe("fdbId from bevel_search_food."),
        query: z.string().optional().describe("The search query that found it (used to re-fetch the food if needed)."),
        servingId: z.string().optional().describe("servingId from the search result. Defaults to the food's default serving."),
        servings: z.number().positive().max(50).optional().describe("Number of servings (default 1)."),
        date: dayString.optional().describe("Day YYYY-MM-DD in the configured time zone. Defaults to today."),
        time: timeString.optional().describe("Local time HH:MM. Defaults to now (or the current time of day on `date`)."),
        dryRun: z.boolean().optional().describe("If true, return the entry that would be sent without sending it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safeHandler("bevel_log_food", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const { timeZone } = deps.config;
      const food = await deps.nutrition.findFood(args.fdbId, args.query);
      if (!food) {
        return errorResult(
          `Food ${args.fdbId} is not in recent search results. Call bevel_search_food first (or pass the query that found it).`,
        );
      }
      const servingId = args.servingId ?? food.defaultServing.fdbServingId;
      if (!food.servingOptions.some((s) => s.fdbServingId === servingId)) {
        return errorResult(`servingId ${servingId} is not one of this food's serving options.`, summarizeSearchFood(food));
      }

      const now = deps.now();
      let loggedAt = now;
      if (args.date || args.time) {
        const day = args.date ?? todayInTimeZone(timeZone, Date.now());
        const { hour, minute } = parseTimeOfDay(args.time ?? localTimeOf(Date.now(), timeZone));
        loggedAt = zonedTimeToUtcMs(parseDay(day), hour, minute, timeZone);
      }

      const localFoodId = deps.newUuid();
      const log = buildFoodLog({
        food: toLoggedFood(food, localFoodId),
        servingId,
        servings: args.servings ?? 1,
        loggedAt,
        now,
        ids: { log: deps.newUuid(), compoundFood: deps.newUuid(), component: deps.newUuid() },
      });
      return pushLog(
        deps,
        log,
        "logged",
        {
          title: log.title,
          day: localDayOf(loggedAt, timeZone),
          time: localTimeOf(loggedAt, timeZone),
          servings: log.numServings,
          servingLabel: log.compoundFood.components[0]!.serving.portionDefinition.portionDisplayName,
          nutrients: headline(logNutrients(log)),
          ...(food.brandName ? { note: "Branded food: the brand name is not stored on the log (only generic foods have been captured)." } : {}),
        },
        args.dryRun,
      );
    }),
  );

  server.registerTool(
    "bevel_get_food_logs",
    {
      title: "Get Bevel food logs for a day",
      description:
        "Lists the foods logged on a day with time, servings and calories/protein/carbs/fat/fiber/sugar/caffeine, plus day totals.",
      inputSchema: {
        date: dayString.optional().describe("Day YYYY-MM-DD in the configured time zone. Defaults to today."),
        includeDeleted: z.boolean().optional().describe("Also list soft-deleted logs."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_food_logs", logger, async (args) => {
      const { timeZone } = deps.config;
      const day = args.date ?? todayInTimeZone(timeZone, Date.now());
      const result = await logsForDay(deps, day, { forWrite: false });
      if ("error" in result) return result.error;
      const visible = result.logs
        .filter((log) => args.includeDeleted || !log.deletedAt)
        .sort((a, b) => a.loggedAt - b.loggedAt);
      const totals: Record<string, number> = {};
      for (const log of visible) {
        if (log.deletedAt) continue;
        for (const [key, value] of Object.entries(pulledLogNutrients(log))) totals[key] = (totals[key] ?? 0) + value;
      }
      return jsonResult({
        day,
        timeZone,
        logs: visible.map((log) => summarizeLog(log, timeZone)),
        totals: headline(totals),
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.unparsed.length
          ? { unparsedFoodLogs: result.unparsed.slice(0, 1), unparsedCount: result.unparsed.length }
          : {}),
      });
    }),
  );

  const findLog = async (id: string, day: string): Promise<{ log: PulledFoodLog } | { error: CallToolResult }> => {
    const result = await logsForDay(deps, day, { forWrite: true });
    if ("error" in result) return result;
    const log = result.logs.find((l) => l.id.toLowerCase() === id.toLowerCase());
    if (!log) return { error: errorResult(`No food log ${id} on ${day}. Use bevel_get_food_logs to find the id.`) };
    if (log.deletedAt) return { error: errorResult(`Food log ${id} is already deleted.`) };
    return { log };
  };

  server.registerTool(
    "bevel_update_food_log",
    {
      title: "Edit a Bevel food log",
      description:
        "Changes the servings and/or time of a logged food (same entry, as the app does). Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: {
        id: z.string().min(1).describe("Food log id from bevel_get_food_logs."),
        date: dayString.describe("The day the food is logged on (YYYY-MM-DD)."),
        servings: z.number().positive().max(50).optional().describe("New number of servings."),
        time: timeString.optional().describe("New local time HH:MM on the same day."),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_update_food_log", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      if (args.servings === undefined && args.time === undefined) {
        return errorResult("Nothing to change: pass servings and/or time.");
      }
      const lookup = await findLog(args.id, args.date);
      if ("error" in lookup) return lookup.error;
      const found = lookup.log;
      const { timeZone } = deps.config;
      let loggedAt: number | undefined;
      if (args.time !== undefined) {
        const { hour, minute } = parseTimeOfDay(args.time);
        loggedAt = zonedTimeToUtcMs(parseDay(args.date), hour, minute, timeZone);
      }
      let edited: FoodLog;
      try {
        edited = buildFoodLogEdit(
          found,
          { ...(args.servings !== undefined ? { servings: args.servings } : {}), ...(loggedAt !== undefined ? { loggedAt } : {}) },
          deps.now(),
        );
      } catch (error) {
        return errorResult(describeError(error).message);
      }
      return pushLog(
        deps,
        edited,
        "updated",
        {
          title: found.title,
          before: summarizeLog(found, timeZone),
          after: { servings: edited.numServings, time: localTimeOf(Number(edited.loggedAt), timeZone) },
        },
        args.dryRun,
      );
    }),
  );

  server.registerTool(
    "bevel_delete_food_log",
    {
      title: "Delete a Bevel food log",
      description:
        "Deletes a logged food the way the app does (soft delete: deletedAt is set on the same entry). " +
        "Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: {
        id: z.string().min(1).describe("Food log id from bevel_get_food_logs."),
        date: dayString.describe("The day the food is logged on (YYYY-MM-DD)."),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_delete_food_log", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const lookup = await findLog(args.id, args.date);
      if ("error" in lookup) return lookup.error;
      const found = lookup.log;
      let deleted: FoodLog;
      try {
        deleted = buildFoodLogEdit(found, { delete: true }, deps.now());
      } catch (error) {
        return errorResult(describeError(error).message);
      }
      return pushLog(deps, deleted, "deleted", { title: found.title, deleted: summarizeLog(found, deps.config.timeZone) }, args.dryRun);
    }),
  );
}
