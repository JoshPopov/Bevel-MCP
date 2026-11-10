/**
 * Macronutrient goals (captured 2026-11-10).
 *
 *   GET  /api/nutrition/v1/macronutrient-goals/pull  → { moreAvailable, offset, macronutrientGoals: [...] }
 *   POST /api/nutrition/v1/macronutrient-goals/push  { macronutrientGoals: [...] } → bucket "macronutrientGoals"
 *
 * Changing goals in the app:
 *  - if the active goal started on an earlier day, it is ended (endDate = yesterday) and a new
 *    "custom" goal starting today is created — both in one push;
 *  - if the active goal already starts today, it is updated in place (same id).
 */
import { z } from "zod";
import type { BevelHttpClient } from "../http/client.js";
import { addDays } from "../time.js";
import { PullEnvelopeShape, TimestampMs, pullAllPages, type PullAllOptions } from "./pull.js";
import { verifyPush, type PushResponse } from "./push.js";

export const GOALS_PATHS = {
  pull: "/api/nutrition/v1/macronutrient-goals/pull",
  push: "/api/nutrition/v1/macronutrient-goals/push",
} as const;

/** Page size the app uses for this pull. */
export const GOALS_PULL_PAGE_SIZE = 100;

const CalendarDateSchema = z.object({ year: z.number().int(), month: z.number().int(), day: z.number().int() });
export type CalendarDate = z.infer<typeof CalendarDateSchema>;

const QuantitySchema = z.object({ value: z.number(), unit: z.string() });
export type Quantity = z.infer<typeof QuantitySchema>;

/** A goal as pulled. Lenient: the pulled shape has only been seen through its push form. */
export const PulledMacroGoalSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    caloriesGoal: QuantitySchema,
    proteinGoal: QuantitySchema,
    carbsGoal: QuantitySchema,
    fatsGoal: QuantitySchema,
    totalDailyEnergyExpenditure: QuantitySchema.optional(),
    effectiveStartDate: CalendarDateSchema,
    endDate: CalendarDateSchema.nullish(),
    updatedAt: TimestampMs,
  })
  .loose();
export type PulledMacroGoal = z.infer<typeof PulledMacroGoalSchema>;

/** A goal exactly as the app pushes it (field set from the capture). */
export interface MacroGoal {
  id: string;
  type: string;
  caloriesGoal: Quantity;
  proteinGoal: Quantity;
  carbsGoal: Quantity;
  fatsGoal: Quantity;
  totalDailyEnergyExpenditure?: Quantity;
  effectiveStartDate: CalendarDate;
  endDate?: CalendarDate;
  updatedAt: number;
}

const GoalsPullPageSchema = z.object({ ...PullEnvelopeShape, macronutrientGoals: z.array(z.unknown()) }).loose();

export const GOALS_PUSH_COLLECTIONS = ["macronutrientGoals"] as const;

export function toCalendarDate(day: string): CalendarDate {
  const [year, month, d] = day.split("-").map(Number) as [number, number, number];
  return { year, month, day: d };
}

export function fromCalendarDate(date: CalendarDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function isActiveOn(goal: PulledMacroGoal, day: string): boolean {
  const start = fromCalendarDate(goal.effectiveStartDate);
  const end = goal.endDate ? fromCalendarDate(goal.endDate) : undefined;
  return start <= day && (end === undefined || end >= day);
}

/** The goal in effect on `day`: latest start wins, then latest update. */
export function activeGoalOn(goals: PulledMacroGoal[], day: string): PulledMacroGoal | undefined {
  return goals
    .filter((g) => isActiveOn(g, day))
    .sort(
      (a, b) =>
        fromCalendarDate(b.effectiveStartDate).localeCompare(fromCalendarDate(a.effectiveStartDate)) ||
        b.updatedAt - a.updatedAt,
    )[0];
}

/** Rebuilds a pulled goal into the captured push shape (whitelisted fields only). */
export function toPushGoal(goal: PulledMacroGoal, updatedAt: number): MacroGoal {
  return {
    id: goal.id,
    type: goal.type,
    caloriesGoal: { value: goal.caloriesGoal.value, unit: goal.caloriesGoal.unit },
    proteinGoal: { value: goal.proteinGoal.value, unit: goal.proteinGoal.unit },
    carbsGoal: { value: goal.carbsGoal.value, unit: goal.carbsGoal.unit },
    fatsGoal: { value: goal.fatsGoal.value, unit: goal.fatsGoal.unit },
    ...(goal.totalDailyEnergyExpenditure
      ? { totalDailyEnergyExpenditure: { ...goal.totalDailyEnergyExpenditure } }
      : {}),
    effectiveStartDate: { ...goal.effectiveStartDate },
    ...(goal.endDate ? { endDate: { ...goal.endDate } } : {}),
    updatedAt,
  };
}

export interface MacroTargets {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** 4 kcal/g protein and carbs, 9 kcal/g fat — matches both captured goals exactly. */
export function caloriesFromMacros(proteinG: number, carbsG: number, fatG: number): number {
  return Math.round((proteinG * 4 + carbsG * 4 + fatG * 9) * 100) / 100;
}

export type GoalChangePlan =
  | { action: "updated"; goals: [MacroGoal]; previous: PulledMacroGoal }
  | { action: "replaced"; goals: [MacroGoal, MacroGoal]; previous: PulledMacroGoal };

/** Mirrors the app's two observed behaviours. Throws if there is no active goal to base TDEE on. */
export function planGoalChange(input: {
  goals: PulledMacroGoal[];
  today: string;
  targets: MacroTargets;
  newId: string;
  now: number;
}): GoalChangePlan {
  const active = activeGoalOn(input.goals, input.today);
  if (!active) {
    throw new Error(
      "There is no active macro goal to change. Set one once in the app (it computes your energy expenditure), then retry.",
    );
  }
  const values = {
    caloriesGoal: { value: input.targets.calories, unit: active.caloriesGoal.unit },
    proteinGoal: { value: input.targets.proteinG, unit: active.proteinGoal.unit },
    carbsGoal: { value: input.targets.carbsG, unit: active.carbsGoal.unit },
    fatsGoal: { value: input.targets.fatG, unit: active.fatsGoal.unit },
  };
  if (fromCalendarDate(active.effectiveStartDate) === input.today) {
    return { action: "updated", previous: active, goals: [{ ...toPushGoal(active, input.now), ...values }] };
  }
  const ended: MacroGoal = { ...toPushGoal(active, input.now), endDate: toCalendarDate(addDays(input.today, -1)) };
  const next: MacroGoal = {
    id: input.newId,
    type: "custom",
    ...values,
    ...(active.totalDailyEnergyExpenditure
      ? { totalDailyEnergyExpenditure: { ...active.totalDailyEnergyExpenditure } }
      : {}),
    effectiveStartDate: toCalendarDate(input.today),
    updatedAt: input.now,
  };
  return { action: "replaced", previous: active, goals: [ended, next] };
}

export class GoalsApi {
  constructor(private readonly http: BevelHttpClient) {}

  async pullGoals(options: PullAllOptions): Promise<{ goals: unknown[]; pagesFetched: number; truncated: boolean }> {
    const { pages, truncated } = await pullAllPages(
      GOALS_PATHS.pull,
      (query) => this.http.request("GET", GOALS_PATHS.pull, { query, fresh: options.fresh ?? false }),
      GoalsPullPageSchema,
      options,
    );
    return { goals: pages.flatMap((p) => p.macronutrientGoals), pagesFetched: pages.length, truncated };
  }

  async pushGoals(goals: MacroGoal[]): Promise<PushResponse<"macronutrientGoals">> {
    const body = { macronutrientGoals: goals };
    const raw = await this.http.request("POST", GOALS_PATHS.push, { body });
    return verifyPush(GOALS_PUSH_COLLECTIONS, body, raw);
  }
}
