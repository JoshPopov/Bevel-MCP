/**
 * Fitness endpoints (captured 2026-11-10).
 *
 *   GET  /api/fitness/v1/user-fitness-data/pull  (app limit 30)
 *        → {moreAvailable, offset, fitnessData: {customExercises, strengthWorkoutTemplates,
 *            cardioWorkoutTemplates, strengthWorkoutSessions, exerciseNotes}}
 *   POST /api/fitness/v1/user-fitness-data/push
 *        {strengthWorkoutTemplates, strengthWorkoutSessions, cardioWorkoutTemplates, customExercises}
 *        → one bucket per collection (plus exerciseNotes)
 *
 * Captured behaviour:
 *  - a routine ("strength workout template") is always pushed whole; editing keeps its id,
 *    createdAt and setGroup ids, regenerates set ids and bumps updatedAt;
 *  - deleting a routine re-pushes it with isDeleted: true;
 *  - a set group references either a built-in exercise (presetWorkoutId) or a custom one
 *    (customExerciseId); weights are stored as weightLbs, weightUnit is the display unit;
 *  - timed exercises use `duration` (seconds) with weightLbs 0 and no reps.
 * Completed sessions ("strengthWorkoutSessions") have been seen in a live pull (read-only support);
 * their push, cardio templates and exercise notes have not been captured yet.
 */
import { z } from "zod";
import type { BevelHttpClient } from "../http/client.js";
import { PullEnvelopeShape, TimestampMs, pullAllPages, type PullAllOptions } from "./pull.js";
import { verifyPush, type PushResponse } from "./push.js";

export const FITNESS_PATHS = {
  pull: "/api/fitness/v1/user-fitness-data/pull",
  push: "/api/fitness/v1/user-fitness-data/push",
} as const;

export const FITNESS_PULL_PAGE_SIZE = 30;
export const FITNESS_PUSH_COLLECTIONS = [
  "strengthWorkoutTemplates",
  "strengthWorkoutSessions",
  "cardioWorkoutTemplates",
  "customExercises",
] as const;
const FITNESS_PULL_COLLECTIONS = [
  "customExercises",
  "strengthWorkoutTemplates",
  "cardioWorkoutTemplates",
  "strengthWorkoutSessions",
  "exerciseNotes",
] as const;
type FitnessPullCollection = (typeof FITNESS_PULL_COLLECTIONS)[number];

/** Values seen in captured traffic. Anything else must also appear in the user's own data, or be opted into. */
export const KNOWN_PRESET_WORKOUT_IDS = [
  "abCrunchMachine",
  "abRoller",
  "backExtensionMachine",
  "backLever",
  "backPlank",
  "backRowMachine",
  "benchDip",
  "benchPressBarbell",
  "benchPressCable",
  "benchPressDumbbell",
  "deltoidRaiseDumbbellBentOver",
  "latPulldownMachineBehindTheNeck",
  "smithMachineShoulderPressBehindTheNeck",
] as const;
export const KNOWN_EQUIPMENT = ["band"] as const;
export const KNOWN_EXERCISE_TYPES = ["reps"] as const;
export const KNOWN_MUSCLE_GROUPS = ["hipFlexors", "calves"] as const;

/**
 * The app's own conversion: kg sets are stored as kg × 2.20462, unrounded
 * (live data: 18 kg → 39.683159999999994, 32 kg → 70.54784, 59 kg → 130.07258).
 */
export const LBS_PER_KG = 2.20462;

const FitnessPullPageSchema = z
  .object({
    ...PullEnvelopeShape,
    fitnessData: z
      .object(
        Object.fromEntries(FITNESS_PULL_COLLECTIONS.map((key) => [key, z.array(z.unknown())])) as Record<
          FitnessPullCollection,
          z.ZodArray<z.ZodUnknown>
        >,
      )
      .loose(),
  })
  .loose();

const SetSchema = z
  .object({
    id: z.string(),
    setLabel: z.string(),
    weightLbs: z.number(),
    restDuration: z.number(),
    reps: z.number().optional(),
    duration: z.number().optional(),
  })
  .loose();

const SetGroupSchema = z
  .object({
    id: z.string(),
    presetWorkoutId: z.string().optional(),
    customExerciseId: z.string().optional(),
    weightUnit: z.string(),
    isRestTimersEnabled: z.boolean(),
    routineNotes: z.array(z.unknown()),
    sets: z.array(SetSchema),
    superset: z.object({ id: z.string(), style: z.string() }).loose().optional(),
  })
  .loose()
  .refine((g) => Boolean(g.presetWorkoutId) !== Boolean(g.customExerciseId), "exactly one of presetWorkoutId/customExerciseId");

export const PulledRoutineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: TimestampMs,
    updatedAt: TimestampMs,
    isDeleted: z.boolean(),
    notes: z.array(z.unknown()),
    setGroups: z.array(SetGroupSchema),
  })
  .loose();
export type PulledRoutine = z.infer<typeof PulledRoutineSchema>;

export const PulledCustomExerciseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    equipment: z.string(),
    defaultExerciseType: z.string(),
    primaryMuscleGroups: z.array(z.string()),
    secondaryMuscleGroups: z.array(z.string()),
    isDeleted: z.boolean(),
    createdAt: TimestampMs,
    updatedAt: TimestampMs,
  })
  .loose();
export type PulledCustomExercise = z.infer<typeof PulledCustomExerciseSchema>;

export interface CustomExercise {
  id: string;
  name: string;
  equipment: string;
  defaultExerciseType: string;
  primaryMuscleGroups: string[];
  secondaryMuscleGroups: string[];
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineSet {
  id: string;
  setLabel: string;
  weightLbs: number;
  restDuration: number;
  reps?: number;
  duration?: number;
}

export interface RoutineSetGroup {
  id: string;
  presetWorkoutId?: string;
  customExerciseId?: string;
  weightUnit: string;
  isRestTimersEnabled: boolean;
  routineNotes: unknown[];
  sets: RoutineSet[];
  superset?: { id: string; style: string };
}

export interface Routine {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  isDeleted: boolean;
  notes: unknown[];
  setGroups: RoutineSetGroup[];
}

export interface RoutineExerciseInput {
  presetWorkoutId?: string;
  customExerciseId?: string;
  weightUnit?: "lb" | "kg";
  restTimers?: boolean;
  sets: { reps?: number; durationSec?: number; weight?: number; restSec?: number }[];
}

export function toWeightLbs(weight: number, unit: "lb" | "kg"): number {
  return unit === "kg" ? weight * LBS_PER_KG : weight;
}

export function fromWeightLbs(weightLbs: number, unit: string): number {
  return unit === "kg" ? Math.round((weightLbs / LBS_PER_KG) * 100) / 100 : weightLbs;
}

export function buildCustomExercise(input: {
  id: string;
  name: string;
  equipment: string;
  defaultExerciseType: string;
  primaryMuscleGroups: string[];
  secondaryMuscleGroups: string[];
  now: number;
}): CustomExercise {
  return {
    isDeleted: false,
    equipment: input.equipment,
    defaultExerciseType: input.defaultExerciseType,
    updatedAt: input.now,
    createdAt: input.now,
    primaryMuscleGroups: input.primaryMuscleGroups,
    id: input.id,
    name: input.name,
    secondaryMuscleGroups: input.secondaryMuscleGroups,
  };
}

const exerciseKey = (g: { presetWorkoutId?: string | undefined; customExerciseId?: string | undefined }) =>
  g.presetWorkoutId ? `preset:${g.presetWorkoutId}` : `custom:${g.customExerciseId}`;

/** Re-serialises a pulled set group into the captured push shape (whitelisted fields). */
function toPushSetGroup(group: z.infer<typeof SetGroupSchema>): RoutineSetGroup {
  return {
    id: group.id,
    ...(group.presetWorkoutId ? { presetWorkoutId: group.presetWorkoutId } : {}),
    ...(group.customExerciseId ? { customExerciseId: group.customExerciseId } : {}),
    weightUnit: group.weightUnit,
    isRestTimersEnabled: group.isRestTimersEnabled,
    routineNotes: group.routineNotes,
    sets: group.sets.map((s) => ({
      id: s.id,
      setLabel: s.setLabel,
      weightLbs: s.weightLbs,
      restDuration: s.restDuration,
      ...(s.reps !== undefined ? { reps: s.reps } : {}),
      ...(s.duration !== undefined ? { duration: s.duration } : {}),
    })),
    ...(group.superset ? { superset: { id: group.superset.id, style: group.superset.style } } : {}),
  };
}

/**
 * Builds a routine for create (no `existing`) or full-replace update. On update the id, createdAt
 * and notes are kept, and a set group keeps its id when the same exercise sits at the same position
 * (as captured); every set gets a new id, as the app does.
 */
export function buildRoutine(input: {
  name: string;
  exercises: RoutineExerciseInput[];
  existing?: PulledRoutine;
  newId: () => string;
  now: number;
}): Routine {
  const previousGroups = input.existing?.setGroups ?? [];
  const setGroups: RoutineSetGroup[] = input.exercises.map((exercise, index) => {
    const unit = exercise.weightUnit ?? "lb";
    const previous = previousGroups[index];
    const reuse = previous && exerciseKey(previous) === exerciseKey(exercise) ? previous : undefined;
    return {
      id: reuse?.id ?? input.newId(),
      ...(exercise.presetWorkoutId ? { presetWorkoutId: exercise.presetWorkoutId } : {}),
      ...(exercise.customExerciseId ? { customExerciseId: exercise.customExerciseId } : {}),
      weightUnit: unit,
      isRestTimersEnabled: exercise.restTimers ?? true,
      routineNotes: reuse?.routineNotes ?? [],
      sets: exercise.sets.map((set) => ({
        id: input.newId(),
        setLabel: "normal",
        weightLbs: set.durationSec !== undefined && set.weight === undefined ? 0 : toWeightLbs(set.weight ?? 0, unit),
        restDuration: set.restSec ?? 120,
        ...(set.durationSec !== undefined ? { duration: set.durationSec } : { reps: set.reps ?? 0 }),
      })),
    };
  });
  return {
    id: input.existing?.id ?? input.newId(),
    name: input.name,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    isDeleted: false,
    notes: input.existing?.notes ?? [],
    setGroups,
  };
}

/** Deleting re-pushes the whole routine with isDeleted: true (captured). */
export function buildRoutineDelete(existing: PulledRoutine, now: number): Routine {
  return {
    id: existing.id,
    name: existing.name,
    createdAt: existing.createdAt,
    updatedAt: now,
    isDeleted: true,
    notes: existing.notes,
    setGroups: existing.setGroups.map(toPushSetGroup),
  };
}

export interface FitnessData {
  data: Record<FitnessPullCollection, unknown[]>;
  pagesFetched: number;
  truncated: boolean;
}

export class FitnessApi {
  constructor(private readonly http: BevelHttpClient) {}

  async pullFitness(options: PullAllOptions): Promise<FitnessData> {
    const { pages, truncated } = await pullAllPages(
      FITNESS_PATHS.pull,
      (query) => this.http.request("GET", FITNESS_PATHS.pull, { query, fresh: options.fresh ?? false }),
      FitnessPullPageSchema,
      options,
    );
    const data = Object.fromEntries(FITNESS_PULL_COLLECTIONS.map((k) => [k, [] as unknown[]])) as Record<
      FitnessPullCollection,
      unknown[]
    >;
    for (const page of pages) for (const key of FITNESS_PULL_COLLECTIONS) data[key].push(...page.fitnessData[key]);
    return { data, pagesFetched: pages.length, truncated };
  }

  async pushFitness(partial: {
    strengthWorkoutTemplates?: Routine[];
    customExercises?: CustomExercise[];
  }): Promise<PushResponse<(typeof FITNESS_PUSH_COLLECTIONS)[number]>> {
    const body = {
      strengthWorkoutTemplates: partial.strengthWorkoutTemplates ?? [],
      strengthWorkoutSessions: [],
      cardioWorkoutTemplates: [],
      customExercises: partial.customExercises ?? [],
    };
    const raw = await this.http.request("POST", FITNESS_PATHS.push, { body });
    return verifyPush(FITNESS_PUSH_COLLECTIONS, body, raw);
  }
}

/**
 * A completed strength workout as stored (seen in a live pull, 2026-11-10). Sessions are tied to an
 * Apple Health workout (hkWorkoutId, sourceTypeKey "healthKit"); sets are a flat list grouped by
 * setGroupId, with Apple Watch rep-detection `analysis` on some. Read-only in this client.
 */
const SessionSetSchema = z
  .object({
    id: z.string(),
    presetWorkoutId: z.string().optional(),
    customExerciseId: z.string().optional(),
    setGroupId: z.string().optional(),
    setLabel: z.string().optional(),
    reps: z.number().optional(),
    duration: z.number().optional(),
    weightLbs: z.number(),
    weightUnit: z.string(),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    activeDuration: z.number().optional(),
    plannedRestDuration: z.number().optional(),
    trailingRestDuration: z.number().optional(),
    autodetected: z.boolean().optional(),
  })
  .loose();

export const PulledSessionSchema = z
  .object({
    id: z.string(),
    startDate: TimestampMs,
    endDate: TimestampMs,
    isRemoved: z.boolean().optional(),
    estimatedEffort: z.number().nullish(),
    sourceTypeKey: z.string().optional(),
    sets: z.array(SessionSetSchema),
    updatedAt: TimestampMs.optional(),
  })
  .loose();
export type PulledSession = z.infer<typeof PulledSessionSchema>;
