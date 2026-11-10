/**
 * Pagination for Bevel's `/pull` sync endpoints.
 *
 * Observed protocol: GET <path>?offset=<n>&limit=<n>&lastSyncDate=<unix ms>
 *   -> { moreAvailable: boolean, offset: <next offset>, <collection payload> }
 * lastSyncDate makes the pull incremental: only records changed after that instant come back.
 * lastSyncDate=0 returns the full history (confirmed against a live Journal pull).
 */
import { z } from "zod";
import { BevelSchemaError } from "../http/errors.js";

/**
 * Every captured `/pull` response shares this envelope. `offset` is the offset to request next
 * (request offset + limit); `moreAvailable` says whether to keep paging.
 */
export const PullEnvelopeShape = {
  moreAvailable: z.boolean(),
  offset: z.number(),
};


export interface PullAllOptions {
  /** Unix ms. 0 = full history. */
  lastSyncDate: number;
  /** Page size. The app uses 100 for Journal data and 30 for fitness/food data. */
  limit: number;
  /** Safety cap on pages fetched in one call. */
  maxPages: number;
  /** Bypass the read cache (lookups before writes). */
  fresh?: boolean;
}

export interface PullAllResult<T> {
  pages: T[];
  /** True when maxPages was hit while the server still reported moreAvailable. */
  truncated: boolean;
}

export async function pullAllPages<T extends { moreAvailable: boolean; offset: number }>(
  path: string,
  fetchPage: (query: { offset: number; limit: number; lastSyncDate: number }) => Promise<unknown>,
  schema: z.ZodType<T>,
  options: PullAllOptions,
): Promise<PullAllResult<T>> {
  const pages: T[] = [];
  let offset = 0;
  for (let i = 0; i < options.maxPages; i++) {
    const raw = await fetchPage({ offset, limit: options.limit, lastSyncDate: options.lastSyncDate });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new BevelSchemaError(
        `Response from ${path} does not match the captured shape (${issues}). The API may have changed.`,
        path,
        raw,
      );
    }
    const page = parsed.data;
    pages.push(page);
    if (!page.moreAvailable) return { pages, truncated: false };
    // Guard against a server that does not advance the offset.
    offset = page.offset > offset ? page.offset : offset + options.limit;
  }
  return { pages, truncated: true };
}

/** Unix ms as a number (what the app sends) or an ISO-8601 string (what the server returns), normalised to ms. */
export const TimestampMs = z
  .union([z.number(), z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not an ISO date")])
  .transform((v) => (typeof v === "number" ? v : Date.parse(v)));

export interface ParsedItems<T> {
  items: T[];
  /** Items that did not match the expected shape, kept raw so they can be shown to the user. */
  unparsed: unknown[];
}

/** Lenient parsing for pulled records: never silently drops an item that does not match. */
export function parseItems<T>(schema: z.ZodType<T>, raw: unknown[]): ParsedItems<T> {
  const items: T[] = [];
  const unparsed: unknown[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
    else unparsed.push(item);
  }
  return { items, unparsed };
}
