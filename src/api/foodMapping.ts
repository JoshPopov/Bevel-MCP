/**
 * Search result → logged food, and food-log construction.
 *
 * The mapping was derived by diffing a captured search result against the same food inside the
 * app's food-log push (Banana, 2026-11-10): all 12 serving options and 37 nutrients matched after
 * these mechanical changes —
 *   - a new local uppercase UUID becomes the food's `id` (and every serving's `foodId`);
 *   - foodName → name, icon → iconName; dataUpdatedAt ISO string → Unix ms;
 *   - each serving's `portion` → `portionDefinition`: drop fdbServingId (kept on the serving),
 *     standardUnit → standardUnitName, drop null fields;
 *   - servingOptions sorted by fdbServingId.
 * brandName is not carried over: only a generic food has been logged so far, and omitting an
 * optional field is the safe choice.
 */
import { z } from "zod";

export const NutrientSchema = z.object({ nutrientType: z.string(), amount: z.number() });
export type Nutrient = z.infer<typeof NutrientSchema>;

const SearchPortionSchema = z
  .object({
    fdbServingId: z.string().nullish(),
    unitString: z.string(),
    count: z.number(),
    portionDisplayName: z.string(),
    standardUnit: z.string().nullish(),
    standardUnitAmount: z.number().nullish(),
    universalUnit: z.string().nullish(),
    standardWeight: z.number().nullish(),
  })
  .loose();

export const SearchServingSchema = z
  .object({ fdbServingId: z.string(), portion: SearchPortionSchema, nutrients: z.array(NutrientSchema) })
  .loose();
export type SearchServing = z.infer<typeof SearchServingSchema>;

export const SearchFoodSchema = z
  .object({
    id: z.string(),
    fdbId: z.string(),
    foodName: z.string(),
    brandName: z.string().nullish(),
    icon: z.string(),
    dataUpdatedAt: z.union([z.string(), z.number()]),
    source: z.string(),
    scoreCategories: z.record(z.string(), z.number()).nullish(),
    defaultServing: SearchServingSchema,
    servingOptions: z.array(SearchServingSchema).min(1),
  })
  .loose();
export type SearchFood = z.infer<typeof SearchFoodSchema>;

export interface PortionDefinition {
  unitString: string;
  count: number;
  portionDisplayName: string;
  standardUnitName?: string;
  standardUnitAmount?: number;
  universalUnit?: string;
  standardWeight?: number;
}

export interface LoggedServing {
  portionDefinition: PortionDefinition;
  nutrients: Nutrient[];
  foodId: string;
  fdbServingId: string;
}

export interface LoggedFood {
  fdbId: string;
  id: string;
  name: string;
  iconName: string;
  source: string;
  servingOptions: LoggedServing[];
  scoreCategories: Record<string, number>;
  dataUpdatedAt: number;
  defaultServing: LoggedServing;
}

export interface RelativePortion {
  ratio: number;
  servingId: string;
  portion: { unitString: string; count: number; portionDisplayName: string };
}

/** A relative portion as Bevel returns it on pull: same fields, with unset ones as explicit nulls. */
export const ServerRelativePortionSchema = z
  .object({
    ratio: z.number(),
    servingId: z.string(),
    portion: z
      .object({
        unitString: z.string(),
        count: z.number(),
        portionDisplayName: z.string(),
        standardUnitName: z.string().nullish(),
        standardUnit: z.string().nullish(),
        standardUnitAmount: z.number().nullish(),
        universalUnit: z.string().nullish(),
        standardWeight: z.number().nullish(),
      })
      .loose(),
  })
  .loose();

/** Server relative portion → the app's push form (nulls dropped, as in the captured push). */
export function toRelativePortion(server: z.infer<typeof ServerRelativePortionSchema>): RelativePortion {
  const portion: Record<string, unknown> = {
    unitString: server.portion.unitString,
    count: server.portion.count,
    portionDisplayName: server.portion.portionDisplayName,
  };
  for (const key of ["standardUnitName", "standardUnitAmount", "universalUnit", "standardWeight"] as const) {
    const value = server.portion[key];
    if (value != null) portion[key] = value;
  }
  return { ratio: server.ratio, servingId: server.servingId, portion: portion as RelativePortion["portion"] };
}

/** The compound-food portion every captured single-food log used. */
export const ONE_SERVING: RelativePortion = {
  ratio: 1,
  servingId: "fdbserv_000_1serving",
  portion: { unitString: "servings", count: 1, portionDisplayName: "1 serving" },
};

export interface FoodLogComponent {
  id: string;
  compoundFoodId: string;
  isBaseFood: boolean;
  numServings: number;
  food: LoggedFood;
  serving: LoggedServing;
}

export interface FoodLog {
  id: string;
  loggedAt: number;
  dataUpdatedAt: number;
  title: string;
  numServings: number;
  relativePortion: RelativePortion;
  compoundFood: {
    id: string;
    name: string;
    iconName: string;
    relativePortionOptions: RelativePortion[];
    defaultRelativePortion: RelativePortion;
    customComponents: unknown[];
    components: FoodLogComponent[];
  };
  deletedAt?: number;
}

function toPortionDefinition(portion: SearchServing["portion"]): PortionDefinition {
  const out: PortionDefinition = {
    unitString: portion.unitString,
    count: portion.count,
    portionDisplayName: portion.portionDisplayName,
  };
  if (portion.standardUnit != null) out.standardUnitName = portion.standardUnit;
  if (portion.standardUnitAmount != null) out.standardUnitAmount = portion.standardUnitAmount;
  if (portion.universalUnit != null) out.universalUnit = portion.universalUnit;
  if (portion.standardWeight != null) out.standardWeight = portion.standardWeight;
  return out;
}

export function toLoggedServing(serving: SearchServing, foodId: string): LoggedServing {
  return {
    portionDefinition: toPortionDefinition(serving.portion),
    nutrients: serving.nutrients.map((n) => ({ amount: n.amount, nutrientType: n.nutrientType })),
    foodId,
    fdbServingId: serving.fdbServingId,
  };
}

const byServingId = (a: { fdbServingId: string }, b: { fdbServingId: string }) =>
  a.fdbServingId < b.fdbServingId ? -1 : a.fdbServingId > b.fdbServingId ? 1 : 0;

export function toLoggedFood(food: SearchFood, localId: string): LoggedFood {
  return {
    fdbId: food.fdbId,
    id: localId,
    name: food.foodName,
    iconName: food.icon,
    source: food.source,
    servingOptions: food.servingOptions.map((s) => toLoggedServing(s, localId)).sort(byServingId),
    scoreCategories: { ...(food.scoreCategories ?? {}) },
    dataUpdatedAt: typeof food.dataUpdatedAt === "number" ? food.dataUpdatedAt : Date.parse(food.dataUpdatedAt),
    defaultServing: toLoggedServing(food.defaultServing, localId),
  };
}

/** Builds a single-food log exactly in the captured structure. */
export function buildFoodLog(input: {
  food: LoggedFood;
  servingId: string;
  servings: number;
  loggedAt: number;
  now: number;
  ids: { log: string; compoundFood: string; component: string };
}): FoodLog {
  const serving = input.food.servingOptions.find((s) => s.fdbServingId === input.servingId);
  if (!serving) throw new Error(`Serving ${input.servingId} is not one of this food's serving options`);
  return {
    id: input.ids.log,
    loggedAt: input.loggedAt,
    dataUpdatedAt: input.now,
    title: input.food.name,
    numServings: input.servings,
    relativePortion: ONE_SERVING,
    compoundFood: {
      id: input.ids.compoundFood,
      name: input.food.name,
      iconName: input.food.iconName,
      relativePortionOptions: [ONE_SERVING],
      defaultRelativePortion: ONE_SERVING,
      customComponents: [],
      components: [
        {
          id: input.ids.component,
          compoundFoodId: input.ids.compoundFood,
          isBaseFood: true,
          numServings: 1,
          food: input.food,
          serving,
        },
      ],
    },
  };
}

/** Nutrient amounts by type, multiplied by a factor (missing nutrients are simply absent). */
export function scaleNutrients(nutrients: Nutrient[], factor: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nutrients) out[n.nutrientType] = (out[n.nutrientType] ?? 0) + n.amount * factor;
  return out;
}

export function addNutrients(into: Record<string, number>, add: Record<string, number>): Record<string, number> {
  for (const [key, value] of Object.entries(add)) into[key] = (into[key] ?? 0) + value;
  return into;
}

/** The nutrients most people ask about, rounded for display. */
export const HEADLINE_NUTRIENTS = ["calories", "protein", "carbohydrate", "fat", "fiber", "sugar", "caffeine"] as const;

export function headline(nutrients: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of HEADLINE_NUTRIENTS) out[key] = Math.round((nutrients[key] ?? 0) * 10) / 10;
  return out;
}
