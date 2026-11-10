/**
 * End-to-end smoke test of the built server over real stdio, against a local mock Bevel API.
 * Run with: npm run smoke
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "bevel_auth_status",
  "bevel_clear_journal_boolean",
  "bevel_create_custom_exercise",
  "bevel_delete_food_log",
  "bevel_delete_routine",
  "bevel_get_food_logs",
  "bevel_log_food",
  "bevel_save_routine",
  "bevel_search_food",
  "bevel_update_food_log",
  "bevel_get_custom_journal_types",
  "bevel_get_journal",
  "bevel_get_macro_goals",
  "bevel_get_workout_data",
  "bevel_get_workout_history",
  "bevel_set_journal_boolean",
  "bevel_set_macro_goals",
];

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
// Same claim layout as a real Bevel token: userId/iat/exp, 60-day lifetime, no issuer.
const fakeToken = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ userId: "smoke-user-123", iat: now, exp: now + 5_184_000 })}.sig`;
const stored = []; // journal entries the fake server holds
let routine;

const requests = [];
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/journal/v1/user-journal-data/push")) {
      const entry = JSON.parse(body).booleanJournals[0];
      const uuid = entry.uuid;
      const index = stored.findIndex((e) => e.uuid === uuid);
      if (index >= 0) stored[index] = entry; else stored.push(entry); // upsert by uuid, like Bevel
      const empty = { succeeded: [], failed: [] };
      res.end(JSON.stringify({
        customJournalTypes: empty, booleanJournals: { succeeded: [uuid], failed: [] },
        booleanJournalDefaults: empty, categoricalJournalDefaults: empty, numericJournalDefaults: empty,
      }));
    } else if (req.url.startsWith("/api/journal/v1/user-journal-data/pull")) {
      res.end(JSON.stringify({
        moreAvailable: false, offset: 100,
        journalData: { booleanJournals: stored, booleanJournalDefaults: [], categoricalJournalDefaults: [], numericJournalDefaults: [] },
      }));
    } else if (req.url.startsWith("/api/journal/v1/custom-journal-types/pull")) {
      res.end(JSON.stringify({ moreAvailable: false, offset: 1, customJournalTypes: [] }));
    } else if (req.url.startsWith("/api/fitness/v1/user-fitness-data/pull")) {
      res.end(JSON.stringify({ moreAvailable: false, offset: 30, fitnessData: {
        customExercises: [], strengthWorkoutTemplates: routine ? [routine] : [],
        cardioWorkoutTemplates: [], strengthWorkoutSessions: [], exerciseNotes: [],
      } }));
    } else if (req.url.startsWith("/api/fitness/v1/user-fitness-data/push")) {
      const [entry] = JSON.parse(body).strengthWorkoutTemplates;
      if (entry.isDeleted) {
        res.end(JSON.stringify({ strengthWorkoutTemplates: { succeeded: [], failed: [entry.id] } }));
      } else {
        routine = entry;
        res.end(JSON.stringify({ strengthWorkoutTemplates: { succeeded: [entry.id], failed: [] } }));
      }
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${mock.address().port}`;

async function connect(extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", BEVEL_TOKEN: fakeToken, BEVEL_BASE_URL: baseUrl, BEVEL_LOG_LEVEL: "error", BEVEL_TIMEZONE: "America/New_York", ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
const text = (result) => result.content.map((c) => c.text).join("\n");

let client = await connect({ BEVEL_ENABLE_WRITES: "false" });
try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, EXPECTED_TOOLS.slice().sort());
  console.log("✓ tools/list:", tools.join(", "));

  const auth = await client.callTool({ name: "bevel_auth_status", arguments: {} });
  assert.ok(!text(auth).includes(fakeToken), "auth status must not leak the token");
  assert.match(text(auth), /Bevel's own auth service/);
  assert.match(text(auth), /"lifetime": "60d"/);
  console.log("✓ bevel_auth_status recognises a Bevel-shaped token without leaking it");

  const dry = await client.callTool({ name: "bevel_set_journal_boolean", arguments: { factorKey: "addedSugar", value: true, date: "2026-11-10", dryRun: true } });
  const dryBody = JSON.parse(text(dry));
  assert.equal(dryBody.request.body.booleanJournals[0].identifyingDate, 1794330000000);
  assert.equal(dryBody.action, "created");
  assert.deepEqual(requests.map((r) => r.method), ["GET"], "dry run only looks up, never pushes");
  console.log("✓ dryRun looks up the day, builds the captured payload shape (identifyingDate 1794330000000), pushes nothing");

  const before = requests.length;
  const refused = await client.callTool({ name: "bevel_set_journal_boolean", arguments: { factorKey: "addedSugar", value: true, date: "2026-11-10" } });
  assert.equal(refused.isError, true);
  assert.equal(requests.length, before, "refused before any network call");
  console.log("✓ real write refused while BEVEL_ENABLE_WRITES=false");

  const pulled = await client.callTool({ name: "bevel_get_journal", arguments: { limit: 1 } });
  assert.ok(!pulled.isError, text(pulled));
  assert.equal(requests.at(-1).url, "/api/journal/v1/user-journal-data/pull?offset=0&limit=1&lastSyncDate=0");
  assert.equal(requests.at(-1).headers.authorization, `Bearer ${fakeToken}`);
  assert.equal(requests.at(-1).headers["bevel-app-version"], "3.2.7");
  assert.equal(requests.at(-1).headers.accept, "application/json");
  assert.match(requests.at(-1).headers["request-id"], /^[0-9A-F-]{36}$/);
  console.log("✓ bevel_get_journal sends the app's headers and paging query");
} finally {
  await client.close();
}

client = await connect({ BEVEL_ENABLE_WRITES: "true" });
try {
  const set = (value) => client.callTool({ name: "bevel_set_journal_boolean", arguments: { factorKey: "deviceInBed", value, date: "2026-11-10" } });

  const created = await set(true);
  assert.ok(!created.isError, text(created));
  const push = requests.at(-1);
  assert.equal(push.method, "POST");
  assert.equal(push.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(JSON.parse(push.body)), ["booleanJournalDefaults", "customJournalTypes", "booleanJournals", "numericJournalDefaults", "categoricalJournalDefaults"]);
  const createdOut = JSON.parse(text(created));
  assert.equal(createdOut.action, "created");
  console.log("✓ first write creates the entry and verifies its UUID");

  const updated = JSON.parse(text(await set(false)));
  assert.equal(updated.action, "updated");
  assert.equal(updated.uuid, createdOut.uuid, "update reuses the uuid");
  assert.equal(stored.length, 1, "no duplicate entry on the server");
  assert.equal(stored[0].boolValue, false);
  console.log("✓ second write updates the same entry in place (no duplicate)");

  const unchanged = JSON.parse(text(await set(false)));
  assert.equal(unchanged.action, "unchanged");
  console.log("✓ repeating the same value is a no-op");

  const liveCheck = (args, suite = "journal") => promisify(execFile)(process.execPath, [
    "scripts/live-check.mjs", "--suite", suite, "--date", "2026-11-10", "--factor", "deviceInBed", ...args,
  ], { env: { ...process.env, BEVEL_TOKEN: fakeToken, BEVEL_BASE_URL: baseUrl, BEVEL_ENABLE_WRITES: "true", BEVEL_LOG_LEVEL: "debug" } });
  const start = requests.length;
  await assert.rejects(liveCheck(["--write"]), (error) => error.code === 2 && /persistent/.test(error.stderr));
  assert.equal(requests.length, start, "unconfirmed persistent writes stop before touching Bevel");
  const { stdout, stderr } = await liveCheck([]);
  assert.match(stdout, /All checks passed/);
  assert.equal(stderr, "", "server debug logs are private");
  for (const privateValue of [fakeToken, "deviceInBed", createdOut.uuid, "2026-11-10"]) {
    assert.ok(!stdout.includes(privateValue), "default diagnostic report omits health details");
  }
  assert.ok(requests.slice(start).every((request) => request.method === "GET"));
  console.log("✓ live-check gates persistent writes and keeps health data out of the default report");
  await assert.rejects(liveCheck(["--write"], "workouts"), (error) =>
    error.code === 1 && /Cleanup could not be confirmed/.test(error.stdout) && !/✓ Delete test routine/.test(error.stdout));
  assert.ok(routine, "the mock kept the routine after rejecting deletion");
  console.log("✓ live-check reports a failed cleanup and exits unsuccessfully");
} finally {
  await client.close();
  mock.close();
}
console.log("\nSmoke test passed.");
