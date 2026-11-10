import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PulledRoutineSchema,
  buildCustomExercise,
  buildRoutine,
  buildRoutineDelete,
  toWeightLbs,
} from "../src/api/fitness.js";
import { customExercise, fakeApi, harness, routine, session } from "./helpers.js";

function idSeq(prefix = "NEW") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("fitness builders", () => {
  it("builds a custom exercise in the captured shape", () => {
    const exercise = buildCustomExercise({
      id: "X",
      name: "Band Walk",
      equipment: "band",
      defaultExerciseType: "reps",
      primaryMuscleGroups: ["hipFlexors"],
      secondaryMuscleGroups: ["calves"],
      now: 5,
    });
    assert.deepEqual(Object.keys(exercise).sort(), [
      "createdAt",
      "defaultExerciseType",
      "equipment",
      "id",
      "isDeleted",
      "name",
      "primaryMuscleGroups",
      "secondaryMuscleGroups",
      "updatedAt",
    ]);
    assert.equal(exercise.createdAt, exercise.updatedAt);
    assert.equal(exercise.isDeleted, false);
  });

  it("creates a routine: rep sets, timed sets (weightLbs 0, no reps), kg stored as lb", () => {
    const r = buildRoutine({
      name: "Push day",
      exercises: [
        { presetWorkoutId: "benchPressBarbell", sets: [{ reps: 8, weight: 135 }] },
        { presetWorkoutId: "backPlank", sets: [{ durationSec: 60 }] },
        { presetWorkoutId: "latPulldownMachineBehindTheNeck", weightUnit: "kg", sets: [{ reps: 10, weight: 50, restSec: 90 }] },
      ],
      newId: idSeq(),
      now: 1000,
    });
    assert.equal(r.createdAt, 1000);
    assert.equal(r.updatedAt, 1000);
    assert.equal(r.isDeleted, false);
    assert.deepEqual(r.setGroups[0]!.sets[0], { id: "NEW-2", setLabel: "normal", weightLbs: 135, restDuration: 120, reps: 8 });
    assert.deepEqual(r.setGroups[1]!.sets[0], { id: "NEW-4", setLabel: "normal", weightLbs: 0, restDuration: 120, duration: 60 });
    assert.equal(r.setGroups[2]!.weightUnit, "kg");
    assert.equal(r.setGroups[2]!.sets[0]!.weightLbs, toWeightLbs(50, "kg"));
    assert.equal(toWeightLbs(18, "kg"), 39.683159999999994, "the app's exact kg → lb conversion (seen live)");
    assert.equal(toWeightLbs(32, "kg"), 70.54784);
    assert.equal(r.setGroups[2]!.sets[0]!.restDuration, 90);
    assert.equal(r.id, "NEW-7");
  });

  it("updates in place: keeps id/createdAt, reuses group ids for the same exercise at the same position, new set ids", () => {
    const existing = PulledRoutineSchema.parse(routine());
    const r = buildRoutine({
      name: "Renamed",
      exercises: [
        { presetWorkoutId: "abCrunchMachine", sets: [{ reps: 15, weight: 30 }] },
        { presetWorkoutId: "benchDip", sets: [{ reps: 10 }] },
      ],
      existing,
      newId: idSeq(),
      now: 2000,
    });
    assert.equal(r.id, "ROUTINE-1");
    assert.equal(r.createdAt, 1794336633652.281);
    assert.equal(r.updatedAt, 2000);
    assert.equal(r.setGroups[0]!.id, "GROUP-1", "same exercise at same position keeps its group id");
    assert.notEqual(r.setGroups[0]!.sets[0]!.id, "SET-1", "set ids are regenerated");
    assert.notEqual(r.setGroups[1]!.id, "GROUP-2", "a different exercise gets a new group id");
  });

  it("deletes by re-sending the whole routine with isDeleted true", () => {
    const existing = PulledRoutineSchema.parse(routine({ setGroups: [{ ...routine().setGroups[0], superset: { id: "SS", style: "blue" } }] }));
    const deleted = buildRoutineDelete(existing, 3000);
    assert.equal(deleted.isDeleted, true);
    assert.equal(deleted.updatedAt, 3000);
    assert.equal(deleted.createdAt, existing.createdAt);
    assert.deepEqual(deleted.setGroups[0]!.superset, { id: "SS", style: "blue" });
  });
});

describe("fitness tools", () => {
  const writes = { BEVEL_ENABLE_WRITES: "true" };
  const data = () => ({ strengthWorkoutTemplates: [routine(), routine({ id: "GONE", isDeleted: true })], customExercises: [customExercise()] });

  it("bevel_get_workout_data summarizes routines (kg shown in kg) and hides deleted ones", async () => {
    const h = await harness({ responder: fakeApi({ fitnessData: data() }) });
    const out = JSON.parse((await h.call("bevel_get_workout_data")).text);
    assert.deepEqual(out.routines.map((r: any) => r.id), ["ROUTINE-1"]);
    assert.equal(out.routines[0].exercises[1].sets[0].durationSec, 60);
    assert.equal(out.customExercises[0].name, "Test Band Walk");
    assert.equal(out.counts.strengthWorkoutTemplates, 2);
    assert.equal(out.recentSessionsRaw, undefined, "sessions only on request");
    await h.close();
  });

  it("returns the most recent raw sessions on request", async () => {
    const sessions = [{ id: "OLD", startTime: 1 }, { id: "NEW", startTime: 3 }, { id: "MID", startTime: 2 }];
    const h = await harness({ responder: fakeApi({ fitnessData: { ...data(), strengthWorkoutSessions: sessions } }) });
    const out = JSON.parse((await h.call("bevel_get_workout_data", { includeSessions: true })).text);
    assert.deepEqual(out.recentSessionsRaw.map((s: any) => s.id), ["NEW", "MID"]);
    await h.close();
  });

  it("bevel_create_custom_exercise pushes the captured four-collection body", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ fitnessData: data() }) });
    const result = await h.call("bevel_create_custom_exercise", {
      name: "Band Kickback",
      equipment: "band",
      defaultExerciseType: "reps",
      primaryMuscleGroups: ["hipFlexors"],
    });
    assert.ok(!result.isError, result.text);
    const body = JSON.parse(h.calls.find((c) => c.method === "POST")!.body!);
    assert.deepEqual(Object.keys(body).sort(), ["cardioWorkoutTemplates", "customExercises", "strengthWorkoutSessions", "strengthWorkoutTemplates"]);
    assert.equal(body.customExercises[0].name, "Band Kickback");
    assert.equal(JSON.parse(result.text).server.succeeded.length, 1);
    await h.close();
  });

  it("gates unknown enum values and duplicate names", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ fitnessData: data() }) });
    const unknown = await h.call("bevel_create_custom_exercise", {
      name: "X",
      equipment: "kettlebell",
      defaultExerciseType: "reps",
      primaryMuscleGroups: ["hipFlexors"],
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unrecognised equipment: kettlebell/);
    const dup = await h.call("bevel_create_custom_exercise", {
      name: "test band walk",
      equipment: "band",
      defaultExerciseType: "reps",
      primaryMuscleGroups: ["hipFlexors"],
    });
    assert.match(dup.text, /already exists/);
    const allowed = await h.call("bevel_create_custom_exercise", {
      name: "Y",
      equipment: "kettlebell",
      defaultExerciseType: "reps",
      primaryMuscleGroups: ["glutes"],
      allowUnverifiedValues: true,
      dryRun: true,
    });
    assert.ok(!allowed.isError, allowed.text);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
    await h.close();
  });

  it("bevel_save_routine creates with known exercises and custom ids, and refuses unknown ones", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ fitnessData: data() }) });
    const created = await h.call("bevel_save_routine", {
      name: "MCP Test Routine",
      exercises: [
        { presetWorkoutId: "benchPressBarbell", sets: [{ reps: 8, weight: 135 }, { reps: 8, weight: 135 }] },
        { customExerciseId: "CUSTOM-1", sets: [{ reps: 12 }] },
      ],
    });
    assert.ok(!created.isError, created.text);
    const out = JSON.parse(created.text);
    assert.equal(out.action, "created");
    assert.equal(out.routine.exercises[1].exercise, "custom: Test Band Walk");

    const badPreset = await h.call("bevel_save_routine", { name: "x", exercises: [{ presetWorkoutId: "notARealLift", sets: [{ reps: 1 }] }] });
    assert.match(badPreset.text, /Unrecognised presetWorkoutId/);
    const badCustom = await h.call("bevel_save_routine", { name: "x", exercises: [{ customExerciseId: "NOPE", sets: [{ reps: 1 }] }] });
    assert.match(badCustom.text, /Unknown custom exercise/);
    const badSet = await h.call("bevel_save_routine", { name: "x", exercises: [{ presetWorkoutId: "benchDip", sets: [{ weight: 5 }] }] });
    assert.equal(badSet.isError, true);
    await h.close();
  });

  it("bevel_save_routine replaces an existing routine, guarding supersets", async () => {
    const withSuperset = routine({ id: "SS-ROUTINE", setGroups: [{ ...routine().setGroups[0], superset: { id: "S", style: "blue" } }] });
    const h = await harness({ env: writes, responder: fakeApi({ fitnessData: { strengthWorkoutTemplates: [routine(), withSuperset] } }) });
    const updated = await h.call("bevel_save_routine", {
      id: "ROUTINE-1",
      name: "Renamed",
      exercises: [{ presetWorkoutId: "abCrunchMachine", sets: [{ reps: 15 }] }],
    });
    assert.ok(!updated.isError, updated.text);
    const sent = JSON.parse(h.calls.at(-1)!.body!).strengthWorkoutTemplates[0];
    assert.equal(sent.id, "ROUTINE-1");
    assert.equal(sent.createdAt, 1794336633652.281);
    assert.equal(sent.setGroups[0].id, "GROUP-1");

    const guarded = await h.call("bevel_save_routine", {
      id: "SS-ROUTINE",
      name: "x",
      exercises: [{ presetWorkoutId: "abCrunchMachine", sets: [{ reps: 1 }] }],
    });
    assert.match(guarded.text, /supersets/);
    await h.close();
  });

  it("bevel_delete_routine soft-deletes, and refuses when pulled data does not parse", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ fitnessData: data() }) });
    const result = await h.call("bevel_delete_routine", { id: "ROUTINE-1" });
    assert.ok(!result.isError, result.text);
    const sent = JSON.parse(h.calls.at(-1)!.body!).strengthWorkoutTemplates[0];
    assert.equal(sent.isDeleted, true);
    assert.equal(sent.name, "Test routine");
    await h.close();

    const weird = await harness({ env: writes, responder: fakeApi({ fitnessData: { strengthWorkoutTemplates: [{ id: "ROUTINE-1", odd: 1 }] } }) });
    const refused = await weird.call("bevel_delete_routine", { id: "ROUTINE-1" });
    assert.match(refused.text, /does not recognise/);
    assert.equal(weird.calls.filter((c) => c.method === "POST").length, 0);
    await weird.close();
  });

  it("every fitness write is refused without BEVEL_ENABLE_WRITES", async () => {
    const h = await harness({ responder: fakeApi({ fitnessData: data() }) });
    for (const [tool, args] of [
      ["bevel_create_custom_exercise", { name: "x", equipment: "band", defaultExerciseType: "reps", primaryMuscleGroups: ["calves"] }],
      ["bevel_save_routine", { name: "x", exercises: [{ presetWorkoutId: "benchDip", sets: [{ reps: 1 }] }] }],
      ["bevel_delete_routine", { id: "ROUTINE-1" }],
    ] as const) {
      const result = await h.call(tool, args as Record<string, unknown>);
      assert.equal(result.isError, true, tool);
      assert.match(result.text, /BEVEL_ENABLE_WRITES/);
    }
    assert.equal(h.calls.length, 0);
    await h.close();
  });
});

describe("bevel_get_workout_history", () => {
  const sessions = [
    session(),
    session({ id: "OLDER", startDate: Date.parse("2026-11-06T18:00:00Z"), endDate: Date.parse("2026-11-06T18:50:00Z") }),
    session({ id: "REMOVED", isRemoved: true }),
  ];

  it("summarizes completed workouts newest first, grouped by exercise, in the user's units", async () => {
    const h = await harness({
      responder: fakeApi({ fitnessData: { strengthWorkoutSessions: sessions, customExercises: [customExercise()] } }),
    });
    const out = JSON.parse((await h.call("bevel_get_workout_history")).text);
    assert.deepEqual(out.workouts.map((w: any) => w.id), ["SESSION-1", "OLDER"], "removed sessions hidden");
    const latest = out.workouts[0];
    assert.equal(latest.date, "2026-11-10");
    assert.equal(latest.start, "09:00");
    assert.equal(latest.durationMin, 45);
    assert.equal(latest.effort, 7);
    assert.deepEqual(latest.exercises.map((e: any) => e.exercise), ["legPressMachine", "latPulldownCable", "custom: Test Band Walk"]);
    assert.deepEqual(latest.exercises[0].sets, [
      { reps: 12, weight: 205, unit: "lb" },
      { reps: 10, weight: 205, unit: "lb" },
    ]);
    assert.equal(latest.exercises[1].sets[0].weight, 32, "kg sets shown in kg");
    assert.equal(latest.totals.sets, 4);
    assert.equal(latest.totals.reps, 44);
    await h.close();
  });

  it("filters by date range and exercise, and limits", async () => {
    const h = await harness({ responder: fakeApi({ fitnessData: { strengthWorkoutSessions: sessions } }) });
    const ranged = JSON.parse((await h.call("bevel_get_workout_history", { from: "2026-11-01", to: "2026-11-07" })).text);
    assert.deepEqual(ranged.workouts.map((w: any) => w.id), ["OLDER"]);
    const byExercise = JSON.parse((await h.call("bevel_get_workout_history", { exercise: "legpress", limit: 1 })).text);
    assert.equal(byExercise.workouts.length, 1);
    assert.deepEqual(byExercise.workouts[0].exercises.map((e: any) => e.exercise), ["legPressMachine"]);
    assert.equal(byExercise.more, 1);
    await h.close();
  });

  it("surfaces sessions it cannot parse", async () => {
    const h = await harness({ responder: fakeApi({ fitnessData: { strengthWorkoutSessions: [{ id: "x", odd: true }] } }) });
    const out = JSON.parse((await h.call("bevel_get_workout_history")).text);
    assert.equal(out.unparsedCount, 1);
    await h.close();
  });
});
