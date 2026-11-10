# Development

## Checks

Typecheck:

```bash
npm run typecheck
```

Unit tests:

```bash
npm test
```

Build, then start the stdio server and exercise it:

```bash
npm run smoke
```

Test the mitmproxy addons. This needs the mitmproxy Python package:

```bash
npm run test:python
```

CI runs the first three on Linux (Node 22) and macOS (Node 20), and the addon tests on Linux.

## Live checks

`npm run live-check` runs the server against your account without an AI client. By default it prints
a summary you can share. `--show-private-output` prints the tool results, which can include your
health data, so keep that output local.

Every suite is **read-only** unless you pass `--write` and set `BEVEL_ENABLE_WRITES=true`:
- Journal and goal changes stay in your account, so they also need `--keep`.
- Meals and workouts clean up after themselves and check the cleanup, unless you pass `--keep`.
- If a cleanup can't be confirmed, check the app before retrying.

| Suite | Read-only run | With `--write` |
|---|---|---|
| `journal` | Reads a day (`--date`), then dry-runs setting a factor (`--factor`, `--value`) | Sets or clears it and checks the change |
| `goals` | Reads goals, and dry-runs `--protein`, `--carbs`, `--fat` if given | Sets the goals and checks them |
| `meals` | Searches `--food` (default "brewed coffee") and reads today's log | Logs the food, edits it to 2 servings, then deletes it, reading back after each step. `--keep` stops after logging. |
| `workouts` | Reads routines and the 2 latest workouts | Creates a test routine, replaces it, then deletes it, reading back after each step |

A read-only run:

```bash
npm run live-check -- --suite meals
```

The same suite with writes:

```bash
BEVEL_ENABLE_WRITES=true npm run live-check -- --suite meals --write
```

## Mapping more of the API

`capture/bevel_capture.py` saves each `api.supersethealth.com` request and response as a JSON file in
`fixtures/captures/`, with tokens redacted. That folder is gitignored because the files still contain
your health data. Review them before copying anything into `test/fixtures/`, and use made-up values
there.

To capture live, run it with mitmweb:

```bash
mitmweb -s capture/bevel_capture.py
```

To process a flow file you saved earlier:

```bash
mitmdump -n -r ~/Downloads/flows.mitm -s capture/bevel_capture.py
```

The captures still needed are listed at the end of [API_NOTES.md](API_NOTES.md).

## Layout

- `src/index.ts`: starts the MCP server (no command, or `serve`) or the CLI.
- `src/serve.ts`: `serve` arguments.
- `src/http/client.ts`: the only module that talks HTTP. It sets headers, rereads the token on
  401/403, retries GETs and holds the read cache.
- `src/auth/`: token providers and local JWT decoding.
- `src/api/`: endpoints and payloads, limited to what has been observed. `pull.ts` and `push.ts` hold
  the sync protocol; `journal.ts`, `goals.ts`, `nutrition.ts`, `foodMapping.ts` and `fitness.ts`
  cover each area.
- `src/tools/`: MCP tool definitions, one module per area.
- `src/cli/`: setup, doctor, token and status commands. `ui.ts` has the colours, boxes, logo and
  spinner.
- `capture/`: the mitmproxy addons.
