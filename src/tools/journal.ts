import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  JOURNAL_PATHS,
  JOURNAL_PULL_PAGE_SIZE,
  VERIFIED_BOOLEAN_FACTOR_KEYS,
  buildBooleanJournalClear,
  buildBooleanJournalEntry,
  buildBooleanJournalUpdate,
  buildJournalPushRequest,
  findBooleanEntries,
  parseBooleanEntries,
} from "../api/journal.js";
import type { BooleanJournalEntry, PulledBooleanJournal } from "../api/types.js";
import { BevelError, BevelNetworkError } from "../http/errors.js";
import { dayToIdentifyingDate, describeTimestamp, localDayOf, parseDay, todayInTimeZone } from "../time.js";
import { describeError, errorResult, jsonResult, requireWrites, safeHandler, type ToolDeps } from "./shared.js";

const DAY_MS = 86_400_000;
/**
 * When looking up the entry for a day, pull only records changed since (day − this window).
 * An entry for day D is created on or after D and only updated later, so its last change cannot
 * predate D; the window is generous slack for clock skew and time-zone travel.
 */
const LOOKUP_WINDOW_MS = 30 * DAY_MS;
const LOOKUP_MAX_PAGES = 50;
const MAX_LISTED_ENTRIES = 500;

const verifiedKeyList = Object.entries(VERIFIED_BOOLEAN_FACTOR_KEYS)
  .map(([key, label]) => `${key} (${label})`)
  .join(", ");

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const getJournalInputSchema = {
  date: dayString.optional().describe("Only list Boolean entries for this local day (YYYY-MM-DD)."),
  factorKey: z.string().optional().describe("Only list Boolean entries for this preset factor key."),
  lastSyncDate: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Unix ms. Only records changed after this instant are returned. Default 0 = full history."),
  limit: z.number().int().min(1).max(500).optional().describe(`Page size (default ${JOURNAL_PULL_PAGE_SIZE}, as the app uses).`),
  maxPages: z.number().int().min(1).max(200).optional().describe("Maximum pages to fetch (default 20)."),
};

export const setJournalBooleanInputSchema = {
  factorKey: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "factor keys are camelCase identifiers like addedSugar")
    .describe(`Bevel preset factor key. Verified keys: ${verifiedKeyList}.`),
  value: z.boolean().describe("true = the factor applied that day, false = it did not."),
  date: dayString.optional().describe("Calendar day YYYY-MM-DD in the configured time zone. Defaults to today."),
  dryRun: z
    .boolean()
    .optional()
    .describe("If true, look up the existing entry and return the exact request that would be sent, without sending it."),
  allowUnverifiedFactorKey: z
    .boolean()
    .optional()
    .describe(
      "Required to write a factor key other than the verified ones. Only use keys actually seen in bevel_get_journal output.",
    ),
};

export const clearJournalBooleanInputSchema = {
  factorKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Preset factor key of the entry to clear."),
  date: dayString.optional().describe("Calendar day YYYY-MM-DD in the configured time zone. Defaults to today."),
  dryRun: z.boolean().optional().describe("If true, return the exact request that would be sent without sending it."),
};

function summarizeEntry(entry: PulledBooleanJournal, timeZone: string) {
  return {
    day: localDayOf(entry.identifyingDate, timeZone),
    factorKey: entry.presetFactorKey,
    ...(VERIFIED_BOOLEAN_FACTOR_KEYS[entry.presetFactorKey]
      ? { factorLabel: VERIFIED_BOOLEAN_FACTOR_KEYS[entry.presetFactorKey] }
      : {}),
    // A cleared factor (isNotSet) has no value.
    value: entry.isNotSet ? null : (entry.boolValue ?? null),
    ...(entry.isNotSet ? { cleared: true } : {}),
    uuid: entry.uuid,
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };
}

export function registerJournalTools(server: McpServer, deps: ToolDeps): void {
  const { journal, logger } = deps;
  const pendingWrites = new Map<string, Promise<void>>();

  async function withDayWrite(day: string, factor: string, run: () => Promise<CallToolResult>) {
    const key = JSON.stringify([day, factor]);
    const result = (pendingWrites.get(key) ?? Promise.resolve()).then(run);
    const done = result.then(() => {}, () => {});
    pendingWrites.set(key, done);
    try {
      return await result;
    } finally {
      if (pendingWrites.get(key) === done) pendingWrites.delete(key);
    }
  }

  server.registerTool(
    "bevel_get_journal",
    {
      title: "Get Bevel Journal data",
      description:
        `Pulls Journal data via GET ${JOURNAL_PATHS.pull}, following pagination. ` +
        "Boolean entries are returned as {day, factorKey, value, ...}, optionally filtered by date and factor; " +
        "value is null and cleared is true for a factor that was cleared in the app. " +
        "Other collections (defaults) are returned raw because their schema has not been captured yet.",
      inputSchema: getJournalInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_journal", logger, async (args) => {
      const { timeZone } = deps.config;
      if (args.date) parseDay(args.date);
      const query = {
        lastSyncDate: args.lastSyncDate ?? 0,
        limit: args.limit ?? JOURNAL_PULL_PAGE_SIZE,
        maxPages: args.maxPages ?? 20,
      };
      const result = await journal.pullJournal(query);
      const { entries, unparsed } = parseBooleanEntries(result.journalData.booleanJournals);
      const matching = entries
        .filter((e) => !args.factorKey || e.presetFactorKey === args.factorKey)
        .filter((e) => !args.date || localDayOf(e.identifyingDate, timeZone) === args.date)
        .sort((a, b) => b.identifyingDate - a.identifyingDate || a.presetFactorKey.localeCompare(b.presetFactorKey));

      const otherCollections = Object.fromEntries(
        Object.entries(result.journalData).filter(([key, items]) => key !== "booleanJournals" && items.length > 0),
      );
      return jsonResult({
        query: { ...query, ...(args.date ? { date: args.date } : {}), ...(args.factorKey ? { factorKey: args.factorKey } : {}) },
        timeZone,
        pagesFetched: result.pagesFetched,
        ...(result.truncated ? { truncated: true, note: "More data is available: raise maxPages or set lastSyncDate." } : {}),
        counts: Object.fromEntries(Object.entries(result.journalData).map(([key, items]) => [key, items.length])),
        booleanJournals: matching.slice(0, MAX_LISTED_ENTRIES).map((e) => summarizeEntry(e, timeZone)),
        ...(matching.length > MAX_LISTED_ENTRIES ? { omittedEntries: matching.length - MAX_LISTED_ENTRIES } : {}),
        ...(unparsed.length > 0
          ? { unparsedBooleanJournals: unparsed.slice(0, 5), unparsedCount: unparsed.length }
          : {}),
        ...(Object.keys(otherCollections).length > 0 ? { otherCollections } : {}),
        ...(Object.keys(result.unknownCollections).length > 0
          ? {
              unknownCollections: result.unknownCollections,
              unknownCollectionsNote: "These keys are new to this client; please share them so they can be supported.",
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "bevel_get_custom_journal_types",
    {
      title: "Get Bevel custom Journal types",
      description: `Pulls custom Journal types via GET ${JOURNAL_PATHS.customTypesPull}, following pagination. Items are raw (schema not captured yet).`,
      inputSchema: {
        lastSyncDate: getJournalInputSchema.lastSyncDate,
        maxPages: getJournalInputSchema.maxPages,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_custom_journal_types", logger, async (args) => {
      const result = await journal.pullCustomJournalTypes({
        lastSyncDate: args.lastSyncDate ?? 0,
        limit: JOURNAL_PULL_PAGE_SIZE,
        maxPages: args.maxPages ?? 20,
      });
      return jsonResult(result);
    }),
  );

  server.registerTool(
    "bevel_set_journal_boolean",
    {
      title: "Set a Boolean Journal factor",
      description:
        "Sets a yes/no Journal factor (e.g. Added Sugar) for one day, the way the app does: if an entry for that factor " +
        "and day exists it is updated in place (same uuid and createdAt), otherwise a new entry is created. " +
        "Does nothing if the value is already set. Requires BEVEL_ENABLE_WRITES=true unless dryRun is set. " +
        "Success means Bevel listed the entry's uuid as succeeded; confirm it in the app after restarting it.",
      inputSchema: setJournalBooleanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_set_journal_boolean", logger, async (args) => {
      const { config } = deps;
      const keyError = checkFactorKey(args.factorKey, args.allowUnverifiedFactorKey);
      if (keyError) return keyError;
      requireWrites(config, args.dryRun);
      const target = resolveDay(args.date, config.timeZone);
      if ("error" in target) return target.error;

      return withDayWrite(target.day, args.factorKey, async () => {
        const lookup = await lookupDayEntry(deps, args.factorKey, target.day);
        if ("error" in lookup) return lookup.error;
        const { existing } = lookup;
        const context = {
          factorKey: args.factorKey,
          factorLabel: VERIFIED_BOOLEAN_FACTOR_KEYS[args.factorKey] ?? "(unverified key)",
          value: args.value,
          ...lookup.context,
          ...(Object.hasOwn(VERIFIED_BOOLEAN_FACTOR_KEYS, args.factorKey)
            ? {}
            : { unverifiedKey: "Confirm the entry shows up correctly in the app." }),
        };

        if (existing && existing.boolValue === args.value && !existing.isNotSet) {
          return jsonResult({ action: "unchanged", written: false, ...context });
        }

        const now = deps.now();
        const entry = existing
          ? buildBooleanJournalUpdate(existing, args.value, now)
          : buildBooleanJournalEntry({
              uuid: deps.newUuid(),
              factorKey: args.factorKey,
              value: args.value,
              identifyingDate: target.identifyingDate,
              now,
            });
        return pushEntry(deps, entry, existing ? "updated" : "created", context, args.dryRun);
      });
    }),
  );

  server.registerTool(
    "bevel_clear_journal_boolean",
    {
      title: "Clear a Boolean Journal factor",
      description:
        "Clears a yes/no Journal factor for one day, so it shows as not answered — exactly what the app sends: the same " +
        "entry with isNotSet: true and no boolValue. Does nothing if there is no entry or it is already cleared. " +
        "Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: clearJournalBooleanInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_clear_journal_boolean", logger, async (args) => {
      const { config } = deps;
      requireWrites(config, args.dryRun);
      const target = resolveDay(args.date, config.timeZone);
      if ("error" in target) return target.error;

      return withDayWrite(target.day, args.factorKey, async () => {
        const lookup = await lookupDayEntry(deps, args.factorKey, target.day);
        if ("error" in lookup) return lookup.error;
        const { existing } = lookup;
        const context = { factorKey: args.factorKey, ...lookup.context };

        if (!existing) return jsonResult({ action: "nothing_to_clear", written: false, ...context });
        if (existing.isNotSet) return jsonResult({ action: "unchanged", written: false, ...context });
        return pushEntry(deps, buildBooleanJournalClear(existing, deps.now()), "cleared", context, args.dryRun);
      });
    }),
  );
}

function checkFactorKey(factorKey: string, allowUnverified: boolean | undefined): CallToolResult | undefined {
  if (Object.hasOwn(VERIFIED_BOOLEAN_FACTOR_KEYS, factorKey) || allowUnverified) return undefined;
  return errorResult(
    `"${factorKey}" is not a known factor key (known: ${verifiedKeyList}). ` +
      "If you have seen this key in bevel_get_journal output, call again with allowUnverifiedFactorKey: true.",
  );
}

function resolveDay(
  date: string | undefined,
  timeZone: string,
): { day: string; identifyingDate: number } | { error: CallToolResult } {
  const day = date ?? todayInTimeZone(timeZone, Date.now());
  try {
    return { day, identifyingDate: dayToIdentifyingDate(day, timeZone) };
  } catch (error) {
    return { error: errorResult(describeError(error).message) };
  }
}

/**
 * Finds the entry for a factor on a local day, as the app would (one entry per factor per day).
 * Pulls changes since (day − LOOKUP_WINDOW_MS) and refuses to proceed if the lookup is incomplete
 * or contains entries it cannot parse, so a write can never create a duplicate by guesswork.
 */
async function lookupDayEntry(
  deps: ToolDeps,
  factorKey: string,
  day: string,
): Promise<
  | { existing: PulledBooleanJournal | undefined; context: Record<string, unknown> }
  | { error: CallToolResult }
> {
  const { config, journal } = deps;
  const identifyingDate = dayToIdentifyingDate(day, config.timeZone);
  const lookup = await journal.pullJournal({
    fresh: true,
    lastSyncDate: Math.max(0, identifyingDate - LOOKUP_WINDOW_MS),
    limit: JOURNAL_PULL_PAGE_SIZE,
    maxPages: LOOKUP_MAX_PAGES,
  });
  if (lookup.truncated) {
    throw new BevelError(
      "Could not read all recent Journal data to check for an existing entry, so nothing was written (to avoid a duplicate).",
    );
  }
  const { entries, unparsed } = parseBooleanEntries(lookup.journalData.booleanJournals);
  if (unparsed.length > 0) {
    return {
      error: errorResult(
        "Pulled Journal entries have a shape this client does not recognise, so it cannot safely tell whether an entry " +
          "already exists. Nothing was written. Please share this (token-free) sample so the parser can be updated.",
        { sample: unparsed.slice(0, 2), unparsedCount: unparsed.length },
      ),
    };
  }
  const matches = findBooleanEntries(entries, factorKey, day, config.timeZone);
  const existing = matches[0];
  return {
    existing,
    context: {
      day,
      timeZone: config.timeZone,
      ...(existing ? { existing: summarizeEntry(existing, config.timeZone) } : {}),
      ...(matches.length > 1
        ? { warning: `Found ${matches.length} entries for this factor and day; using the most recent one.` }
        : {}),
    },
  };
}

/** Dry-run output, or push + verify the uuid is in `succeeded`. Never retried automatically. */
async function pushEntry(
  deps: ToolDeps,
  entry: BooleanJournalEntry,
  action: "created" | "updated" | "cleared",
  context: Record<string, unknown>,
  dryRun: boolean | undefined,
): Promise<CallToolResult> {
  const { config, journal, logger } = deps;
  const body = buildJournalPushRequest({ booleanJournals: [entry] });
  const details = {
    action,
    uuid: entry.uuid,
    ...context,
    identifyingDate: { ms: entry.identifyingDate, ...describeTimestamp(entry.identifyingDate, config.timeZone) },
  };
  if (dryRun) {
    return jsonResult({
      dryRun: true,
      writesEnabled: config.enableWrites,
      ...details,
      request: { method: "POST", path: JOURNAL_PATHS.push, body },
    });
  }
  try {
    const response = await journal.pushJournalData(body);
    logger.info("Boolean Journal entry written", { action, uuid: entry.uuid, factorKey: entry.presetFactorKey });
    return jsonResult({
      written: true,
      ...details,
      server: response.booleanJournals,
      nextStep: "Force-quit and reopen Bevel, then check the Journal for this day.",
    });
  } catch (error) {
    const { message, details: errorDetails } = describeError(error);
    const unknownOutcome = error instanceof BevelNetworkError && error.outcomeUnknown;
    return errorResult(
      unknownOutcome
        ? `${message} Re-running this tool is safe: it will find the entry if the write landed instead of duplicating it.`
        : message,
      { ...details, ...(errorDetails && typeof errorDetails === "object" ? errorDetails : {}) },
    );
  }
}
