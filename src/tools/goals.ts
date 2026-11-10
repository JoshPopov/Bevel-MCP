import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GOALS_PATHS,
  GOALS_PULL_PAGE_SIZE,
  PulledMacroGoalSchema,
  activeGoalOn,
  caloriesFromMacros,
  fromCalendarDate,
  planGoalChange,
  type PulledMacroGoal,
} from "../api/goals.js";
import { parseItems } from "../api/pull.js";
import { BevelError, BevelHttpError, BevelNetworkError, BevelPushError } from "../http/errors.js";
import { addDays, parseDay, todayInTimeZone } from "../time.js";
import { describeError, errorResult, jsonResult, requireWrites, safeHandler, type ToolDeps } from "./shared.js";

function summarizeGoal(goal: PulledMacroGoal, activeId: string | undefined) {
  return {
    id: goal.id,
    type: goal.type,
    start: fromCalendarDate(goal.effectiveStartDate),
    end: goal.endDate ? fromCalendarDate(goal.endDate) : null,
    calories: goal.caloriesGoal.value,
    proteinG: goal.proteinGoal.value,
    carbsG: goal.carbsGoal.value,
    fatG: goal.fatsGoal.value,
    ...(goal.totalDailyEnergyExpenditure ? { tdeeKcal: goal.totalDailyEnergyExpenditure.value } : {}),
    ...(goal.id === activeId ? { active: true } : {}),
  };
}

async function loadGoals(deps: ToolDeps, fresh = false) {
  const pulled = await deps.goals.pullGoals({ lastSyncDate: 0, limit: GOALS_PULL_PAGE_SIZE, maxPages: 20, fresh });
  const { items, unparsed } = parseItems(PulledMacroGoalSchema, pulled.goals);
  return { goals: items, unparsed, truncated: pulled.truncated };
}

export function registerGoalTools(server: McpServer, deps: ToolDeps): void {
  const { logger } = deps;

  server.registerTool(
    "bevel_get_macro_goals",
    {
      title: "Get Bevel macro goals",
      description:
        "Lists calorie/protein/carb/fat goals (each with a start and optional end date) and marks the one active on the given day.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day to evaluate (YYYY-MM-DD). Defaults to today."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_get_macro_goals", logger, async (args) => {
      const day = args.date ?? todayInTimeZone(deps.config.timeZone, Date.now());
      parseDay(day);
      const { goals, unparsed, truncated } = await loadGoals(deps);
      const active = activeGoalOn(goals, day);
      return jsonResult({
        day,
        active: active ? summarizeGoal(active, active.id) : null,
        goals: goals
          .slice()
          .sort((a, b) => fromCalendarDate(b.effectiveStartDate).localeCompare(fromCalendarDate(a.effectiveStartDate)))
          .map((g) => summarizeGoal(g, active?.id)),
        ...(truncated ? { truncated: true } : {}),
        ...(unparsed.length ? { unparsedGoals: unparsed.slice(0, 3), unparsedCount: unparsed.length } : {}),
      });
    }),
  );

  server.registerTool(
    "bevel_set_macro_goals",
    {
      title: "Set Bevel macro goals",
      description:
        "Sets daily calorie and macro goals from today on, exactly like the app: if the current goal started before today it " +
        "is ended yesterday and a new goal starts today; if it already started today it is updated in place. " +
        "Calories default to 4×protein + 4×carbs + 9×fat. Requires BEVEL_ENABLE_WRITES=true unless dryRun is set.",
      inputSchema: {
        proteinG: z.number().positive().max(1000).describe("Daily protein goal in grams."),
        carbsG: z.number().min(0).max(2000).describe("Daily carbohydrate goal in grams."),
        fatG: z.number().min(0).max(1000).describe("Daily fat goal in grams."),
        calories: z.number().positive().max(20000).optional().describe("Daily calories. Defaults to 4P + 4C + 9F."),
        dryRun: z.boolean().optional().describe("If true, return the exact request without sending it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeHandler("bevel_set_macro_goals", logger, async (args) => {
      requireWrites(deps.config, args.dryRun);
      const today = todayInTimeZone(deps.config.timeZone, Date.now());
      const computed = caloriesFromMacros(args.proteinG, args.carbsG, args.fatG);
      const calories = args.calories ?? computed;
      const warnings: string[] = [];
      if (args.calories !== undefined && Math.abs(args.calories - computed) / computed > 0.05) {
        warnings.push(`Calories (${args.calories}) differ by more than 5% from 4P+4C+9F (${computed}).`);
      }

      const { goals, unparsed, truncated } = await loadGoals(deps, true);
      if (truncated) throw new BevelError("Could not read all macro goals, so nothing was written.");
      if (unparsed.length) {
        return errorResult(
          "Pulled macro goals have a shape this client does not recognise, so it cannot safely change them. Nothing was written.",
          { sample: unparsed.slice(0, 2), unparsedCount: unparsed.length },
        );
      }
      let plan;
      try {
        plan = planGoalChange({
          goals,
          today,
          targets: { calories, proteinG: args.proteinG, carbsG: args.carbsG, fatG: args.fatG },
          newId: deps.newUuid(),
          now: deps.now(),
        });
      } catch (error) {
        return errorResult(describeError(error).message);
      }

      const isNoop =
        plan.previous.caloriesGoal.value === calories &&
        plan.previous.proteinGoal.value === args.proteinG &&
        plan.previous.carbsGoal.value === args.carbsG &&
        plan.previous.fatsGoal.value === args.fatG;
      const details = {
        today,
        previous: summarizeGoal(plan.previous, plan.previous.id),
        new: { calories, proteinG: args.proteinG, carbsG: args.carbsG, fatG: args.fatG },
        ...(warnings.length ? { warnings } : {}),
      };
      if (isNoop) return jsonResult({ action: "unchanged", written: false, ...details });

      const body = { macronutrientGoals: plan.goals };
      if (args.dryRun) {
        return jsonResult({
          dryRun: true,
          writesEnabled: deps.config.enableWrites,
          action: plan.action,
          ...details,
          request: { method: "POST", path: GOALS_PATHS.push, body },
        });
      }
      let response;
      try {
        response = await deps.goals.pushGoals(plan.goals);
      } catch (error) {
        const outcomeUncertain = error instanceof BevelPushError || error instanceof BevelNetworkError ||
          (error instanceof BevelHttpError && error.status >= 500);
        if (plan.action !== "replaced" || !outcomeUncertain) throw error;
        const failure = describeError(error);
        const checked = await loadGoals(deps, true).catch(() => undefined);
        if (!checked || checked.truncated || checked.unparsed.length) {
          return errorResult("The macro-goal change could not be confirmed. Check the goal timeline in Bevel before retrying.");
        }
        const [ended, replacement] = plan.goals;
        const previous = checked.goals.find((g) => g.id.toLowerCase() === ended.id.toLowerCase());
        const current = activeGoalOn(checked.goals, today);
        const previousEnded = Boolean(previous?.endDate && fromCalendarDate(previous.endDate) === addDays(today, -1));
        const replacementActive = current?.id.toLowerCase() === replacement.id.toLowerCase();
        const recovery = !current
          ? "Set an active goal in Bevel before retrying."
          : previousEnded && replacementActive
            ? "Both goal records appear in Bevel. Verify the active targets in the app before retrying."
            : "Check both goal date ranges in Bevel and correct the timeline there before retrying.";
        return errorResult(`${failure.message}. ${recovery}`, {
          previousEnded,
          replacementActive,
          activeGoalPresent: Boolean(current),
        });
      }
      logger.info("Macro goals written", { action: plan.action, ids: plan.goals.map((g) => g.id) });
      return jsonResult({
        written: true,
        action: plan.action,
        ...details,
        server: response.macronutrientGoals,
        nextStep: "Force-quit and reopen Bevel, then check Nutrition goals.",
      });
    }),
  );
}
