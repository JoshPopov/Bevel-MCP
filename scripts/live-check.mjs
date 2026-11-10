/**
 * Live check against your real Bevel account, through the built MCP server over stdio.
 * Read-only unless you pass --write AND set BEVEL_ENABLE_WRITES=true.
 * The default output is a shareable summary. --show-private-output prints tool results locally.
 *
 *   npm run live-check -- --suite journal --date 2026-11-10 [--factor addedSugar --value true] [--clear] [--write --keep]
 *   npm run live-check -- --suite goals [--protein 180 --carbs 180 --fat 40] [--write --keep]
 *   npm run live-check -- --suite meals [--food "brewed coffee"] [--write [--keep]]
 *        --write: log, read back, edit to 2 servings, read back, delete (--keep: stop after logging)
 *   npm run live-check -- --suite workouts [--sessions] [--write [--keep]]
 *        --write: create a test routine, read back, replace it, read back, delete (--keep: don't delete)
 *
 * Journal and goal changes are persistent. Meals and workouts attempt cleanup unless --keep.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: opts } = parseArgs({
  options: {
    suite: { type: "string", default: "journal" },
    date: { type: "string" },
    factor: { type: "string", default: "addedSugar" },
    value: { type: "string", default: "true" },
    clear: { type: "boolean", default: false },
    protein: { type: "string" },
    carbs: { type: "string" },
    fat: { type: "string" },
    food: { type: "string", default: "brewed coffee" },
    write: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    sessions: { type: "boolean", default: false },
    "show-private-output": { type: "boolean", default: false },
  },
});
const SUITES = ["journal", "goals", "meals", "workouts"];
if (!SUITES.includes(opts.suite)) throw new Error(`--suite must be one of ${SUITES.join(", ")}`);
const timeZone = process.env.BEVEL_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
const date = opts.date ?? today;

if (opts.write && process.env.BEVEL_ENABLE_WRITES !== "true") {
  console.error("--write needs BEVEL_ENABLE_WRITES=true as well.");
  process.exit(2);
}
if (opts.write && ["journal", "goals"].includes(opts.suite) && !opts.keep) {
  console.error("Journal and macro-goal writes are persistent. Pass --keep to confirm.");
  process.exit(2);
}
if (!["true", "false"].includes(opts.value)) {
  console.error("--value must be true or false.");
  process.exit(2);
}
if (opts.write && opts.suite === "goals" && !(opts.protein && opts.carbs && opts.fat)) {
  console.error("A macro-goal write needs --protein, --carbs and --fat.");
  process.exit(2);
}

const client = new Client({ name: "live-check", version: "1.0.0" });
let failures = 0;

async function step(title, tool, args, check) {
  let result;
  try {
    result = await client.callTool({ name: tool, arguments: args });
  } catch {
    failures++;
    console.log(`✗ ${title} — MCP request failed`);
    return undefined;
  }
  const text = result.content.map((c) => c.text ?? "").join("\n");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // The default report only contains static labels and status messages.
  }
  const problem = result.isError
    ? "tool returned an error"
    : !data || typeof data !== "object"
      ? "unexpected tool output"
      : check?.(data);
  if (problem) failures++;
  console.log(`${problem ? "✗" : "✓"} ${title}${problem ? ` — ${problem}` : ""}`);
  if (opts["show-private-output"]) {
    console.log(`  ${tool} ${JSON.stringify(args)}`);
    console.log(text.replace(/^/gm, "  "));
  }
  return problem ? undefined : data;
}

function incomplete(result) {
  return result.truncated || result.unparsedCount ? "incomplete or unrecognised records" : undefined;
}

async function journalSuite() {
  const value = opts.value === "true";
  const tool = opts.clear ? "bevel_clear_journal_boolean" : "bevel_set_journal_boolean";
  const args = { factorKey: opts.factor, date, ...(opts.clear ? {} : { value }) };
  const before = await step("Read Journal entries", "bevel_get_journal", { date, factorKey: opts.factor }, incomplete);
  if (!before) return;
  const dryRun = await step("Preview Journal change", tool, { ...args, dryRun: true });
  if (!opts.write || !dryRun) return;

  const written = await step("Apply persistent Journal change", tool, args);
  if (!written) {
    console.log("Check Journal in Bevel before retrying.");
    return;
  }
  await step("Verify Journal change", "bevel_get_journal", { date, factorKey: opts.factor }, (r) => {
    if (incomplete(r)) return incomplete(r);
    const entry = r.booleanJournals?.find((e) => e.factorKey === opts.factor);
    if (opts.clear) return entry && entry.value !== null ? "factor is still set" : undefined;
    if (!entry || entry.value !== value) return "factor does not match the requested value";
    return written.uuid && entry.uuid !== written.uuid ? "a different record was returned" : undefined;
  });
}

async function goalsSuite() {
  const before = await step("Read macro goals", "bevel_get_macro_goals", {}, (r) =>
    incomplete(r) ?? (!r.active ? "no active goal" : undefined));
  if (!before) return;
  if (!(opts.protein && opts.carbs && opts.fat)) {
    console.log("Pass --protein, --carbs and --fat to preview a goal change.");
    return;
  }
  const targets = { proteinG: Number(opts.protein), carbsG: Number(opts.carbs), fatG: Number(opts.fat) };
  const dryRun = await step("Preview macro-goal change", "bevel_set_macro_goals", { ...targets, dryRun: true });
  if (!opts.write || !dryRun) return;

  const written = await step("Apply persistent macro-goal change", "bevel_set_macro_goals", targets);
  if (!written) {
    console.log("Check the goal timeline in Bevel before retrying.");
    return;
  }
  await step("Verify active macro goal", "bevel_get_macro_goals", {}, (r) =>
    incomplete(r) ?? (r.active && Object.entries(targets).every(([key, value]) => r.active[key] === value)
      ? undefined
      : "active goal does not match the requested targets"));
}

async function mealsSuite() {
  const search = await step("Search food database", "bevel_search_food", { query: opts.food }, (r) =>
    r.results?.[0]?.fdbId ? undefined : "no usable results");
  const before = await step("Read food logs", "bevel_get_food_logs", { date }, incomplete);
  if (!search || !before) return;
  const args = { fdbId: search.results[0].fdbId, query: opts.food };
  const dryRun = await step("Preview test food log", "bevel_log_food", { ...args, dryRun: true });
  if (!opts.write || !dryRun) return;

  const logged = await step("Create test food log", "bevel_log_food", args, (r) =>
    r.id && r.day ? undefined : "missing log ID or day");
  if (!logged) {
    console.log("Check Nutrition in Bevel for the test log before retrying.");
    return;
  }
  const lookup = { date: logged.day };
  const edit = { ...lookup, id: logged.id };
  const findLog = (r) => r.logs?.find((log) => log.id === logged.id);
  try {
    const read = await step("Read back test log", "bevel_get_food_logs", lookup, (r) =>
      incomplete(r) ?? (!findLog(r) ? "test log is missing" : undefined));
    if (opts.keep || !read) return;
    const updated = await step("Edit test log servings", "bevel_update_food_log", { ...edit, servings: 2 });
    if (updated) {
      await step("Verify test log edit", "bevel_get_food_logs", lookup, (r) =>
        incomplete(r) ?? (findLog(r)?.servings !== 2 ? "test log does not show the updated servings" : undefined));
    }
  } finally {
    if (opts.keep) {
      console.log("Test log kept. You can remove it in Bevel’s Nutrition log.");
    } else {
      const deleted = await step("Delete test log", "bevel_delete_food_log", edit);
      const verified = await step("Verify test log cleanup", "bevel_get_food_logs", lookup, (r) =>
        incomplete(r) ?? (!Array.isArray(r.logs) || findLog(r) ? "test log removal could not be confirmed" : undefined));
      if (!deleted || !verified) console.log("Cleanup could not be confirmed. Check Nutrition in Bevel before retrying.");
    }
  }
}

async function workoutsSuite() {
  const workoutIncomplete = (r) =>
    incomplete(r) ?? (r.unparsedRoutines?.length || r.unparsedCustomExercises?.length ? "unrecognised workout records" : undefined);
  const before = await step("Read routines and custom exercises", "bevel_get_workout_data",
    opts.sessions ? { includeSessions: true } : {}, workoutIncomplete);
  const history = await step("Read recent completed workouts", "bevel_get_workout_history", { limit: 2 }, incomplete);
  if (!before || !history) return;
  const routine = {
    name: "MCP Test Routine",
    exercises: [
      { presetWorkoutId: "benchPressBarbell", sets: [{ reps: 8, weight: 45 }, { reps: 8, weight: 45 }] },
      { presetWorkoutId: "backPlank", sets: [{ durationSec: 45 }] },
    ],
  };
  const dryRun = await step("Preview test routine", "bevel_save_routine", { ...routine, dryRun: true });
  if (!opts.write || !dryRun) return;

  const created = await step("Create test routine", "bevel_save_routine", routine, (r) =>
    r.id ? undefined : "missing routine ID");
  if (!created) {
    console.log("Check Workouts in Bevel for the test routine before retrying.");
    return;
  }
  const findRoutine = (r) => r.routines?.find((entry) => entry.id === created.id);
  try {
    const read = await step("Read back test routine", "bevel_get_workout_data", {}, (r) =>
      workoutIncomplete(r) ?? (!findRoutine(r) ? "test routine is missing" : undefined));
    if (!read) return;
    const replacement = {
      id: created.id,
      name: "MCP Test Routine (edited)",
      exercises: [
        { presetWorkoutId: "benchPressBarbell", sets: Array.from({ length: 3 }, () => ({ reps: 5, weight: 50 })) },
        { presetWorkoutId: "backPlank", sets: [{ durationSec: 60 }] },
      ],
    };
    const updated = await step("Replace test routine", "bevel_save_routine", replacement);
    if (updated) {
      await step("Verify test routine edit", "bevel_get_workout_data", {}, (r) => {
        if (workoutIncomplete(r)) return workoutIncomplete(r);
        const edited = findRoutine(r);
        const bench = edited?.exercises?.[0]?.sets;
        const plank = edited?.exercises?.[1]?.sets?.[0];
        return edited?.name === replacement.name && bench?.length === 3 &&
          bench.every((set) => set.reps === 5 && set.weight === 50) && plank?.durationSec === 60
          ? undefined
          : "test routine does not match the replacement";
      });
    }
  } finally {
    if (opts.keep) {
      console.log("Test routine kept. You can remove it in Bevel’s Workouts.");
    } else {
      const deleted = await step("Delete test routine", "bevel_delete_routine", { id: created.id });
      const verified = await step("Verify test routine cleanup", "bevel_get_workout_data", {}, (r) =>
        workoutIncomplete(r) ?? (!Array.isArray(r.routines) || findRoutine(r) ? "test routine removal could not be confirmed" : undefined));
      if (!deleted || !verified) console.log("Cleanup could not be confirmed. Check Workouts in Bevel before retrying.");
    }
  }
}

try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env },
    stderr: opts["show-private-output"] ? "inherit" : "ignore",
  }));
  const auth = await step("Verify Bevel token", "bevel_auth_status", { checkApi: true }, (s) =>
    s.sourceReadable && !s.claims?.expired && s.api?.ok ? undefined : "run bevel-mcp doctor for token or connection checks");
  if (auth) await { journal: journalSuite, goals: goalsSuite, meals: mealsSuite, workouts: workoutsSuite }[opts.suite]();
} catch {
  failures++;
  console.error("The live check could not complete. Run bevel-mcp doctor.");
} finally {
  await client.close();
}
console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
process.exitCode = failures ? 1 : 0;
