/**
 * Nutrition endpoints (captured 2026-11-10).
 *
 *   POST /api/nutrition/v2/search/query      {query, offset, take, language, recentFdbIds, category, source}
 *        → {searchResults: {genericFoods: [{food, clientScore, searchScore}], brandedFoods: [...]}}
 *        The app sends every keystroke twice: category "common" and "branded", take 5.
 *   GET  /api/nutrition/v2/user-food-data/pull?language=en&offset&limit=30&lastSyncDate
 *        → {moreAvailable, offset, foodData: {foodLogs, recipes, compoundFoodFavorites, customFoods}}
 *   POST /api/nutrition/v2/user-food-data/push  same four collections; buckets per collection.
 *
 * A food log keeps one `id` for its whole life: create, change time (loggedAt), change servings
 * (numServings) and soft delete (deletedAt = dataUpdatedAt) are all re-pushes of the full log.
 */
import { z } from "zod";
import type { BevelHttpClient } from "../http/client.js";
import { BevelSchemaError } from "../http/errors.js";
import {
  SearchFoodSchema,
  SearchServingSchema,
  ServerRelativePortionSchema,
  addNutrients,
  scaleNutrients,
  toLoggedFood,
  toLoggedServing,
  toRelativePortion,
  type FoodLog,
  type Nutrient,
  type SearchFood,
} from "./foodMapping.js";
import { PullEnvelopeShape, TimestampMs, parseItems, pullAllPages, type PullAllOptions } from "./pull.js";
import { verifyPush, type PushResponse } from "./push.js";

export const NUTRITION_PATHS = {
  search: "/api/nutrition/v2/search/query",
  foodPull: "/api/nutrition/v2/user-food-data/pull",
  foodPush: "/api/nutrition/v2/user-food-data/push",
} as const;

export const FOOD_PULL_PAGE_SIZE = 30;
export const FOOD_PUSH_COLLECTIONS = ["foodLogs", "recipes", "compoundFoodFavorites", "customFoods"] as const;
const SEARCH_CATEGORIES = ["common", "branded"] as const;
const SEARCH_TAKE = 5;
const LANGUAGE = "en";
const CACHE_TTL_MS = 60 * 60 * 1000;

const SearchResponseSchema = z
  .object({
    searchResults: z
      .object({ genericFoods: z.array(z.unknown()), brandedFoods: z.array(z.unknown()) })
      .loose(),
  })
  .loose();

const SearchItemSchema = z.object({ food: SearchFoodSchema }).loose();

const FoodPullPageSchema = z
  .object({
    ...PullEnvelopeShape,
    foodData: z
      .object({
        foodLogs: z.array(z.unknown()),
        recipes: z.array(z.unknown()),
        compoundFoodFavorites: z.array(z.unknown()),
        customFoods: z.array(z.unknown()),
      })
      .loose(),
  })
  .loose();

/**
 * A food log as Bevel returns it on pull (seen live, 2026-11-10). It is the server's own model,
 * not the app's push form:
 *   compoundFood.foods[]          ↔ push compoundFood.components[]
 *   foods[].servingDefinition     ↔ push component.serving       (search-result format: `portion`)
 *   foods[].food                  ↔ push component.food          (search-result format, keeps the app's food id)
 *   compoundFood.customFoods      ↔ push compoundFood.customComponents
 *   relative portions carry explicit nulls; timestamps are ISO strings; plus imageUrl/analysisSessionId.
 * serverLogToPush() converts back with the same verified search-result mapping (toLoggedFood).
 */
const ServerFoodEntrySchema = z
  .object({
    id: z.string(),
    food: SearchFoodSchema,
    servingDefinition: SearchServingSchema,
    numServings: z.number(),
    isBaseFood: z.boolean(),
  })
  .loose();

export const PulledFoodLogSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    loggedAt: TimestampMs,
    dataUpdatedAt: TimestampMs.optional(),
    deletedAt: TimestampMs.nullish(),
    numServings: z.number(),
    relativePortion: ServerRelativePortionSchema,
    compoundFood: z
      .object({
        id: z.string(),
        name: z.string(),
        iconName: z.string(),
        foods: z.array(ServerFoodEntrySchema).min(1),
        customFoods: z.array(z.unknown()),
        defaultRelativePortion: ServerRelativePortionSchema,
        relativePortionOptions: z.array(ServerRelativePortionSchema),
      })
      .loose(),
  })
  .loose();
export type PulledFoodLog = z.infer<typeof PulledFoodLogSchema>;

/**
 * Server model → the app's push form (what the app itself sends when editing). Logs that contain
 * custom (non-database) foods are not supported: that structure has not been captured.
 */
export function serverLogToPush(log: PulledFoodLog, dataUpdatedAt: number): FoodLog {
  if (log.compoundFood.customFoods.length > 0) {
    throw new Error("This food log contains custom foods, which this client cannot rebuild yet.");
  }
  const compoundFoodId = log.compoundFood.id;
  return {
    id: log.id,
    loggedAt: log.loggedAt,
    dataUpdatedAt,
    title: log.title,
    numServings: log.numServings,
    relativePortion: toRelativePortion(log.relativePortion),
    compoundFood: {
      id: compoundFoodId,
      name: log.compoundFood.name,
      iconName: log.compoundFood.iconName,
      relativePortionOptions: log.compoundFood.relativePortionOptions.map(toRelativePortion),
      defaultRelativePortion: toRelativePortion(log.compoundFood.defaultRelativePortion),
      customComponents: [],
      components: log.compoundFood.foods.map((entry) => ({
        id: entry.id,
        compoundFoodId,
        isBaseFood: entry.isBaseFood,
        numServings: entry.numServings,
        food: toLoggedFood(entry.food, entry.food.id),
        serving: toLoggedServing(entry.servingDefinition, entry.food.id),
      })),
    },
  };
}

interface NutrientCarrier {
  numServings: number;
  relativePortion: { ratio: number };
  compoundFood: { components: { numServings: number; serving: { nutrients: Nutrient[] } }[] };
}

/** Σ component serving nutrients × component servings × log servings × relative-portion ratio. */
export function logNutrients(log: NutrientCarrier): Record<string, number> {
  const total: Record<string, number> = {};
  const factor = log.numServings * (log.relativePortion.ratio ?? 1);
  for (const component of log.compoundFood.components) {
    addNutrients(total, scaleNutrients(component.serving.nutrients, component.numServings * factor));
  }
  return total;
}

/** Nutrients of a pulled log (server model). */
export function pulledLogNutrients(log: PulledFoodLog): Record<string, number> {
  const total: Record<string, number> = {};
  const factor = log.numServings * (log.relativePortion.ratio ?? 1);
  for (const entry of log.compoundFood.foods) {
    addNutrients(total, scaleNutrients(entry.servingDefinition.nutrients, entry.numServings * factor));
  }
  return total;
}

/**
 * An edit or delete, as the app sends it: the full log in push form with dataUpdatedAt bumped;
 * a delete sets deletedAt = dataUpdatedAt (captured).
 */
export function buildFoodLogEdit(
  log: PulledFoodLog,
  change: { servings?: number; loggedAt?: number; delete?: boolean },
  now: number,
): FoodLog {
  const base = serverLogToPush(log, now);
  return {
    ...base,
    ...(change.loggedAt !== undefined ? { loggedAt: change.loggedAt } : {}),
    ...(change.servings !== undefined ? { numServings: change.servings } : {}),
    ...(change.delete ? { deletedAt: now } : {}),
  };
}

export interface SearchOutcome {
  foods: SearchFood[];
  unparsed: unknown[];
}

export class NutritionApi {
  private readonly cache = new Map<string, { food: SearchFood; at: number }>();

  constructor(
    private readonly http: BevelHttpClient,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Runs the app's two searches (common + branded), merges by fdbId and caches the full foods. */
  async search(query: string): Promise<SearchOutcome> {
    const foods: SearchFood[] = [];
    const unparsed: unknown[] = [];
    const seen = new Set<string>();
    for (const category of SEARCH_CATEGORIES) {
      const body = {
        query,
        offset: 0,
        take: SEARCH_TAKE,
        language: LANGUAGE,
        recentFdbIds: [] as string[],
        category,
        source: "Internal",
      };
      const raw = await this.http.request("POST", NUTRITION_PATHS.search, { body });
      const parsed = SearchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new BevelSchemaError("Food search response does not match the captured shape.", NUTRITION_PATHS.search, raw);
      }
      const { genericFoods, brandedFoods } = parsed.data.searchResults;
      const items = parseItems(SearchItemSchema, [...genericFoods, ...brandedFoods]);
      unparsed.push(...items.unparsed);
      for (const { food } of items.items) {
        if (seen.has(food.fdbId)) continue;
        seen.add(food.fdbId);
        foods.push(food);
        this.cache.set(food.fdbId, { food, at: this.clock() });
      }
    }
    return { foods, unparsed };
  }

  cachedFood(fdbId: string): SearchFood | undefined {
    const hit = this.cache.get(fdbId);
    if (!hit) return undefined;
    if (this.clock() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(fdbId);
      return undefined;
    }
    return hit.food;
  }

  /** A food from a recent search, or from re-running `query`. */
  async findFood(fdbId: string, query?: string): Promise<SearchFood | undefined> {
    const cached = this.cachedFood(fdbId);
    if (cached || !query) return cached;
    await this.search(query);
    return this.cachedFood(fdbId);
  }

  async pullFoodLogs(options: PullAllOptions): Promise<{ foodLogs: unknown[]; pagesFetched: number; truncated: boolean }> {
    const { pages, truncated } = await pullAllPages(
      NUTRITION_PATHS.foodPull,
      (query) =>
        this.http.request("GET", NUTRITION_PATHS.foodPull, { query: { language: LANGUAGE, ...query }, fresh: options.fresh ?? false }),
      FoodPullPageSchema,
      options,
    );
    return { foodLogs: pages.flatMap((p) => p.foodData.foodLogs), pagesFetched: pages.length, truncated };
  }

  async pushFoodLogs(foodLogs: FoodLog[]): Promise<PushResponse<(typeof FOOD_PUSH_COLLECTIONS)[number]>> {
    const body = { foodLogs, customFoods: [], recipes: [], compoundFoodFavorites: [] };
    const raw = await this.http.request("POST", NUTRITION_PATHS.foodPush, { body });
    return verifyPush(FOOD_PUSH_COLLECTIONS, body, raw);
  }
}
