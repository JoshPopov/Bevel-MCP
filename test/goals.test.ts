import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PulledMacroGoalSchema, activeGoalOn, caloriesFromMacros, planGoalChange } from "../src/api/goals.js";
import { addDays } from "../src/time.js";
import { fakeApi, goal, harness, json } from "./helpers.js";

const parse = (g: unknown) => PulledMacroGoalSchema.parse(g);

describe("macro goal logic", () => {
  it("derives calories with 4/4/9 (matches both captured goals)", () => {
    assert.equal(caloriesFromMacros(142.5, 190, 63.33333206176758), 1900);
    assert.equal(caloriesFromMacros(180, 180, 40), 1800);
  });

  it("does calendar arithmetic across month and year ends", () => {
    assert.equal(addDays("2026-11-10", -1), "2026-11-09");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  });

  it("finds the goal active on a day, ignoring ended ones", () => {
    const goals = [goal({ id: "OLD", effectiveStartDate: { year: 2026, month: 1, day: 1 }, endDate: { year: 2026, month: 6, day: 30 } }), goal()].map(parse);
    assert.equal(activeGoalOn(goals, "2026-11-10")?.id, "GOAL-ACTIVE");
    assert.equal(activeGoalOn(goals, "2026-03-01")?.id, "OLD");
    assert.equal(activeGoalOn(goals, "2025-12-31"), undefined);
  });

  it("ends the active goal yesterday and starts a new one today when it began earlier", () => {
    const plan = planGoalChange({
      goals: [parse(goal())],
      today: "2026-11-10",
      targets: { calories: 1800, proteinG: 180, carbsG: 180, fatG: 40 },
      newId: "NEW-ID",
      now: 1794338777425,
    });
    assert.equal(plan.action, "replaced");
    const [ended, next] = plan.goals;
    assert.equal(ended.id, "GOAL-ACTIVE");
    assert.deepEqual(ended.endDate, { year: 2026, month: 11, day: 9 });
    assert.equal(ended.caloriesGoal.value, 2000, "the ended goal keeps its values");
    assert.equal(ended.updatedAt, 1794338777425);
    assert.deepEqual(next, {
      id: "NEW-ID",
      type: "custom",
      caloriesGoal: { value: 1800, unit: "kcal" },
      proteinGoal: { value: 180, unit: "grams" },
      carbsGoal: { value: 180, unit: "grams" },
      fatsGoal: { value: 40, unit: "grams" },
      totalDailyEnergyExpenditure: { value: 2500, unit: "kcal" },
      effectiveStartDate: { year: 2026, month: 11, day: 10 },
      updatedAt: 1794338777425,
    });
    assert.equal("endDate" in next, false, "the new goal has no endDate key");
  });

  it("updates in place when the active goal already starts today", () => {
    const plan = planGoalChange({
      goals: [parse(goal({ id: "TODAY", effectiveStartDate: { year: 2026, month: 11, day: 10 } }))],
      today: "2026-11-10",
      targets: { calories: 1800, proteinG: 180, carbsG: 180, fatG: 40 },
      newId: "UNUSED",
      now: 1,
    });
    assert.equal(plan.action, "updated");
    assert.equal(plan.goals.length, 1);
    assert.equal(plan.goals[0].id, "TODAY");
    assert.equal(plan.goals[0].fatsGoal.value, 40);
  });

  it("refuses when there is no active goal (TDEE unknown)", () => {
    assert.throws(
      () => planGoalChange({ goals: [], today: "2026-11-10", targets: { calories: 1, proteinG: 1, carbsG: 0, fatG: 0 }, newId: "x", now: 1 }),
      /no active macro goal/,
    );
  });
});

describe("goal tools", () => {
  it("bevel_get_macro_goals marks the active goal", async () => {
    const h = await harness({ responder: fakeApi({ goals: [goal()] }) });
    const out = JSON.parse((await h.call("bevel_get_macro_goals", { date: "2026-11-10" })).text);
    assert.equal(out.active.id, "GOAL-ACTIVE");
    assert.equal(out.active.calories, 2000);
    assert.equal(out.goals[0].active, true);
    await h.close();
  });

  it("bevel_set_macro_goals dry run shows the end + new push and sends nothing", async () => {
    const h = await harness({ responder: fakeApi({ goals: [goal()] }) });
    const result = await h.call("bevel_set_macro_goals", { proteinG: 180, carbsG: 180, fatG: 40, dryRun: true });
    assert.ok(!result.isError, result.text);
    const out = JSON.parse(result.text);
    assert.equal(out.action, "replaced");
    assert.equal(out.new.calories, 1800);
    assert.equal(out.request.body.macronutrientGoals.length, 2);
    assert.deepEqual(h.calls.map((c) => c.method), ["GET"]);
    await h.close();
  });

  it("writes when enabled and verifies both ids", async () => {
    const h = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: fakeApi({ goals: [goal()] }) });
    const result = await h.call("bevel_set_macro_goals", { proteinG: 180, carbsG: 180, fatG: 40 });
    assert.ok(!result.isError, result.text);
    const push = h.calls.find((c) => c.method === "POST")!;
    assert.equal(new URL(push.url).pathname, "/api/nutrition/v1/macronutrient-goals/push");
    assert.equal(JSON.parse(result.text).server.succeeded.length, 2);
    await h.close();
  });

  it("checks fresh state after a partial push and guides recovery when no active goal remains", async () => {
    let records = [goal({ effectiveStartDate: { year: 2020, month: 1, day: 1 } })];
    const h = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: (call) => {
      if (call.method === "GET") return json({ moreAvailable: false, offset: 100, macronutrientGoals: records });
      const [ended, next] = JSON.parse(call.body!).macronutrientGoals;
      records = [ended];
      return json({ macronutrientGoals: { succeeded: [ended.id], failed: [next.id] } });
    } });
    try {
      const result = await h.call("bevel_set_macro_goals", { proteinG: 180, carbsG: 180, fatG: 40 });
      assert.equal(result.isError, true);
      assert.match(result.text, /Set an active goal in Bevel before retrying/);
      assert.match(result.text, /"previousEnded": true/);
      assert.deepEqual(h.calls.map((call) => call.method), ["GET", "POST", "GET"]);
    } finally {
      await h.close();
    }
  });

  it("is a no-op when the values are unchanged, refused without writes, and refuses unknown shapes", async () => {
    const same = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: fakeApi({ goals: [goal()] }) });
    const out = JSON.parse((await same.call("bevel_set_macro_goals", { proteinG: 150, carbsG: 200, fatG: 66.67, calories: 2000 })).text);
    assert.equal(out.action, "unchanged");
    await same.close();

    const off = await harness({ responder: fakeApi({ goals: [goal()] }) });
    assert.equal((await off.call("bevel_set_macro_goals", { proteinG: 1, carbsG: 1, fatG: 1 })).isError, true);
    assert.equal(off.calls.length, 0);
    await off.close();

    const weird = await harness({ env: { BEVEL_ENABLE_WRITES: "true" }, responder: fakeApi({ goals: [{ id: "x", calories: 5 }] }) });
    const refused = await weird.call("bevel_set_macro_goals", { proteinG: 1, carbsG: 1, fatG: 1 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /does not recognise/);
    assert.equal(weird.calls.filter((c) => c.method === "POST").length, 0);
    await weird.close();
  });
});
