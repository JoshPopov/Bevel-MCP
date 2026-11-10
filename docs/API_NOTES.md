# Bevel Health private API — notes

This is a living document of what has been observed in Bevel iOS traffic. Sources:
- the reverse-engineering handoff, 2026-11-10;
- a second mitmproxy capture of 54 flows, also 2026-11-10. It covered an app launch, two Journal
  edits, deleting one strength routine and creating another, and browsing food search;
- the first live read through this client: a full Journal pull of a real account, 2026-11-10;
- a third capture of 152 flows, from working through a checklist in the app. It included clearing a
  Journal factor, searching for and logging a food, editing its time
  and servings, deleting it, creating a recipe, changing macro goals twice, creating a custom
  exercise, and editing a routine.

Ids, timestamps and personal values in the examples below are replaced with placeholders or
illustrative numbers.

**Rule:** the code only uses paths and fields listed here as observed. Anything inferred is
labelled as a hypothesis. Personal identifiers from captures (user IDs, push tokens, chat IDs and
sync cursors) are deliberately not recorded here.

## Status at a glance

| Area | Item | Status | Used by |
|---|---|---|---|
| Transport | `https://api.supersethealth.com`, HTTP/2, JSON, Cloudflare in front of Express | Confirmed | `src/http/client.ts` |
| Auth | `Authorization: Bearer <JWT>`, issued by Bevel itself, RS256, claims `userId`/`iat`/`exp` only, **60-day lifetime** | Confirmed | `src/auth/jwt.ts` |
| Auth | Login and token-issue endpoint | **Unknown**: the token was issued about 3 minutes before the capture began | — |
| Auth | Which headers are required | Unknown; the client sends the app's core headers, listed below | `src/http/client.ts` |
| Sync | `/pull` envelope `{moreAvailable, offset, <payload>}`, with `lastSyncDate` in Unix ms | Confirmed across about 10 endpoints | `src/api/pull.ts` |
| Journal | Push: create a Boolean entry | **Confirmed** | `bevel_set_journal_boolean` |
| Journal | Push: **update** a Boolean entry (same `uuid` and `createdAt`, new value and `updatedAt`) | **Confirmed** (true→false observed) | `bevel_set_journal_boolean` |
| Journal | `identifyingDate` = local noon of the day | Confirmed in America/New_York, both EST and EDT (entries in Apr, Jun, Jul and Nov) | `src/time.ts` |
| Journal | Pull envelope and collection names; `lastSyncDate=0` returns full history | Confirmed against live data | `bevel_get_journal` |
| Journal | Shape of a *pulled* Boolean entry | **Confirmed**, and it differs from the push: `updatedAt` is an ISO string and `boolValue` is absent when cleared | `PulledBooleanJournalSchema` |
| Journal | **Clear** = same entry with `isNotSet: true` and the `boolValue` key omitted | **Captured** (push), and confirmed as stored | `bevel_clear_journal_boolean` |
| Journal | Numeric and categorical entries | Unknown | — |
| Nutrition | Food search, with real results | **Captured** | `bevel_search_food` |
| Nutrition | Food log create, change time, change servings, soft delete (`deletedAt`) | **Captured** | `bevel_log_food`, `bevel_update_food_log`, `bevel_delete_food_log` |
| Nutrition | Shape of a *pulled* food log | **Confirmed (live)**. It's the server's own model and differs from the push; see "Food log as stored" | `bevel_get_food_logs` |
| Nutrition | Recipe create | Captured, not implemented | — |
| Goals | Change = end active goal (yesterday) + new goal (today), or in-place update the same day | **Captured** | `bevel_set_macro_goals` |
| Fitness | Routine create, edit (full replace), soft delete (`isDeleted`) | **Captured** | `bevel_save_routine`, `bevel_delete_routine` |
| Fitness | Custom exercise create | **Captured** | `bevel_create_custom_exercise` |
| Fitness | Pulled routines and custom exercises | **Confirmed (live)**: same shape as the push, with ISO `updatedAt` | `bevel_get_workout_data` |
| Fitness | Completed sessions (stored shape) | **Confirmed (live)**: linked to an Apple Health workout | `bevel_get_workout_history` |
| Fitness | Completed session push, cardio templates, exercise notes | Not captured | — |
| Integrations | `POST /api/integrations/v1/{workouts,daily,sleep,samples}?source=google-health` | Observed: reads of the server-side Google Health sync | — |

## Request headers (Bevel iOS 3.2.7, build 2829)

```
authorization: Bearer <JWT>
accept: application/json        (GET)   |   */*  (POST)
content-type: application/json  (POST)
bevel-app-version: 3.2.7
request-id: <new uppercase UUID per request>
user-agent: Superset/2829 CFNetwork/3896.300.31 Darwin/27.3.0
accept-language: en-US,en;q=0.9
accept-encoding: gzip, deflate, br
baggage / sentry-trace: Sentry tracing (not sent by this client)
```

Some GETs (`/api/users/user`, coaching plans and schedule) were answered `304 Not Modified`, so the
app uses ETags there. This client doesn't send `If-None-Match`.

## Auth token

| Property | Value |
|---|---|
| Algorithm | RS256, with no `kid` |
| Claims | `userId` (string), `iat`, `exp` |
| `iss`, `aud`, `sub` | absent |
| Lifetime | `exp − iat` = 5,184,000 s = **60 days** |

So a manually captured token lasts about two months, and `bevel_auth_status` warns in the final week.
To support automatic renewal, capture a sign-out followed by a sign-in. That reveals the login
endpoint and whether a refresh token exists.

Unrelated traffic in the same capture:
- `oauthaccountmanager.googleapis.com/v1/issuetoken` is iOS's Google account manager.
- `api.mixpanel.com` is analytics.
- `*.ingest.sentry.io` is crash reporting.
- `status-alerts.bevel.health` serves in-app announcements.
- `carrotstation.herokuapp.com` and `api10.meetcarrot.com` are another app.

## Sync protocol (`/pull`)

```
GET <path>?offset=0&limit=100&lastSyncDate=1794336406840
→ 200 { "moreAvailable": false, "offset": 100, "<payloadKey>": ... }
```

- `lastSyncDate` is Unix ms, sent as a string. Only records changed after it are returned. Every
  pull at launch used the time of the previous sync, and all came back empty.
- The response `offset` is the next offset to request (request offset + limit). Keep paging while
  `moreAvailable` is true.
- To get the full history this client sends `lastSyncDate=0`. That is inferred, not yet observed.
- One exception: `/api/coaching/v1/sync/coach-chats/pull` returned `offset: 0`.

| Endpoint | limit used by app | Payload |
|---|---|---|
| `/api/journal/v1/user-journal-data/pull` | 100 | `journalData: {booleanJournals, booleanJournalDefaults, categoricalJournalDefaults, numericJournalDefaults}` |
| `/api/journal/v1/custom-journal-types/pull` | 100 | `customJournalTypes: []` |
| `/api/fitness/v1/user-fitness-data/pull` | 30 | `fitnessData: {customExercises, strengthWorkoutTemplates, cardioWorkoutTemplates, strengthWorkoutSessions, exerciseNotes}` |
| `/api/nutrition/v2/user-food-data/pull` (also `language=en`) | 30 | `foodData: {foodLogs, recipes, compoundFoodFavorites, customFoods}` |
| `/api/nutrition/v1/macronutrient-goals/pull` | 100 | `macronutrientGoals: []` |
| `/api/user-data/v1/biology-profile/pull` | 30 | `biologyProfiles: []` |
| `/api/user-data/v1/activity-status/pull` | 100 | `activityStatuses: []` |
| `/api/user-data/v1/smoking-logs/pull` | 500 | `smokingLogs: []` |
| `/api/coaching/v2/chat/metadata/pull` | 500 | `chatMetadata: []` |
| `/api/coaching/v1/sync/coach-chats/pull` | 30 | `chats: []` |

The handoff listed `GET /api/journal/v1/user-fitness-data/pull`. In this capture the fitness pull is
`/api/fitness/v1/user-fitness-data/pull`.

## Journal push (confirmed: create and update)

`POST /api/journal/v1/user-journal-data/push`

The app sends all five collections every time and serialises keys in arbitrary order.

**Create** (from the handoff):

```json
{
  "booleanJournalDefaults": [],
  "customJournalTypes": [],
  "booleanJournals": [
    {
      "identifyingDate": 1794330000000,
      "uuid": "<new uppercase uuid>",
      "presetFactorKey": "addedSugar",
      "boolValue": true,
      "startTime": 1794330000000,
      "updatedAt": 1794334952292.573,
      "isNotSet": false,
      "createdAt": 1794334952292.411,
      "endTime": 1794330000000
    }
  ],
  "numericJournalDefaults": [],
  "categoricalJournalDefaults": []
}
```

**Update**: the same push with the **same `uuid`, `identifyingDate`, `startTime`, `endTime` and
`createdAt`**, plus the new `boolValue` and a new `updatedAt`. Toggling Device in Bed from true to
false sent exactly that, and the server listed the uuid under `succeeded`. So the server upserts by
uuid, and the app keeps **one entry per factor per day**.

Response (HTTP 200) has one `{succeeded, failed}` bucket per collection:

```json
{
  "customJournalTypes": { "succeeded": [], "failed": [] },
  "booleanJournals": { "succeeded": ["<uuid>"], "failed": [] },
  "booleanJournalDefaults": { "succeeded": [], "failed": [] },
  "categoricalJournalDefaults": { "succeeded": [], "failed": [] },
  "numericJournalDefaults": { "succeeded": [], "failed": [] }
}
```

| Field | Type | Meaning |
|---|---|---|
| `uuid` | string | Uppercase UUID (Swift `uuidString`), confirmed in this capture. Stable across edits. |
| `presetFactorKey` | string | Written and confirmed: `addedSugar` (Added Sugar) and `deviceInBed` (Device in Bed). Seen in live data: `lateMeal`. |
| `boolValue` | boolean | The factor's value. **Omitted by the server when `isNotSet` is true.** |
| `identifyingDate` | number (ms) | **Local noon** of the calendar day. |
| `startTime`, `endTime` | number (ms) | Equal to `identifyingDate` for Boolean entries. |
| `createdAt` | number (ms) | Set once on creation, with fractional ms. |
| `updatedAt` | number (ms) when pushed; **ISO-8601 string when pulled** | Set on every edit. On pull it is the server's own timestamp, so the client's value isn't echoed back. |
| `isNotSet` | boolean | `true` = the factor was cleared in the app. The entry and its uuid stay, and `boolValue` disappears. |

A pulled entry, from live data with the uuid replaced:

```json
{
  "createdAt": 1794334952292.411,
  "endTime": 1794330000000,
  "identifyingDate": 1794330000000,
  "isNotSet": true,
  "presetFactorKey": "addedSugar",
  "startTime": 1794330000000,
  "uuid": "<uuid>",
  "updatedAt": "2026-11-10T19:01:20.180Z"
}
```

**How the client writes:** `bevel_set_journal_boolean` mirrors the app.
1. It pulls Journal changes since 30 days before the target day. An entry for day D can't have last
   changed before D.
2. It finds the entry for the same factor and local day.
3. If one exists, it updates it in place. Otherwise it creates one. If the value is already set, it
   does nothing.

The write is refused if the pull is truncated or contains entries it can't parse, so it never creates
a duplicate because a lookup was incomplete.

## Fitness push (confirmed for strength templates)

`POST /api/fitness/v1/user-fitness-data/push`

```json
{
  "strengthWorkoutTemplates": [
    {
      "id": "<uuid>",
      "name": "New routine",
      "createdAt": 1794336633652.281,
      "updatedAt": 1794336633652.281,
      "isDeleted": false,
      "notes": [],
      "setGroups": [
        {
          "id": "<uuid>",
          "presetWorkoutId": "abCrunchMachine",
          "weightUnit": "lb",
          "isRestTimersEnabled": false,
          "routineNotes": [],
          "superset": { "id": "<uuid shared by grouped setGroups>", "style": "blue" },
          "sets": [
            { "id": "<uuid>", "setLabel": "normal", "weightLbs": 20, "reps": 12, "restDuration": 120 }
          ]
        }
      ]
    }
  ],
  "strengthWorkoutSessions": [],
  "cardioWorkoutTemplates": [],
  "customExercises": []
}
```

Response buckets: `customExercises`, `strengthWorkoutTemplates`, `cardioWorkoutTemplates`,
`strengthWorkoutSessions` and `exerciseNotes`. The response includes `exerciseNotes` even though the
request omits it. The template's `id` appears in `strengthWorkoutTemplates.succeeded`.

Observations:
- **Soft delete:** deleting a routine re-pushes the full template with the same `id`, `isDeleted: true`
  and a new `updatedAt`.
- **Supersets:** consecutive `setGroups` share a `superset: {id, style}` object. Only `style: "blue"`
  has been seen.
- **Timed sets:** sets for timed exercises, such as `backPlank` and `backLever`, have `duration` in
  seconds (60 observed), no `reps`, and `weightLbs: 0`.
- **Units:** the weight is always stored as `weightLbs`. `weightUnit` (`"lb"` or `"kg"`) is the
  display unit. kg values are stored as **kg × 2.20462, unrounded**: in live data, 18 kg →
  `39.683159999999994` and 32 kg → `70.54784`.
- `superset` is omitted when a group isn't in a superset.
- **Exercise ids observed:** `abCrunchMachine`, `abRoller`, `backExtensionMachine`, `backLever`,
  `backPlank`, `backRowMachine`, `benchDip`, `benchPressBarbell`, `benchPressCable`,
  `benchPressDumbbell`, `deltoidRaiseDumbbellBentOver`, `latPulldownMachineBehindTheNeck`,
  `smithMachineShoulderPressBehindTheNeck`.

**Routine edit** (captured): the whole routine is re-pushed.
- Same `id` and `createdAt`, and a new `updatedAt`.
- Existing `setGroups` keep their ids.
- **Every set gets a new id.**
- A group can point at a custom exercise with `customExerciseId` instead of `presetWorkoutId`.

**Custom exercise** (captured):

```json
{ "id": "<uuid>", "name": "MCP Test", "equipment": "band", "defaultExerciseType": "reps",
  "primaryMuscleGroups": ["hipFlexors"], "secondaryMuscleGroups": ["calves"],
  "isDeleted": false, "createdAt": 1794338836034.42, "updatedAt": 1794338836034.42 }
```

Values seen so far, in captures and in a live pull of real data:
- `equipment`: `band`, `dumbbellDouble`, `dumbbellSingle`, `other`
- `defaultExerciseType`: `reps`
- muscle groups: `hipFlexors`, `calves`, `upperBack`, `lats`, `traps`, `obliques`, `quads`, `abs`

Live routines also use more `presetWorkoutId` values, for example `legPressMachine`,
`cableRowSeated`, `facePullCable` and `chestPressMachine`. The tools accept any value already present
in the account's own data.

### Completed workouts as stored (seen live)

`fitnessData.strengthWorkoutSessions[]`:

```json
{ "id": "<uuid>", "hkWorkoutId": "<Apple Health workout uuid>", "sourceTypeKey": "healthKit",
  "startDate": <ms>, "endDate": <ms>, "estimatedEffort": 6, "isRemoved": false,
  "sets": [ { "id": "<uuid>", "setGroupId": "<uuid>", "presetWorkoutId": "legPressMachine",
              "reps": 10, "weightLbs": 135, "weightUnit": "lb", "setLabel": "normal", "autodetected": false,
              "startTime": <ms>, "endTime": <ms>, "activeDuration": 52.5,
              "plannedRestDuration": 150, "trailingRestDuration": 155.0,
              "trailingRestStartTime": <ms>, "trailingRestEndTime": <ms>,
              "analysis": { "detectedReps_v1": <n>, "startSTE_v1": <n>, "meanSTE_v1": <n>, "endSTE_v1": <n>, "steLoss_v1": <n> },
              "analysisVersion": "1" } ],
  "workoutNotes": [], "exerciseWorkoutNotes": {}, "updatedAt": "<ISO>" }
```

- Sets are a flat list in the order performed. `setGroupId` groups them by exercise, and a set uses
  `customExerciseId` instead of `presetWorkoutId` for a custom exercise.
- `analysis` is Apple Watch rep detection and isn't on every set. The last set has no `trailingRest*`
  fields.
- Every session seen is linked to an **Apple Health workout** (`hkWorkoutId`). A client that can't
  write to Apple Health can't reproduce that, so logging sessions waits for a capture of finishing a
  workout, ideally one logged without the Watch, to see whether another `sourceTypeKey` exists.

## Nutrition

### Food search (captured)

`POST /api/nutrition/v2/search/query`

```json
{ "query": "Banana", "offset": 0, "take": 5, "language": "en", "recentFdbIds": [], "category": "common", "source": "Internal" }
```

The app sends each keystroke twice, once with `category: "common"` and once with `"branded"`. Both
answers contain both lists:

```json
{ "searchResults": {
    "genericFoods": [ { "food": <SearchFood>, "clientScore": 878.5, "searchScore": 740.1 } ],
    "brandedFoods": [ ... ] } }
```

`SearchFood` contains:
- `id`, `fdbId`, `foodName`, `brandName` (null for generic foods), `icon`, `source: "bevel"`, and
  `scoreCategories` (for example `{"Whole Fruit": 100}`)
- `dataUpdatedAt` (an ISO string)
- `defaultServing` and `servingOptions[]`

Each serving is `{fdbServingId, portion, nutrients}`:
- `portion` is `{fdbServingId, unitString, count, portionDisplayName, standardUnit, standardUnitAmount, universalUnit, standardWeight}`,
  and any of the last four can be null.
- `nutrients` is a list of `{nutrientType, amount}` with up to 37 types: `calories`, `protein`,
  `carbohydrate`, `fat`, `fiber`, `sugar`, `caffeine`, `alcohol`, vitamins and minerals. Branded
  foods list fewer.

### Food log (captured: create, edit time, edit servings, delete)

`POST /api/nutrition/v2/user-food-data/push`

```json
{ "foodLogs": [ {
    "id": "<uuid>", "loggedAt": 1794338642915.85, "dataUpdatedAt": 1794338652908.57,
    "title": "Banana", "numServings": 1,
    "relativePortion": { "ratio": 1, "servingId": "fdbserv_000_1serving",
                         "portion": { "unitString": "servings", "count": 1, "portionDisplayName": "1 serving" } },
    "compoundFood": {
      "id": "<uuid>", "name": "Banana", "iconName": "banana",
      "relativePortionOptions": [ <same relativePortion> ], "defaultRelativePortion": <same>,
      "customComponents": [],
      "components": [ { "id": "<uuid>", "compoundFoodId": "<compoundFood.id>", "isBaseFood": true,
                        "numServings": 1, "food": <LoggedFood>, "serving": <LoggedServing> } ] } } ],
  "customFoods": [], "recipes": [], "compoundFoodFavorites": [] }
```

The response has buckets `foodLogs`, `recipes`, `compoundFoodFavorites` and `customFoods`.

How the app turns a `SearchFood` into a `LoggedFood`, verified on all 12 servings and 37 nutrients of
one food:
- **Food id:** a new local uppercase UUID becomes `id`, and also each serving's `foodId`.
- **Renamed fields:** `foodName` → `name` and `icon` → `iconName`. `dataUpdatedAt` changes from an ISO
  string to ms.
- **Kept fields:** `fdbId`, `source` and `scoreCategories` are kept.
- **Servings:** each serving becomes `{portionDefinition, nutrients, foodId, fdbServingId}`.
  `portionDefinition` is the portion without `fdbServingId`, with `standardUnit` →
  `standardUnitName` and nulls dropped.
- **Order:** `servingOptions` are sorted by `fdbServingId`.

Other details:
- **Meals:** there's no meal field. Moving a log to breakfast changed only `loggedAt`, to 8:24 AM.
- **Quantity:** changing the servings set `numServings` on the log. The component stays at
  `numServings: 1` with the chosen serving.
- **Delete:** the log is re-pushed with `deletedAt` equal to `dataUpdatedAt`.
- **Brands:** whether branded foods carry `brandName` in the log hasn't been seen. The tool leaves it
  out.

### Food log as stored (seen live)

`GET /api/nutrition/v2/user-food-data/pull` returns logs in the **server's model**, not the app's push
form. A soft-deleted log is returned too, with `deletedAt` set.

```json
{ "id": "<uuid>", "title": "Banana", "loggedAt": "2026-11-10T13:24:00.000Z",
  "imageUrl": null, "analysisSessionId": null,
  "numServings": 2, "relativePortion": <server relative portion>,
  "dataUpdatedAt": "<ISO>", "deletedAt": "<ISO>",
  "compoundFood": {
    "id": "<uuid>", "name": "Banana", "iconName": "banana",
    "foods": [ { "id": "<component id>", "food": <SearchFood, keeping the app's local food id>,
                 "servingDefinition": <SearchServing>, "numServings": 1, "isBaseFood": true } ],
    "customFoods": [],
    "defaultRelativePortion": <server relative portion>, "relativePortionOptions": [ ... ] } }
```

A server relative portion is
`{ratio, servingId, portion: {unitString, count, portionDisplayName, standardUnit: null, standardUnitName: null, standardUnitAmount: null, universalUnit: null, standardWeight: null}}`.

To convert back to the push form (`serverLogToPush`, which mirrors what the app does when it edits a
log):
- `foods` → `components`, adding `compoundFoodId`.
- `servingDefinition` → `serving`, and the search-format `food` → logged food. This uses the same
  verified mapping as logging from search, with the food's own `id` as `foodId`.
- `customFoods` → `customComponents`. Custom foods haven't been seen yet, so editing logs that contain
  them is refused.
- Nulls are dropped from relative portions, ISO timestamps become ms, and `imageUrl` and
  `analysisSessionId` are left out.

### Recipe (captured, not implemented)

The bucket is `recipes`. Each item is `{id, name, iconName: "recipe", isFavorited, numServings,
userInputtedTotalYield: {unitCount, unit, numPortions}, components: [{id, fdbId, fdbServingId,
numServings, isBaseFood: false}], customComponents: [], dataUpdatedAt}`.

### Other

- `POST /api/nutrition/v1/food-db/pull` with body
  `{"fdbIds": ["fdb_..."], "language": "en", "lastSyncDate": <ms>}` returns `{"foods": []}`. With a
  recent `lastSyncDate` it was empty.

## Macro goals (captured)

`POST /api/nutrition/v1/macronutrient-goals/push` with body `{"macronutrientGoals": [...]}`. The
response has the bucket `macronutrientGoals`.

```json
{ "id": "<uuid>", "type": "custom",
  "caloriesGoal": { "value": 2000, "unit": "kcal" },
  "proteinGoal": { "value": 150, "unit": "grams" }, "carbsGoal": { "value": 215, "unit": "grams" },
  "fatsGoal": { "value": 60, "unit": "grams" },
  "totalDailyEnergyExpenditure": { "value": 2500, "unit": "kcal" },
  "effectiveStartDate": { "year": 2026, "month": 11, "day": 10 },
  "endDate": { "year": 2026, "month": 11, "day": 9 },
  "updatedAt": 1794338777425 }
```

- **First change of the day:** the request had two goals. The previously active goal now had
  `endDate` = yesterday and a new `updatedAt`, and a new goal started today with no `endDate` key.
- **Second change the same day:** only today's goal was sent, with the same id and new values.
- **Calories:** in both captured goals, calories = 4×protein + 4×carbs + 9×fat.

## Integrations (observed)

`POST /api/integrations/v1/{workouts,daily,sleep,samples}?source=google-health` with body
`{lastSyncedAt, limit: 500, earliestDataDate, sampleType?, lastSampleDate?}` returns
`{workouts | daily | sleep | samples: [], moreAvailable}`.

These **read** data that the server synced from Google Health, and all came back empty here.
`sampleType` values seen: `hrvRmssd`, `spo2Percentage`, `heartRate`, `steps`,
`heartRateMinuteAggregate`, `restingEnergy`, `activeEnergy`, `bodyWeightKg`,
`bodyTemperatureFahrenheit`, `bloodGlucoseMgDl` and `bodyFatPercentage`.

## Other endpoints seen at app launch

| Endpoint | Notes |
|---|---|
| `GET /api/users/user` | `304` (ETag) |
| `POST /api/users/devices` | Registers the APNs push token |
| `POST /api/users/v1/subscription/sync` | Body `{"expectedStatus": ...}` |
| `POST /api/users/v1/app-transaction/sync` | StoreKit transaction |
| `GET /api/documents/v1/list` | Query: `updatedAt`, `id`, `limit` |
| `GET /api/coaching/v2/chat/sync` | — |
| `GET /api/coaching/v2/plans/pull` | Cursor-based; `limit` and `cursor`, with cursor = `<ms>_<id>` |
| `GET /api/coaching/v2/schedule/pull` | Cursor-based; `scheduleRulesCursor` and `scheduleOccurrencesCursor` |
| `GET /api/coaching/v2/onboarding/list` | — |
| `GET /api/blog/<id>/<id>` | Article content |

## Next captures needed

Run `mitmweb -s capture/bevel_capture.py`, perform each action, and check the files in
`fixtures/captures/` before sharing them.

1. **Completed workout:** start a routine, do 1 exercise with 2 sets, finish, then edit and delete it.
   That covers the session push. The stored format can already be read with
   `live-check --suite workouts --sessions`.
2. **Cardio and exercise notes:** log or create a cardio workout, then add a note to an exercise.
3. **Journal:** log one numeric factor and one categorical factor, create a custom factor, and set a
   default.
4. **Nutrition:** log a **branded** food (to check `brandName`) and create a custom food.
5. **Sign-in (optional):** sign out and back in. This reveals the login endpoint and whether a refresh
   token exists.
