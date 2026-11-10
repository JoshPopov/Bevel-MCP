/**
 * Day/timestamp handling for Bevel Journal entries.
 *
 * Observed: a Boolean Journal entry logged for 2026-11-10 on an iPhone set to US Eastern had
 * identifyingDate = startTime = endTime = 1794330000000 = 2026-11-10T17:00:00Z = 12:00 local.
 * So Bevel represents a calendar day as **local noon**, in Unix milliseconds.
 * (Verified for one day in America/New_York; other zones follow the same rule by assumption.)
 */
import { BevelConfigError } from "./http/errors.js";

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new BevelConfigError(`Unknown IANA time zone: "${timeZone}"`);
  }
}

export function parseDay(day: string): CalendarDay {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new RangeError(`Expected a date like 2026-11-10, got "${day}"`);
  const [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    throw new RangeError(`Not a real calendar date: "${day}"`);
  }
  return { year, month, day: dayOfMonth };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(utcMs: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`. */
function offsetMs(utcMs: number, timeZone: string): number {
  const wall = wallClockAt(utcMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a local wall-clock time in `timeZone` to Unix ms. */
export function zonedTimeToUtcMs(
  day: CalendarDay,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const firstOffset = offsetMs(guess, timeZone);
  let result = guess - firstOffset;
  const secondOffset = offsetMs(result, timeZone);
  if (secondOffset !== firstOffset) result = guess - secondOffset;
  return result;
}

/** The identifyingDate Bevel uses for a calendar day: local noon, Unix ms. */
export function dayToIdentifyingDate(day: string, timeZone: string): number {
  return zonedTimeToUtcMs(parseDay(day), 12, 0, timeZone);
}

/** Today's date (YYYY-MM-DD) in `timeZone`. */
export function todayInTimeZone(timeZone: string, nowMs: number = Date.now()): string {
  const wall = wallClockAt(nowMs, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * Current time in Unix ms with sub-millisecond precision, matching captured
 * createdAt/updatedAt values such as 1794334952292.573.
 */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Human-readable rendering of a Unix-ms timestamp for tool output. */
export function describeTimestamp(ms: number, timeZone: string): { utc: string; local: string } {
  return {
    utc: new Date(ms).toISOString(),
    local: new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date(ms)),
  };
}

/** The local calendar day (YYYY-MM-DD) that a Unix-ms timestamp falls on in `timeZone`. */
export function localDayOf(ms: number, timeZone: string): string {
  return todayInTimeZone(timeZone, ms);
}

/** Calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export function addDays(day: string, days: number): string {
  const { year, month, day: d } = parseDay(day);
  const shifted = new Date(Date.UTC(year, month - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Parses "HH:MM" (24-hour). */
export function parseTimeOfDay(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new RangeError(`Expected a 24-hour time like 08:30, got "${time}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Local wall-clock "HH:MM" of a Unix-ms timestamp in `timeZone`. */
export function localTimeOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(ms),
  );
}
