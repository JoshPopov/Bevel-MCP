/**
 * Payload types for the Bevel Journal API, limited to what has been observed in captured traffic.
 * Collections whose item schema has not been captured yet are typed as `unknown[]` and are always
 * sent empty by this client.
 */
import { z } from "zod";
import { TimestampMs } from "./pull.js";
import { PushBucketSchema } from "./push.js";

/** One Boolean Journal entry, field order as captured from Bevel iOS 3.2.7. */
export interface BooleanJournalEntry {
  /** The calendar day, as local noon in Unix ms (see src/time.ts). */
  identifyingDate: number;
  uuid: string;
  presetFactorKey: string;
  /** Omitted entirely (not false) when clearing a factor (isNotSet: true), as the app does. */
  boolValue?: boolean;
  /** Equal to identifyingDate in every captured Boolean entry. */
  startTime: number;
  /** Unix ms, may carry fractional milliseconds. */
  updatedAt: number;
  /** true = the factor was cleared ("not answered") for that day; the entry and uuid stay. */
  isNotSet: boolean;
  createdAt: number;
  /** Equal to identifyingDate in every captured Boolean entry. */
  endTime: number;
}

/** Body of POST /api/journal/v1/user-journal-data/push, key order as captured. */
export interface JournalPushRequest {
  booleanJournalDefaults: unknown[];
  customJournalTypes: unknown[];
  booleanJournals: BooleanJournalEntry[];
  numericJournalDefaults: unknown[];
  categoricalJournalDefaults: unknown[];
}

export const JOURNAL_PUSH_COLLECTIONS = [
  "booleanJournalDefaults",
  "customJournalTypes",
  "booleanJournals",
  "numericJournalDefaults",
  "categoricalJournalDefaults",
] as const satisfies readonly (keyof JournalPushRequest)[];

export type JournalPushCollection = (typeof JOURNAL_PUSH_COLLECTIONS)[number];

export { PushBucketSchema, type PushBucket } from "./push.js";

/** Every captured push response had one bucket per collection; unknown extra keys are kept. */
export const JournalPushResponseSchema = z
  .object(
    Object.fromEntries(JOURNAL_PUSH_COLLECTIONS.map((key) => [key, PushBucketSchema.optional()])) as Record<
      JournalPushCollection,
      z.ZodOptional<typeof PushBucketSchema>
    >,
  )
  .loose();
export type JournalPushResponse = z.infer<typeof JournalPushResponseSchema>;

// ---------------------------------------------------------------------------
// Pull (sync-down) payloads
// ---------------------------------------------------------------------------

export { PullEnvelopeShape } from "./pull.js";
import { PullEnvelopeShape } from "./pull.js";

/** GET /api/journal/v1/user-journal-data/pull (captured with empty arrays). */
export const JOURNAL_PULL_COLLECTIONS = [
  "booleanJournals",
  "booleanJournalDefaults",
  "categoricalJournalDefaults",
  "numericJournalDefaults",
] as const;
export type JournalPullCollection = (typeof JOURNAL_PULL_COLLECTIONS)[number];

export const JournalPullPageSchema = z
  .object({
    ...PullEnvelopeShape,
    journalData: z
      .object(
        Object.fromEntries(JOURNAL_PULL_COLLECTIONS.map((key) => [key, z.array(z.unknown())])) as Record<
          JournalPullCollection,
          z.ZodArray<z.ZodUnknown>
        >,
      )
      .loose(),
  })
  .loose();
export type JournalPullPage = z.infer<typeof JournalPullPageSchema>;

/** GET /api/journal/v1/custom-journal-types/pull (captured with an empty array). */
export const CustomJournalTypesPullPageSchema = z
  .object({ ...PullEnvelopeShape, customJournalTypes: z.array(z.unknown()) })
  .loose();
export type CustomJournalTypesPullPage = z.infer<typeof CustomJournalTypesPullPageSchema>;

/**
 * A Boolean entry as returned by pull (confirmed against live data, 2026-11-10):
 *  - `updatedAt` is the server's own ISO-8601 timestamp, not the client's ms value;
 *  - `createdAt`, `identifyingDate`, `startTime`, `endTime` are the client's ms numbers;
 *  - a cleared factor has `isNotSet: true` and **no `boolValue`**.
 * Timestamps are normalised to Unix ms. Anything else is reported as unparsed, never ignored.
 */
export const PulledBooleanJournalSchema = z
  .object({
    uuid: z.string(),
    presetFactorKey: z.string(),
    boolValue: z.boolean().optional(),
    identifyingDate: z.number(),
    createdAt: TimestampMs,
    updatedAt: TimestampMs,
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    isNotSet: z.boolean().optional(),
  })
  .loose()
  .refine((e) => e.isNotSet === true || e.boolValue !== undefined, "entry has neither a boolValue nor isNotSet: true");
export type PulledBooleanJournal = z.infer<typeof PulledBooleanJournalSchema>;
