import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StaticTokenProvider, type TokenProvider } from "../src/auth/tokenProvider.js";
import { loadConfig, type BevelConfig } from "../src/config.js";
import type { FetchLike } from "../src/http/client.js";
import { silentLogger } from "../src/log.js";
import { buildDeps, createServer } from "../src/server.js";
import type { ToolDeps } from "../src/tools/shared.js";

/** Every tool the server should register (kept in one place as phases add tools). */
export const EXPECTED_TOOLS = [
  "bevel_auth_status",
  "bevel_get_journal",
  "bevel_get_custom_journal_types",
  "bevel_set_journal_boolean",
  "bevel_clear_journal_boolean",
  "bevel_get_macro_goals",
  "bevel_set_macro_goals",
  "bevel_search_food",
  "bevel_log_food",
  "bevel_get_food_logs",
  "bevel_update_food_log",
  "bevel_delete_food_log",
  "bevel_get_workout_data",
  "bevel_get_workout_history",
  "bevel_create_custom_exercise",
  "bevel_save_routine",
  "bevel_delete_routine",
];

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT" }): string {
  return `${b64(header)}.${b64(payload)}.c2lnbmF0dXJl`;
}

export const TEST_TOKEN = makeJwt({
  iss: "https://securetoken.google.com/test-project",
  aud: "test-project",
  sub: "user-abcdef-123456",
  iat: 1794330000,
  exp: 1794333600,
  firebase: { sign_in_provider: "apple.com" },
});

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Responder = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A fetch double that records every call and answers with `responder`. */
export function fakeFetch(responder: Responder): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export const EMPTY_BUCKET = { succeeded: [] as string[], failed: [] as unknown[] };

export function pushResponse(booleanSucceeded: string[], booleanFailed: unknown[] = []) {
  return {
    customJournalTypes: EMPTY_BUCKET,
    booleanJournals: { succeeded: booleanSucceeded, failed: booleanFailed },
    booleanJournalDefaults: EMPTY_BUCKET,
    categoricalJournalDefaults: EMPTY_BUCKET,
    numericJournalDefaults: EMPTY_BUCKET,
  };
}

export function testConfig(env: Record<string, string> = {}): BevelConfig {
  return loadConfig({ BEVEL_TOKEN: TEST_TOKEN, BEVEL_TIMEZONE: "America/New_York", ...env }, "linux");
}

export interface Harness {
  client: Client;
  deps: ToolDeps;
  calls: RecordedCall[];
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult & { text: string }>;
  close(): Promise<void>;
}

/** Connects an MCP client to a server built with a fake fetch, over an in-memory transport. */
export async function harness(options: {
  env?: Record<string, string>;
  responder?: Responder;
  tokenProvider?: TokenProvider;
  noToken?: boolean;
} = {}): Promise<Harness> {
  const env = options.noToken ? { BEVEL_TOKEN: "", ...options.env } : options.env;
  const config = testConfig(env);
  const { fetch, calls } = fakeFetch(options.responder ?? (() => json({})));
  const deps = buildDeps(config, {
    fetch,
    logger: silentLogger,
    ...(options.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
  });
  deps.now = () => 1794334952292.573;
  let n = 0;
  deps.newUuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    deps,
    calls,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return { ...result, text };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export { StaticTokenProvider };

export function journalPage(booleanJournals: unknown[] = [], extra: { moreAvailable?: boolean; offset?: number } = {}) {
  return {
    moreAvailable: extra.moreAvailable ?? false,
    offset: extra.offset ?? 100,
    journalData: {
      booleanJournals,
      booleanJournalDefaults: [],
      categoricalJournalDefaults: [],
      numericJournalDefaults: [],
    },
  };
}

export function pulledEntry(overrides: Record<string, unknown> = {}) {
  return {
    identifyingDate: 1794330000000,
    uuid: "AAAAAAAA-0000-4000-8000-000000000001",
    presetFactorKey: "addedSugar",
    boolValue: true,
    startTime: 1794330000000,
    endTime: 1794330000000,
    createdAt: 1794334952292.411,
    updatedAt: 1794334952292.573,
    isNotSet: false,
    ...overrides,
  };
}

/** Echo a push: every array in the body becomes a bucket whose ids all succeeded. */
export function echoPush(body: Record<string, unknown>): Response {
  const buckets: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Array.isArray(value)) continue;
    buckets[key] = {
      succeeded: value.map((item: any) => item?.uuid ?? item?.id).filter((id) => typeof id === "string"),
      failed: [],
    };
  }
  return json(buckets);
}

/**
 * A fake Bevel API covering every endpoint the server uses. Pulls return the given records;
 * pushes echo every submitted id as succeeded unless `push` overrides (return undefined to fall through).
 */
export function fakeApi(options: {
  booleanJournals?: unknown[];
  goals?: unknown[];
  foodLogs?: unknown[];
  fitnessData?: Record<string, unknown[]>;
  searchResults?: { genericFoods: unknown[]; brandedFoods: unknown[] };
  push?: (body: any, path: string) => Response | undefined;
} = {}): Responder {
  return (call) => {
    const url = new URL(call.url);
    const path = url.pathname;
    if (call.method === "POST") {
      const body = JSON.parse(call.body!);
      if (path === "/api/nutrition/v2/search/query") {
        return json({ searchResults: options.searchResults ?? { genericFoods: [], brandedFoods: [] } });
      }
      const custom = options.push?.(body, path);
      if (custom) return custom;
      if (path.endsWith("/push")) return echoPush(body);
    }
    if (call.method === "GET") {
      if (path === "/api/journal/v1/user-journal-data/pull") return json(journalPage(options.booleanJournals ?? []));
      if (path === "/api/nutrition/v1/macronutrient-goals/pull") {
        return json({ moreAvailable: false, offset: 100, macronutrientGoals: options.goals ?? [] });
      }
      if (path === "/api/nutrition/v2/user-food-data/pull") {
        return json({
          moreAvailable: false,
          offset: 30,
          foodData: { foodLogs: options.foodLogs ?? [], recipes: [], compoundFoodFavorites: [], customFoods: [] },
        });
      }
      if (path === "/api/fitness/v1/user-fitness-data/pull") {
        return json({
          moreAvailable: false,
          offset: 30,
          fitnessData: {
            customExercises: [],
            strengthWorkoutTemplates: [],
            cardioWorkoutTemplates: [],
            strengthWorkoutSessions: [],
            exerciseNotes: [],
            ...options.fitnessData,
          },
        });
      }
    }
    return json({ error: "not mocked" }, 404);
  };
}

/** A synthetic pulled macro goal (values are illustrative, not captured data). */
export function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "GOAL-ACTIVE",
    type: "custom",
    caloriesGoal: { value: 2000, unit: "kcal" },
    proteinGoal: { value: 150, unit: "grams" },
    carbsGoal: { value: 200, unit: "grams" },
    fatsGoal: { value: 66.67, unit: "grams" },
    totalDailyEnergyExpenditure: { value: 2500, unit: "kcal" },
    effectiveStartDate: { year: 2026, month: 7, day: 1 },
    updatedAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

/** A synthetic pulled routine (structure as captured; ids and values are placeholders). */
export function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: "ROUTINE-1",
    name: "Test routine",
    createdAt: 1794336633652.281,
    updatedAt: "2026-11-10T18:50:00.000Z",
    isDeleted: false,
    notes: [],
    setGroups: [
      {
        id: "GROUP-1",
        presetWorkoutId: "abCrunchMachine",
        weightUnit: "lb",
        isRestTimersEnabled: false,
        routineNotes: [],
        sets: [{ id: "SET-1", setLabel: "normal", weightLbs: 20, restDuration: 120, reps: 12 }],
      },
      {
        id: "GROUP-2",
        presetWorkoutId: "backPlank",
        weightUnit: "kg",
        isRestTimersEnabled: true,
        routineNotes: [],
        sets: [{ id: "SET-2", setLabel: "normal", weightLbs: 0, restDuration: 120, duration: 60 }],
      },
    ],
    ...overrides,
  };
}

export function customExercise(overrides: Record<string, unknown> = {}) {
  return {
    id: "CUSTOM-1",
    name: "Test Band Walk",
    equipment: "band",
    defaultExerciseType: "reps",
    primaryMuscleGroups: ["hipFlexors"],
    secondaryMuscleGroups: ["calves"],
    isDeleted: false,
    createdAt: 1794338836034.4219,
    updatedAt: 1794338836034.4219,
    ...overrides,
  };
}

/** A synthetic completed workout in the stored shape seen live (ids/values are placeholders). */
export function session(overrides: Record<string, unknown> = {}) {
  const set = (id: string, extra: Record<string, unknown>) => ({
    id,
    setLabel: "normal",
    autodetected: false,
    activeDuration: 40,
    plannedRestDuration: 120,
    ...extra,
  });
  return {
    id: "SESSION-1",
    hkWorkoutId: "HK-1",
    estimatedEffort: 7,
    startDate: Date.parse("2026-11-10T14:00:00Z"),
    endDate: Date.parse("2026-11-10T14:45:00Z"),
    isRemoved: false,
    sourceTypeKey: "healthKit",
    sets: [
      set("S1", { presetWorkoutId: "legPressMachine", setGroupId: "G1", reps: 12, weightLbs: 205, weightUnit: "lb" }),
      set("S2", { presetWorkoutId: "legPressMachine", setGroupId: "G1", reps: 10, weightLbs: 205, weightUnit: "lb" }),
      set("S3", { presetWorkoutId: "latPulldownCable", setGroupId: "G2", reps: 10, weightLbs: 32 * 2.20462, weightUnit: "kg" }),
      set("S4", { customExerciseId: "CUSTOM-1", setGroupId: "G3", reps: 12, weightLbs: 10, weightUnit: "lb", analysis: { detectedReps_v1: 12 } }),
    ],
    workoutNotes: [],
    exerciseWorkoutNotes: {},
    updatedAt: "2026-11-10T15:00:00.000Z",
    ...overrides,
  };
}
