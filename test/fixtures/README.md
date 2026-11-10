# Test fixtures

Synthetic payloads that follow the structure of traffic captured from Bevel iOS 3.2.7
(documented in `docs/API_NOTES.md`). No captured data is copied here: identifiers are placeholders.

| File | Models |
|---|---|
| `journal-push-boolean.request.json` / `.response.json` | Creating a Boolean entry (new UUID, `createdAt == updatedAt` era) |
| `journal-push-boolean-update.request.json` | Editing that entry: same `uuid` and `createdAt`, new `boolValue` and `updatedAt`. The app sends keys in arbitrary order. |
| `journal-pull-empty.response.json` | `GET .../user-journal-data/pull` envelope (`moreAvailable`, next `offset`, `journalData`) |
| `journal-pull-live-shape.response.json` | Pulled entries as Bevel really returns them: `updatedAt` as an ISO string, and a cleared factor (`isNotSet: true`, no `boolValue`) |
| `food-search-item.json` | One `/api/nutrition/v2/search/query` result item (`{food, clientScore, searchScore}`), synthetic "Test Coffee" with null portion fields and a caffeine nutrient |
| `custom-journal-types-pull-empty.response.json` | `GET .../custom-journal-types/pull` envelope |

Never commit raw captures: they contain tokens, device push tokens, user IDs and health data.
