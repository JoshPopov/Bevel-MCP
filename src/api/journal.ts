/**
 * Journal endpoints. Only paths observed in captured traffic are used.
 *
 * Confirmed:  POST /api/journal/v1/user-journal-data/push    create AND update (upsert by uuid)
 * Confirmed:  GET  /api/journal/v1/user-journal-data/pull    envelope + collection names
 * Confirmed:  GET  /api/journal/v1/custom-journal-types/pull envelope
 *
 * Editing in the app re-pushes the same uuid with the original createdAt, a new updatedAt and the
 * new value. The app keeps one entry per factor per day, so writes here look up that entry first.
 * Clearing a factor in the app leaves the entry in place with isNotSet: true and no boolValue;
 * setting a value again reuses that entry.
 */
import type { BevelHttpClient } from "../http/client.js";
import { localDayOf } from "../time.js";
import { parseItems, pullAllPages, type PullAllOptions } from "./pull.js";
import { verifyPush } from "./push.js";
import {
  CustomJournalTypesPullPageSchema,
  JOURNAL_PULL_COLLECTIONS,
  JOURNAL_PUSH_COLLECTIONS,
  JournalPullPageSchema,
  PulledBooleanJournalSchema,
  type BooleanJournalEntry,
  type JournalPullCollection,
  type JournalPushRequest,
  type JournalPushResponse,
  type PulledBooleanJournal,
} from "./types.js";

export const JOURNAL_PATHS = {
  push: "/api/journal/v1/user-journal-data/push",
  pull: "/api/journal/v1/user-journal-data/pull",
  customTypesPull: "/api/journal/v1/custom-journal-types/pull",
} as const;

/** Page size the app uses for both Journal pulls. */
export const JOURNAL_PULL_PAGE_SIZE = 100;

/**
 * Boolean factor keys known to exist in the app.
 *  - addedSugar, deviceInBed: written through the API and confirmed in the app.
 *  - lateMeal: present in live Journal data (label inferred from the key).
 */
export const VERIFIED_BOOLEAN_FACTOR_KEYS: Readonly<Record<string, string>> = {
  addedSugar: "Added Sugar",
  deviceInBed: "Device in Bed",
  lateMeal: "Late Meal",
};

export function buildBooleanJournalEntry(input: {
  uuid: string;
  factorKey: string;
  value: boolean;
  identifyingDate: number;
  now: number;
}): BooleanJournalEntry {
  return {
    identifyingDate: input.identifyingDate,
    uuid: input.uuid,
    presetFactorKey: input.factorKey,
    boolValue: input.value,
    startTime: input.identifyingDate,
    updatedAt: input.now,
    isNotSet: false,
    createdAt: input.now,
    endTime: input.identifyingDate,
  };
}

/** Mirrors the app's edit: same uuid, identifyingDate, start/end and createdAt; new value and updatedAt. */
export function buildBooleanJournalUpdate(
  existing: PulledBooleanJournal,
  value: boolean,
  now: number,
): BooleanJournalEntry {
  return {
    identifyingDate: existing.identifyingDate,
    uuid: existing.uuid,
    presetFactorKey: existing.presetFactorKey,
    boolValue: value,
    startTime: existing.startTime ?? existing.identifyingDate,
    updatedAt: now,
    isNotSet: false,
    createdAt: existing.createdAt,
    endTime: existing.endTime ?? existing.identifyingDate,
  };
}

/**
 * Mirrors the app's "clear": same uuid, dates and createdAt; isNotSet: true; the boolValue key is
 * omitted entirely (captured 2026-11-10); new updatedAt.
 */
export function buildBooleanJournalClear(existing: PulledBooleanJournal, now: number): BooleanJournalEntry {
  return {
    identifyingDate: existing.identifyingDate,
    uuid: existing.uuid,
    presetFactorKey: existing.presetFactorKey,
    startTime: existing.startTime ?? existing.identifyingDate,
    updatedAt: now,
    isNotSet: true,
    createdAt: existing.createdAt,
    endTime: existing.endTime ?? existing.identifyingDate,
  };
}

/** Always includes all five collections, defaulting to empty arrays (as the app does). */
export function buildJournalPushRequest(partial: Partial<JournalPushRequest>): JournalPushRequest {
  return {
    booleanJournalDefaults: partial.booleanJournalDefaults ?? [],
    customJournalTypes: partial.customJournalTypes ?? [],
    booleanJournals: partial.booleanJournals ?? [],
    numericJournalDefaults: partial.numericJournalDefaults ?? [],
    categoricalJournalDefaults: partial.categoricalJournalDefaults ?? [],
  };
}

export interface ParsedBooleanEntries {
  entries: PulledBooleanJournal[];
  /** Items that did not match the expected shape (kept raw so they can be inspected). */
  unparsed: unknown[];
}

export function parseBooleanEntries(items: unknown[]): ParsedBooleanEntries {
  const { items: entries, unparsed } = parseItems(PulledBooleanJournalSchema, items);
  return { entries, unparsed };
}

/**
 * Entries for one factor on one local calendar day, most recently updated first.
 * Matching by local day (not exact identifyingDate) tolerates entries logged in another time zone.
 */
export function findBooleanEntries(
  entries: PulledBooleanJournal[],
  factorKey: string,
  day: string,
  timeZone: string,
): PulledBooleanJournal[] {
  return entries
    .filter((e) => e.presetFactorKey === factorKey && localDayOf(e.identifyingDate, timeZone) === day)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * HTTP 200 is not success: every submitted id must be listed in its collection's `succeeded`.
 * Throws BevelPushError listing every id that failed or was not acknowledged.
 */
export function verifyPushResponse(request: JournalPushRequest, raw: unknown): JournalPushResponse {
  return verifyPush(JOURNAL_PUSH_COLLECTIONS, request, raw) as JournalPushResponse;
}

export interface JournalPullResult {
  journalData: Record<JournalPullCollection, unknown[]>;
  /** Keys under journalData that have not been seen before (e.g. a new entry type), kept raw. */
  unknownCollections: Record<string, unknown>;
  pagesFetched: number;
  truncated: boolean;
}

export interface CustomJournalTypesPullResult {
  customJournalTypes: unknown[];
  pagesFetched: number;
  truncated: boolean;
}

export class JournalApi {
  constructor(private readonly http: BevelHttpClient) {}

  /** Fetches every page of Journal data changed after `lastSyncDate` (0 = everything). */
  async pullJournal(options: PullAllOptions): Promise<JournalPullResult> {
    const { pages, truncated } = await pullAllPages(
      JOURNAL_PATHS.pull,
      (query) => this.http.request("GET", JOURNAL_PATHS.pull, { query, fresh: options.fresh ?? false }),
      JournalPullPageSchema,
      options,
    );
    const journalData = Object.fromEntries(JOURNAL_PULL_COLLECTIONS.map((key) => [key, [] as unknown[]])) as Record<
      JournalPullCollection,
      unknown[]
    >;
    const known = new Set<string>(JOURNAL_PULL_COLLECTIONS);
    const unknownCollections: Record<string, unknown> = {};
    for (const page of pages) {
      for (const key of JOURNAL_PULL_COLLECTIONS) journalData[key].push(...page.journalData[key]);
      for (const [key, value] of Object.entries(page.journalData)) {
        if (known.has(key)) continue;
        const previous = unknownCollections[key];
        unknownCollections[key] =
          Array.isArray(previous) && Array.isArray(value) ? [...previous, ...value] : (previous ?? value);
      }
    }
    return { journalData, unknownCollections, pagesFetched: pages.length, truncated };
  }

  async pullCustomJournalTypes(options: PullAllOptions): Promise<CustomJournalTypesPullResult> {
    const { pages, truncated } = await pullAllPages(
      JOURNAL_PATHS.customTypesPull,
      (query) => this.http.request("GET", JOURNAL_PATHS.customTypesPull, { query, fresh: options.fresh ?? false }),
      CustomJournalTypesPullPageSchema,
      options,
    );
    return { customJournalTypes: pages.flatMap((p) => p.customJournalTypes), pagesFetched: pages.length, truncated };
  }

  /** Sends a push and verifies every submitted id was acknowledged. Never retried automatically. */
  async pushJournalData(request: JournalPushRequest): Promise<JournalPushResponse> {
    const raw = await this.http.request("POST", JOURNAL_PATHS.push, { body: request });
    return verifyPushResponse(request, raw);
  }
}
