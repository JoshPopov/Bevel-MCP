/**
 * Verification shared by every `/push` endpoint.
 *
 * Observed on Journal, Nutrition (food data, macro goals) and Fitness: the response has one
 * `{succeeded: string[], failed: unknown[]}` bucket per collection. HTTP 200 alone is not success —
 * each submitted id (`uuid` or `id`) must be listed in its collection's `succeeded`.
 */
import { z } from "zod";
import { BevelPushError, type PushFailureDetail } from "../http/errors.js";

export const PushBucketSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.unknown()),
});
export type PushBucket = z.infer<typeof PushBucketSchema>;

export type PushResponse<C extends string> = Partial<Record<C, PushBucket>> & Record<string, unknown>;

/** The id a push item is acknowledged by: `uuid` (Journal) or `id` (Nutrition, Fitness). */
export function itemId(item: unknown): string | undefined {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    if (typeof record.uuid === "string") return record.uuid;
    if (typeof record.id === "string") return record.id;
  }
  return undefined;
}

function failedEntryMentions(entry: unknown, id: string): boolean {
  const needle = id.toLowerCase();
  if (typeof entry === "string") return entry.toLowerCase() === needle;
  try {
    return JSON.stringify(entry).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

/**
 * Throws BevelPushError listing every submitted id that failed or was not acknowledged.
 * Extra response buckets (e.g. Fitness answers `exerciseNotes` even when not sent) are allowed.
 */
export function verifyPush<C extends string>(
  collections: readonly C[],
  request: Partial<Record<C, unknown[]>>,
  raw: unknown,
): PushResponse<C> {
  const schema = z
    .object(Object.fromEntries(collections.map((key) => [key, PushBucketSchema.optional()])) as Record<
      C,
      z.ZodOptional<typeof PushBucketSchema>
    >)
    .loose();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BevelPushError(
      "Push returned an unexpected response shape; cannot confirm the write. Check the app before retrying.",
      [],
      raw,
    );
  }
  const response = parsed.data as PushResponse<C>;
  const failures: PushFailureDetail[] = [];

  for (const collection of collections) {
    const submitted = (request[collection] ?? []).map(itemId).filter((id): id is string => id !== undefined);
    if (submitted.length === 0) continue;
    const bucket = response[collection];
    const succeeded = new Set((bucket?.succeeded ?? []).map((id) => id.toLowerCase()));
    for (const id of submitted) {
      if (succeeded.has(id.toLowerCase())) continue;
      const failedEntry = bucket?.failed.find((entry) => failedEntryMentions(entry, id));
      failures.push(
        failedEntry === undefined
          ? { collection, id, reason: "missing" }
          : { collection, id, reason: "failed", serverDetail: failedEntry },
      );
    }
  }

  if (failures.length > 0) {
    const summary = failures.map((f) => `${f.collection}/${f.id}: ${f.reason}`).join(", ");
    throw new BevelPushError(`Bevel did not confirm every submitted entry (${summary})`, failures, response);
  }
  return response;
}
