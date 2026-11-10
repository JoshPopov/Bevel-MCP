import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  FITNESS_PATHS,
  FITNESS_PULL_PAGE_SIZE,
  KNOWN_EQUIPMENT,
  KNOWN_EXERCISE_TYPES,
  KNOWN_MUSCLE_GROUPS,
  KNOWN_PRESET_WORKOUT_IDS,
  PulledCustomExerciseSchema,
  PulledRoutineSchema,
  PulledSessionSchema,
  buildCustomExercise,
  buildRoutine,
  buildRoutineDelete,
  fromWeightLbs,
  type CustomExercise,
  type PulledCustomExercise,
  type PulledRoutine,
  type PulledSession,
  type Routine,
} from "../api/fitness.js";
import { parseItems } from "../api/pull.js";
import { BevelNetworkError } from "../http/errors.js";
import { localDayOf, localTimeOf, parseDay } from "../time.js";
import { describeError, errorResult, jsonResult, requireWrites, safeHandler, type ToolDeps } from "./shared.js";

interface Workouts {
  sessions: unknown[];
  routines: PulledRoutine[];
  customExercises: PulledCustomExercise[];
  unparsedRoutines: unknown[];
  unparsedCustomExercises: unknown[];
  counts: Record<string, number>;
  truncated: boolean;
}

async function loadWorkouts(deps: ToolDeps, fresh = false): Promise<Workouts> {
  const pulled = await deps.fitness.pullFitness({ lastSyncDate: 0, limit: FITNESS_PULL_PAGE_SIZE, maxPages: 50, fresh });
  const routines = parseItems(PulledRoutineSchema, pulled.data.strengthWorkoutTemplates);
  const customs = parseItems(PulledCustomExerciseSchema, pulled.data.customExercises);
  return {
    sessions: pulled.data.strengthWorkoutSessions,
    routines: routines.items,
    customExercises: customs.items,
    unparsedRoutines: routines.unparsed,
    unparsedCustomExercises: customs.unparsed,
    counts: Object.fromEntries(Object.entries(pulled.data).map(([k, v]) => [k, v.length])),
    truncated: pulled.truncated,
  };
}

/** Refuses writes when the account's workout data could not be fully read and understood. */
function unsafe(workouts: Workouts): CallToolResult | undefined {
  if (workouts.truncated) return errorResult("Could not read all workout data, so nothing was written.");
  const unparsed = [...workouts.unparsedRoutines, ...workouts.unparsedCustomExercises];
  if (unparsed.length === 0) return undefined;
  return errorResult(
    "Pulled workout data has a shape this client does not recognise, so it cannot write safely. Nothing was written. " +
      "Please share this (token-free) sample so the parser can be updated.",
    { sample: unparsed.slice(0, 1), unparsedCount: unparsed.length },
  );
}

/** Known values = captured ones plus anything already present in the user's own data. */
function knownValues(workouts: Workouts) {
  const presets = new Set<string>(KNOWN_PRESET_WORKOUT_IDS);
  for (const r of workouts.routines) for (const g of r.setGroups) if (g.presetWorkoutId) presets.add(g.presetWorkoutId);
  const equipment = new Set<string>(KNOWN_EQUIPMENT);
  const types = new Set<string>(KNOWN_EXERCISE_TYPES);
  const muscles = new Set<string>(KNOWN_MUSCLE_GROUPS);
  for (const c of workouts.customExercises) {
    equipment.add(c.equipment);
    types.add(c.defaultExerciseType);
    for (const m of [...c.primaryMuscleGroups, ...c.secondaryMuscleGroups]) muscles.add(m);
  }
  return { presets, equipment, types, muscles };
}

function unknownValueError(kind: string, values: string[], known: Set<string>): CallToolResult {
  return errorResult(
    `Unrecognised ${kind}: ${values.join(", ")}. Known: ${[...known].sort().join(", ")}. ` +
      "An unknown value could break the Bevel app's decoding; create one in the app first, or pass allowUnverifiedValues: true " +
      "if you are sure it is a real Bevel identifier.",
  );
}

/** The `count` most recent raw records, by any timestamp-like field they carry (pull order otherwise). */
function recentRaw(items: unknown[], count: number): unknown[] {
  const stamp = (item: unknown): number => {
    if (!item || typeof item !== "object") return 0;
    const record = item as Record<string, unknown>;
    for (const key of ["endedAt", "endTime", "startedAt", "startTime", "updatedAt", "createdAt"]) {
      const value = record[key];
      const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
      if (Number.isFinite(ms)) return ms;
    }
    return 0;
  };
  return [...items].sort((a, b) => stamp(b) - stamp(a)).slice(0, count);
}

function summarizeRoutine(routine: PulledRoutine, customs: Map<string, string>) {
  return {
    id: routine.id,
    name: routine.name,
    updatedAt: new Date(routine.updatedAt).toISOString(),
    exercises: routine.setGroups.map((g) => ({
      exercise: g.presetWorkoutId ?? `custom: ${customs.get(g.customExerciseId ?? "") ?? g.customExerciseId}`,
      ...(g.customExerciseId ? { customExerciseId: g.customExerciseId } : {}),
      weightUnit: g.weightUnit,
      restTimers: g.isRestTimersEnabled,
      ...(g.superset ? { superset: g.superset.id } : {}),
      sets: g.sets.map((s) => ({
        ...(s.reps !== undefined ? { reps: s.reps } : {}),
        ...(s.duration !== undefined ? { durationSec: s.duration } : {}),
        weight: fromWeightLbs(s.weightLbs, g.weightUnit),
        restSec: s.restDuration,
      })),
    })),
  };
}

async function push(
  deps: ToolDeps,
  partial: { strengthWorkoutTemplates?: Routine[]; customExercises?: CustomExercise[] },
  action: string,
  id: string,
  details: Record<string, unknown>,
  dryRun: boolean | undefined,
): Promise<CallToolResult> {
  if (dryRun) {
    return jsonResult({
      dryRun: true,
      writesEnabled: deps.config.enableWrites,
      action,
      id,
      ...details,
      request: { method: "POST", path: FITNESS_PATHS.push, body: { ...partial } },
    });
  }
  try {
    const response = await deps.fitness.pushFitness(partial);
    deps.logger.info("Fitness data written", { action, id });
    const bucket = partial.customExercises?.length ? response.customExercises : response.strengthWorkoutTemplates;
    return jsonResult({
      written: true,
      action,
      id,
      ...details,
      server: bucket,
      nextStep: "Force-quit and reopen Bevel, then check Workouts.",
    });
  } catch (error) {
    const { message, details: errorDetails } = describeError(error);
    const unknownOutcome = error instanceof BevelNetworkError && error.outcomeUnknown;
    return errorResult(
      unknownOutcome ? `${message} Check bevel_get_workout_data for id ${id} before retrying.` : message,
      { action, id, ...(errorDetails && typeof errorDetails === "object" ? errorDetails : {}) },
    );
  }
}

function summarizeSession(session: PulledSession, customs: Map<string, string>, timeZone: string, exerciseFilter?: string) {
  const groups = new Map<string, { exercise: string; sets: Record<string, unknown>[]; volumeLbs: number }>();
  let reps = 0;
  let volumeLbs = 0;
  let setCount = 0;
  for (const set of session.sets) {
    const name = set.presetWorkoutId ?? `custom: ${customs.get(set.customExerciseId ?? "") ?? set.customExerciseId ?? "unknown"}`;
    if (exerciseFilter && !name.toLowerCase().includes(exerciseFilter.toLowerCase())) continue;
    const key = set.setGroupId ?? name;
    const group = groups.get(key) ?? { exercise: name, sets: [], volumeLbs: 0 };
    const setVolume = (set.reps ?? 0) * set.weightLbs;
    group.sets.push({
      ...(set.reps !== undefined ? { reps: set.reps } : {}),
      ...(set.duration !== undefined ? { durationSec: set.duration } : {}),
      weight: fromWeightLbs(set.weightLbs, set.weightUnit),
      unit: set.weightUnit,
      ...(set.setLabel && set.setLabel !== "normal" ? { label: set.setLabel } : {}),
    });
    group.volumeLbs += setVolume;
    groups.set(key, group);
    reps += set.reps ?? 0;
    volumeLbs += setVolume;
    setCount += 1;
  }
  return {
    id: session.id,
    date: localDayOf(session.startDate, timeZone),
    start: localTimeOf(session.startDate, timeZone),
    durationMin: Math.round((session.endDate - session.startDate) / 60000),
    ...(session.estimatedEffort != null ? { effort: session.estimatedEffort } : {}),
    exercises: [...groups.values()].map((g) => ({ ...g, volumeLbs: Math.round(g.volumeLbs) })),
    totals: { sets: setCount, reps, volumeLbs: Math.round(volumeLbs) },
  };
}

const setInput = z
  .object({
    reps: z.number().int().min(0).max(1000).optional().describe("Reps (for rep-based exercises)."),
    durationSec: z.number().int().positive().max(86400).optional().describe("Duration in seconds (for timed exercises like planks)."),
    weight: z.number().min(0).max(2000).optional().describe("Weight in the exercise's weightUnit (default lb)."),
    restSec: z.number().int().min(0).max(3600).optional().describe("Rest after the set in seconds (default 120)."),
  })
  .refine((s) => (s.reps === undefined) !== (s.durationSec === undefined), "give exactly one of reps or durationSec");

const exerciseInput = z
  .object({
    presetWorkoutId: z.string().optional().describe("Built-in exercise id, e.g. benchPressBarbell."),
    customExerciseId: z.string().optional().describe("Id of a custom exercise from bevel_get_workout_data."),
    weightUnit: z.enum(["lb", "kg"]).optional().describe("Display unit (weights are stored in lb). Default lb."),
    restTimers: z.boolean().optional().describe("Enable rest timers (default true)."),
    sets: z.array(setInput).min(1).max(50),
  })
  .refine((e) => Boolean(e.presetWorkoutId) !== Boolean(e.customExerciseId), "give exactly one of presetWorkoutId or customExerciseId");

export function registerFitnessTools(server: McpServer, deps: ToolDeps): void {
  const { logger } = deps;

  server.registerTool(
    "bevel_get_workout_data",
    {
      title: "Get Bevel workout routines and custom exercises",
      description:
        "Lists strength routines (exercises, sets, weights) and custom exercises. Deleted items are hidden. " +
        "Completed workouts are listed by bevel_get_workout_history; cardio and exercise notes are only counted.",
      inputSchema: {
        includeDeleted: z.boolean().optional(),
        includeSessions: z
          .boolean()
          .optional()
          .describe("Also return the 2 most recent completed workouts as stored (raw), to help map their format."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_workout_data", logger, async (args) => {
      const workouts = await loadWorkouts(deps);
      const customs = new Map(workouts.customExercises.map((c) => [c.id, c.name]));
      const visible = <T extends { isDeleted: boolean }>(items: T[]) => items.filter((i) => args.includeDeleted || !i.isDeleted);
      return jsonResult({
        routines: visible(workouts.routines).map((r) => ({
          ...summarizeRoutine(r, customs),
          ...(r.isDeleted ? { deleted: true } : {}),
        })),
        customExercises: visible(workouts.customExercises).map((c) => ({
          id: c.id,
          name: c.name,
          equipment: c.equipment,
          defaultExerciseType: c.defaultExerciseType,
          primaryMuscleGroups: c.primaryMuscleGroups,
          secondaryMuscleGroups: c.secondaryMuscleGroups,
          ...(c.isDeleted ? { deleted: true } : {}),
        })),
        counts: workouts.counts,
        ...(args.includeSessions ? { recentSessionsRaw: recentRaw(workouts.sessions, 2) } : {}),
        knownPresetWorkoutIds: [...knownValues(workouts).presets].sort(),
        ...(workouts.truncated ? { truncated: true } : {}),
        ...(workouts.unparsedRoutines.length || workouts.unparsedCustomExercises.length
          ? {
              unparsedRoutines: workouts.unparsedRoutines.slice(0, 1),
              unparsedCustomExercises: workouts.unparsedCustomExercises.slice(0, 1),
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "bevel_get_workout_history",
    {
      title: "Get Bevel completed workouts",
      description:
        "Lists completed strength workouts (most recent first): date, start time, duration, effort, and each exercise's sets " +
        "with reps and weight in the unit you use, plus volume (reps × lb). Filter by date range or exercise name. Read-only.",
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First day (YYYY-MM-DD), inclusive."),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day (YYYY-MM-DD), inclusive."),
        exercise: z.string().optional().describe("Only sets whose exercise id/name contains this, e.g. legPress."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum workouts to return (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_workout_history", logger, async (args) => {
      if (args.from) parseDay(args.from);
      if (args.to) parseDay(args.to);
      const { timeZone } = deps.config;
      const workouts = await loadWorkouts(deps);
      const { items, unparsed } = parseItems(PulledSessionSchema, workouts.sessions);
      const customs = new Map(workouts.customExercises.map((c) => [c.id, c.name]));
      const sessions = items
        .filter((s) => !s.isRemoved)
        .filter((s) => {
          const day = localDayOf(s.startDate, timeZone);
          return (!args.from || day >= args.from) && (!args.to || day <= args.to);
        })
        .sort((a, b) => b.startDate - a.startDate)
        .map((s) => summarizeSession(s, customs, timeZone, args.exercise))
        .filter((s) => !args.exercise || s.totals.sets > 0);
      const limit = args.limit ?? 10;
      return jsonResult({
        timeZone,
        workouts: sessions.slice(0, limit),
        ...(sessions.length > limit ? { more: sessions.length - limit } : {}),
        ...(workouts.truncated ? { truncated: true } : {}),
        ...(unparsed.length ? { unparsedSessions: unparsed.slice(0, 1), unparsedCount: unparsed.length } : {}),
      });
    }),
  );

  server.registerTool(
    "bevel_create_custom_exercise",
    {
      title: "Create a Bevel custom exercise",
      description:
        "Creates a custom exercise (captured shape). Equipment, exercise type and muscle groups must be values Bevel is known " +
        "to use (captured or already in your data) unless allowUnverifiedValues is set. Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: {
        name: z.string().min(1).max(100),
        equipment: z.string().describe("e.g. band"),
        defaultExerciseType: z.string().describe("e.g. reps"),
        primaryMuscleGroups: z.array(z.string()).min(1).describe("e.g. [hipFlexors]"),
        secondaryMuscleGroups: z.array(z.string()).optional().describe("e.g. [calves]"),
        allowUnverifiedValues: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safeHandler("bevel_create_custom_exercise", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const workouts = await loadWorkouts(deps, true);
      const blocked = unsafe(workouts);
      if (blocked) return blocked;
      const known = knownValues(workouts);
      const secondary = args.secondaryMuscleGroups ?? [];
      if (!args.allowUnverifiedValues) {
        if (!known.equipment.has(args.equipment)) return unknownValueError("equipment", [args.equipment], known.equipment);
        if (!known.types.has(args.defaultExerciseType)) {
          return unknownValueError("exercise type", [args.defaultExerciseType], known.types);
        }
        const badMuscles = [...args.primaryMuscleGroups, ...secondary].filter((m) => !known.muscles.has(m));
        if (badMuscles.length) return unknownValueError("muscle group", badMuscles, known.muscles);
      }
      const existing = workouts.customExercises.find((c) => !c.isDeleted && c.name.toLowerCase() === args.name.toLowerCase());
      if (existing) {
        return errorResult(`A custom exercise named "${existing.name}" already exists (id ${existing.id}).`);
      }
      const exercise = buildCustomExercise({
        id: deps.newUuid(),
        name: args.name,
        equipment: args.equipment,
        defaultExerciseType: args.defaultExerciseType,
        primaryMuscleGroups: args.primaryMuscleGroups,
        secondaryMuscleGroups: secondary,
        now: deps.now(),
      });
      return push(deps, { customExercises: [exercise] }, "created", exercise.id, { name: exercise.name }, args.dryRun);
    }),
  );

  server.registerTool(
    "bevel_save_routine",
    {
      title: "Create or replace a Bevel strength routine",
      description:
        "Creates a routine, or (with id) replaces an existing routine's name and exercises — the app also re-sends routines whole. " +
        "Each exercise is a built-in presetWorkoutId or a customExerciseId with sets of reps or durationSec. Supersets are not " +
        "supported yet. Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: {
        id: z.string().optional().describe("Existing routine id to replace; omit to create."),
        name: z.string().min(1).max(100),
        exercises: z.array(exerciseInput).min(1).max(50),
        allowUnverifiedValues: z.boolean().optional().describe("Allow presetWorkoutIds not seen in captures or your data."),
        allowDroppingSupersets: z.boolean().optional().describe("Required to replace a routine that currently has supersets."),
        dryRun: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safeHandler("bevel_save_routine", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const workouts = await loadWorkouts(deps, true);
      const blocked = unsafe(workouts);
      if (blocked) return blocked;
      const known = knownValues(workouts);

      const unknownPresets = args.exercises.map((e) => e.presetWorkoutId).filter((p): p is string => !!p && !known.presets.has(p));
      if (unknownPresets.length && !args.allowUnverifiedValues) {
        return unknownValueError("presetWorkoutId", unknownPresets, known.presets);
      }
      const liveCustoms = new Set(workouts.customExercises.filter((c) => !c.isDeleted).map((c) => c.id));
      const missingCustoms = args.exercises.map((e) => e.customExerciseId).filter((c): c is string => !!c && !liveCustoms.has(c));
      if (missingCustoms.length) {
        return errorResult(`Unknown custom exercise id(s): ${missingCustoms.join(", ")}. See bevel_get_workout_data.`);
      }

      let existing: PulledRoutine | undefined;
      if (args.id) {
        existing = workouts.routines.find((r) => r.id.toLowerCase() === args.id!.toLowerCase() && !r.isDeleted);
        if (!existing) return errorResult(`No routine ${args.id}. See bevel_get_workout_data.`);
        if (existing.setGroups.some((g) => g.superset) && !args.allowDroppingSupersets) {
          return errorResult(
            "This routine has supersets, which this tool cannot write yet; replacing it would remove them. " +
              "Pass allowDroppingSupersets: true to proceed anyway.",
          );
        }
      }
      const routine = buildRoutine({
        name: args.name,
        exercises: args.exercises,
        ...(existing ? { existing } : {}),
        newId: deps.newUuid,
        now: deps.now(),
      });
      const customs = new Map(workouts.customExercises.map((c) => [c.id, c.name]));
      return push(
        deps,
        { strengthWorkoutTemplates: [routine] },
        existing ? "updated" : "created",
        routine.id,
        { routine: summarizeRoutine(PulledRoutineSchema.parse(routine), customs) },
        args.dryRun,
      );
    }),
  );

  server.registerTool(
    "bevel_delete_routine",
    {
      title: "Delete a Bevel strength routine",
      description:
        "Deletes a routine the way the app does (re-sent whole with isDeleted: true). Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: { id: z.string().min(1), dryRun: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_delete_routine", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const workouts = await loadWorkouts(deps, true);
      const blocked = unsafe(workouts);
      if (blocked) return blocked;
      const existing = workouts.routines.find((r) => r.id.toLowerCase() === args.id.toLowerCase());
      if (!existing) return errorResult(`No routine ${args.id}. See bevel_get_workout_data.`);
      if (existing.isDeleted) return jsonResult({ action: "unchanged", written: false, id: existing.id, name: existing.name });
      const routine = buildRoutineDelete(existing, deps.now());
      return push(deps, { strengthWorkoutTemplates: [routine] }, "deleted", routine.id, { name: routine.name }, args.dryRun);
    }),
  );
}
