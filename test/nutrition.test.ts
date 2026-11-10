import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SearchFoodSchema, buildFoodLog, toLoggedFood } from "../src/api/foodMapping.js";
import {
  PulledFoodLogSchema,
  buildFoodLogEdit,
  logNutrients,
  pulledLogNutrients,
  serverLogToPush,
} from "../src/api/nutrition.js";
import { fakeApi, harness, json } from "./helpers.js";

const searchItem = JSON.parse(readFileSync(new URL("./fixtures/food-search-item.json", import.meta.url), "utf8"));
const searchFood = SearchFoodSchema.parse(searchItem.food);
const NOV_10_0815_ET = Date.parse("2026-11-10T13:15:00Z");

function makeLog(overrides: { servings?: number; loggedAt?: number; id?: string } = {}) {
  return buildFoodLog({
    food: toLoggedFood(searchFood, "LOCAL-FOOD"),
    servingId: "fdbserv_test_coffee-1",
    servings: overrides.servings ?? 1,
    loggedAt: overrides.loggedAt ?? NOV_10_0815_ET,
    now: 1794338652908.566,
    ids: { log: overrides.id ?? "LOG-1", compoundFood: "COMPOUND-1", component: "COMPONENT-1" },
  });
}

/** A relative portion as Bevel returns it (explicit nulls), as seen in a live pull. */
const SERVER_ONE_SERVING = {
  portion: {
    standardUnitAmount: null,
    standardUnit: null,
    standardUnitName: null,
    portionDisplayName: "1 serving",
    universalUnit: null,
    count: 1,
    unitString: "servings",
    standardWeight: null,
  },
  ratio: 1,
  servingId: "fdbserv_000_1serving",
};

/** A food log in Bevel's server model (structure as seen in a live pull; values synthetic). */
function serverLog(o: { id?: string; servings?: number; loggedAt?: string; deletedAt?: string; customFoods?: unknown[] } = {}) {
  return {
    id: o.id ?? "LOG-1",
    title: "Test Coffee, brewed",
    loggedAt: o.loggedAt ?? "2026-11-10T13:15:00.000Z",
    imageUrl: null,
    analysisSessionId: null,
    compoundFood: {
      id: "COMPOUND-1",
      name: "Test Coffee, brewed",
      iconName: "coffee",
      foods: [
        {
          id: "COMPONENT-1",
          food: { ...searchItem.food, id: "LOCAL-FOOD" },
          servingDefinition: searchItem.food.defaultServing,
          numServings: 1,
          isBaseFood: true,
        },
      ],
      customFoods: o.customFoods ?? [],
      defaultRelativePortion: SERVER_ONE_SERVING,
      relativePortionOptions: [SERVER_ONE_SERVING],
    },
    numServings: o.servings ?? 1,
    relativePortion: SERVER_ONE_SERVING,
    dataUpdatedAt: "2026-11-10T13:16:00.000Z",
    ...(o.deletedAt ? { deletedAt: o.deletedAt } : {}),
  };
}

describe("search result → logged food (mapping verified against a captured log)", () => {
  const logged = toLoggedFood(searchFood, "LOCAL-FOOD");

  it("renames fields, converts dataUpdatedAt to ms and drops brandName", () => {
    assert.equal(logged.id, "LOCAL-FOOD");
    assert.equal(logged.name, "Test Coffee, brewed");
    assert.equal(logged.iconName, "coffee");
    assert.equal(logged.dataUpdatedAt, Date.parse("2026-11-03T22:25:06.089Z"));
    assert.equal("brandName" in logged, false);
    assert.equal("foodName" in logged, false);
    assert.equal("icon" in logged, false);
  });

  it("maps portions to portionDefinition (standardUnit → standardUnitName, nulls dropped, fdbServingId lifted)", () => {
    assert.deepEqual(logged.defaultServing, {
      portionDefinition: {
        unitString: "cup",
        count: 1,
        portionDisplayName: "1 cup",
        standardUnitName: "g",
        standardUnitAmount: 237,
        standardWeight: 237,
      },
      nutrients: searchFood.defaultServing.nutrients.map((n) => ({ amount: n.amount, nutrientType: n.nutrientType })),
      foodId: "LOCAL-FOOD",
      fdbServingId: "fdbserv_test_coffee-1",
    });
    const flOz = logged.servingOptions.find((s) => s.fdbServingId === "fdbserv_000_1fl-oz")!;
    assert.deepEqual(flOz.portionDefinition, { unitString: "fl oz", count: 1, portionDisplayName: "1 fl oz" });
  });

  it("sorts servingOptions by fdbServingId, as the app does", () => {
    assert.deepEqual(
      logged.servingOptions.map((s) => s.fdbServingId),
      ["fdbserv_000_100g", "fdbserv_000_1fl-oz", "fdbserv_test_coffee-1"],
    );
  });
});

describe("buildFoodLog", () => {
  it("wraps the food in the captured single-food structure", () => {
    const log = makeLog({ servings: 2 });
    assert.equal(log.id, "LOG-1");
    assert.equal(log.title, "Test Coffee, brewed");
    assert.equal(log.numServings, 2);
    assert.equal(log.loggedAt, NOV_10_0815_ET);
    assert.deepEqual(log.relativePortion, {
      ratio: 1,
      servingId: "fdbserv_000_1serving",
      portion: { unitString: "servings", count: 1, portionDisplayName: "1 serving" },
    });
    assert.deepEqual(Object.keys(log.compoundFood).sort(), [
      "components",
      "customComponents",
      "defaultRelativePortion",
      "iconName",
      "id",
      "name",
      "relativePortionOptions",
    ]);
    const [component] = log.compoundFood.components;
    assert.deepEqual(
      { id: component!.id, compoundFoodId: component!.compoundFoodId, isBaseFood: component!.isBaseFood, numServings: component!.numServings },
      { id: "COMPONENT-1", compoundFoodId: "COMPOUND-1", isBaseFood: true, numServings: 1 },
    );
    assert.equal(component!.serving.fdbServingId, "fdbserv_test_coffee-1");
  });

  it("rejects a serving the food does not offer", () => {
    assert.throws(() =>
      buildFoodLog({
        food: toLoggedFood(searchFood, "F"),
        servingId: "nope",
        servings: 1,
        loggedAt: 1,
        now: 1,
        ids: { log: "a", compoundFood: "b", component: "c" },
      }),
    );
  });

  it("totals nutrients across servings (2 cups → 190 mg caffeine)", () => {
    const totals = logNutrients(makeLog({ servings: 2 }));
    assert.equal(totals.caffeine, 190);
    assert.equal(totals.calories, 4);
  });
});

describe("pulled food logs (server model)", () => {
  const pulled = PulledFoodLogSchema.parse(serverLog());

  it("parses the server model and its ISO timestamps", () => {
    assert.equal(pulled.loggedAt, NOV_10_0815_ET);
    assert.equal(pulled.compoundFood.foods[0]!.food.fdbId, "fdb_test_coffee");
  });

  it("round-trips: a stored log converts back to exactly the push the app (and this tool) sends", () => {
    const now = 1794338652908.566;
    assert.deepEqual(serverLogToPush(pulled, now), makeLog());
  });

  it("totals nutrients from servingDefinition × servings", () => {
    assert.equal(pulledLogNutrients(PulledFoodLogSchema.parse(serverLog({ servings: 2 }))).caffeine, 190);
    assert.deepEqual(pulledLogNutrients(pulled), logNutrients(makeLog()));
  });

  it("edits and soft-deletes in push form: deletedAt = dataUpdatedAt, nulls dropped from portions", () => {
    const deleted = buildFoodLogEdit(pulled, { delete: true }, 1794338702459.289);
    assert.equal(deleted.deletedAt, 1794338702459.289);
    assert.equal(deleted.dataUpdatedAt, 1794338702459.289);
    assert.equal(deleted.loggedAt, NOV_10_0815_ET, "timestamps go back as ms numbers");
    assert.deepEqual(deleted.relativePortion.portion, { unitString: "servings", count: 1, portionDisplayName: "1 serving" });
    assert.equal("foods" in deleted.compoundFood, false);
    assert.equal("imageUrl" in deleted, false);

    const edited = buildFoodLogEdit(pulled, { servings: 2 }, 5);
    assert.equal(edited.numServings, 2);
    assert.equal("deletedAt" in edited, false);
  });

  it("refuses to rebuild logs that contain custom foods", () => {
    assert.throws(() => serverLogToPush(PulledFoodLogSchema.parse(serverLog({ customFoods: [{ name: "x" }] })), 1), /custom foods/);
  });
});

describe("nutrition tools", () => {
  const writes = { BEVEL_ENABLE_WRITES: "true" };
  const searchResults = { genericFoods: [searchItem], brandedFoods: [searchItem] };

  it("bevel_search_food sends the app's two searches and summarizes caffeine per serving", async () => {
    const h = await harness({ responder: fakeApi({ searchResults }) });
    const out = JSON.parse((await h.call("bevel_search_food", { query: "coffee" })).text);
    const bodies = h.calls.map((c) => JSON.parse(c.body!));
    assert.deepEqual(bodies.map((b) => b.category), ["common", "branded"]);
    assert.deepEqual(Object.keys(bodies[0]).sort(), ["category", "language", "offset", "query", "recentFdbIds", "source", "take"]);
    assert.equal(bodies[0].take, 5);
    assert.equal(out.results.length, 1, "deduplicated by fdbId");
    assert.equal(out.results[0].perDefaultServing.caffeine, 95);
    assert.equal(out.results[0].defaultServing.label, "1 cup");
    await h.close();
  });

  it("bevel_log_food is refused without writes, before any request", async () => {
    const h = await harness({ responder: fakeApi({ searchResults }) });
    const result = await h.call("bevel_log_food", { fdbId: "fdb_test_coffee", query: "coffee" });
    assert.equal(result.isError, true);
    assert.equal(h.calls.length, 0);
    await h.close();
  });

  it("bevel_log_food logs a searched food at a local time and verifies the id", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ searchResults }) });
    await h.call("bevel_search_food", { query: "coffee" });
    const result = await h.call("bevel_log_food", { fdbId: "fdb_test_coffee", servings: 2, date: "2026-11-10", time: "08:15" });
    assert.ok(!result.isError, result.text);
    const push = h.calls.find((c) => new URL(c.url).pathname === "/api/nutrition/v2/user-food-data/push")!;
    const body = JSON.parse(push.body!);
    assert.deepEqual(Object.keys(body).sort(), ["compoundFoodFavorites", "customFoods", "foodLogs", "recipes"]);
    const log = body.foodLogs[0];
    assert.equal(log.loggedAt, NOV_10_0815_ET);
    assert.equal(log.numServings, 2);
    assert.equal(log.compoundFood.components[0].food.fdbId, "fdb_test_coffee");
    const out = JSON.parse(result.text);
    assert.equal(out.written, true);
    assert.equal(out.time, "08:15");
    assert.equal(out.nutrients.caffeine, 190);
    await h.close();
  });

  it("bevel_log_food re-searches when the food is not cached, and errors when it cannot be found", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ searchResults }) });
    const dry = await h.call("bevel_log_food", { fdbId: "fdb_test_coffee", query: "coffee", dryRun: true });
    assert.ok(!dry.isError, dry.text);
    const out = JSON.parse(dry.text);
    assert.equal(out.dryRun, true);
    assert.match(out.request.foodLog.compoundFood.components[0].food.servingOptions, /3 serving options/);
    assert.equal(h.calls.filter((c) => new URL(c.url).pathname.endsWith("/push")).length, 0);
    const missing = await h.call("bevel_log_food", { fdbId: "fdb_unknown", dryRun: true });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /bevel_search_food first/);
    await h.close();
  });

  it("bevel_get_food_logs lists the day's logs with totals and hides deleted ones", async () => {
    const pulledLogs = [
      serverLog({ id: "A", servings: 2 }),
      serverLog({ id: "B", deletedAt: "2026-11-10T19:25:02.459Z" }),
      serverLog({ id: "OTHER-DAY", loggedAt: "2026-11-09T13:15:00.000Z" }),
    ];
    const h = await harness({ responder: fakeApi({ foodLogs: pulledLogs }) });
    const out = JSON.parse((await h.call("bevel_get_food_logs", { date: "2026-11-10" })).text);
    const pull = new URL(h.calls[0]!.url);
    assert.equal(pull.searchParams.get("language"), "en");
    assert.equal(pull.searchParams.get("limit"), "30");
    assert.deepEqual(out.logs.map((l: any) => l.id), ["A"]);
    assert.equal(out.logs[0].time, "08:15");
    assert.equal(out.totals.caffeine, 190);
    await h.close();
  });

  it("bevel_update_food_log and bevel_delete_food_log re-push the same id", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ foodLogs: [serverLog({ id: "A" })] }) });
    const updated = await h.call("bevel_update_food_log", { id: "A", date: "2026-11-10", servings: 3, time: "09:00" });
    assert.ok(!updated.isError, updated.text);
    const sentUpdate = JSON.parse(h.calls.at(-1)!.body!).foodLogs[0];
    assert.equal(sentUpdate.id, "A");
    assert.equal(sentUpdate.numServings, 3);
    assert.equal(sentUpdate.loggedAt, Date.parse("2026-11-10T14:00:00Z"));

    const deleted = await h.call("bevel_delete_food_log", { id: "A", date: "2026-11-10" });
    assert.ok(!deleted.isError, deleted.text);
    const sentDelete = JSON.parse(h.calls.at(-1)!.body!).foodLogs[0];
    assert.equal(sentDelete.id, "A");
    assert.equal(sentDelete.deletedAt, sentDelete.dataUpdatedAt);
    assert.equal(sentDelete.compoundFood.components[0].food.name, "Test Coffee, brewed", "sent in the app's push form");
    await h.close();
  });

  it("refuses to edit a log containing custom foods", async () => {
    const h = await harness({ env: writes, responder: fakeApi({ foodLogs: [serverLog({ id: "C", customFoods: [{ name: "x" }] })] }) });
    const result = await h.call("bevel_delete_food_log", { id: "C", date: "2026-11-10" });
    assert.equal(result.isError, true);
    assert.match(result.text, /custom foods/);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
    await h.close();
  });

  it("refuses to edit when pulled logs do not parse, and reports unknown ids", async () => {
    const weird = await harness({ env: writes, responder: fakeApi({ foodLogs: [{ id: "A", odd: true }] }) });
    const refused = await weird.call("bevel_delete_food_log", { id: "A", date: "2026-11-10" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /does not recognise/);
    await weird.close();

    const none = await harness({ env: writes, responder: fakeApi({ foodLogs: [] }) });
    const missing = await none.call("bevel_delete_food_log", { id: "NOPE", date: "2026-11-10" });
    assert.match(missing.text, /No food log NOPE/);
    assert.equal(none.calls.filter((c) => c.method === "POST").length, 0);
    await none.close();
  });

  it("reports a food push the server does not confirm", async () => {
    const h = await harness({
      env: writes,
      responder: fakeApi({
        searchResults,
        push: (_body, path) => (path.endsWith("user-food-data/push") ? json({ foodLogs: { succeeded: [], failed: [] } }) : undefined),
      }),
    });
    const result = await h.call("bevel_log_food", { fdbId: "fdb_test_coffee", query: "coffee" });
    assert.equal(result.isError, true);
    assert.match(result.text, /did not confirm/);
    await h.close();
  });
});
