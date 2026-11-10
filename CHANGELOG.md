# Changelog

## 1.0.0 (2026-11-10)

- Ready to go public: an MIT license, a security policy, issue templates, and a shorter README with a
  banner and CLI screenshots. Details moved to `docs/GUIDE.md` and `docs/DEVELOPMENT.md`.
- Added macOS setup and doctor commands for Claude Code and Claude Desktop. Setup prepares an iPhone certificate profile for AirDrop.
- Setup now accepts `--writes` and `--read-only`. It keeps an entry that already allows writes instead of
  refusing it, and asks before updating one it wrote earlier.
- Setup and doctor no longer fail when Claude Code's status output can't be read. They warn instead,
  because the server itself was already verified. A reported failure is still an error.
- `npm run setup` and `npm run doctor` rebuild first.
- Setup can also connect Grok Build. It can show a JSON config for any other MCP client, or write a
  prompt that tells an AI agent how to add the server itself.
- `bevel-mcp serve` runs the server with its settings as arguments (`--writes`, `--file`, `--timezone`,
  `--app-version`), for clients that can't set environment variables.
- The CLI has colour, the Bevel logo, boxed summaries and progress spinners in an interactive terminal.
  Piped output stays plain, and `NO_COLOR` turns colour off.
- Isolated the capture proxy, verified captured tokens before saving, and moved Keychain writes to stdin.
- Made live-check output shareable by default and clarified which write checks persist.
- Serialized matching Journal writes and kept overlapping reads out of the write-invalidated cache.
- Added macro-goal recovery guidance for partial pushes and tested the minimum Node version on macOS.
- `bevel-mcp token capture`: takes the token from the Bevel app's own requests through mitmproxy and
  saves it to the Keychain. It keeps the token that expires last, and keeps a working saved token that expires later,
  and requires `--force` to switch accounts.
- `bevel-mcp token set`: saves a token from the clipboard. `bevel-mcp status [--check]` shows token
  details and can confirm that Bevel accepts the token.
- On macOS the server reads the Keychain token by default, so the MCP config needs no token setting.
- The time zone defaults to the computer's own.
- Reads are cached for 60 seconds per session (`BEVEL_CACHE_SECONDS`). Writes always read fresh data
  and clear the cache.
- Errors say when Bevel seems to require a newer app version (`BEVEL_APP_VERSION`).
- `bevel_get_workout_history`: completed workouts, read-only.
- Food logs are read in Bevel's stored format and converted back for edits and deletes.
- kg weights now use the app's own conversion (× 2.20462).
- The live check covers food-log edits and routine replacement.
- CI runs the typecheck, unit tests, smoke test and mitmproxy addon tests.

## 0.2.0

- New tools for macro goals (read and set), meals (search, log, list, edit, delete) and workouts
  (routines and custom exercises).
- Journal clear.
- Shared push verification and lenient pull parsing.

## 0.1.0

- Journal proof of concept:
  - auth status
  - reading the Journal
  - setting a yes/no factor, updating the day's entry in place as the app does
