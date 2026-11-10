import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyServeArgs, serveArgs, serveEnv } from "../src/serve.js";
import { makeJwt } from "./helpers.js";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("bevel-mcp serve arguments", () => {
  it("turn into the server's environment settings, and back", () => {
    assert.deepEqual(serveEnv([]), {});
    assert.deepEqual(serveEnv(["--writes", "--file", "/t/token", "--timezone", "Europe/London", "--app-version", "3.3.0"]), {
      BEVEL_ENABLE_WRITES: "true",
      BEVEL_TOKEN_FILE: "/t/token",
      BEVEL_TIMEZONE: "Europe/London",
      BEVEL_APP_VERSION: "3.3.0",
    });
    assert.deepEqual(serveEnv(["--read-only"]), { BEVEL_ENABLE_WRITES: "false" });
    const settings = { writes: true, tokenFile: "/a b/token", timeZone: "America/New_York" };
    const args = serveArgs(settings);
    assert.deepEqual(args, ["serve", "--writes", "--file", "/a b/token", "--timezone", "America/New_York"]);
    assert.deepEqual(serveEnv(args.slice(1)), {
      BEVEL_ENABLE_WRITES: "true", BEVEL_TOKEN_FILE: "/a b/token", BEVEL_TIMEZONE: "America/New_York",
    });
    assert.deepEqual(serveArgs({ writes: false }), ["serve"], "read-only is the default");
  });

  it("reject unknown or conflicting flags, and let --file beat an inherited BEVEL_TOKEN", () => {
    assert.throws(() => serveEnv(["--writes", "--read-only"]), /either --writes or --read-only/);
    assert.throws(() => serveEnv(["--token", "x"]), /Unknown option/);
    assert.throws(() => serveEnv(["extra"]), /positional/);
    const env: NodeJS.ProcessEnv = { BEVEL_TOKEN: "inherited", BEVEL_ENABLE_WRITES: "true" };
    applyServeArgs(["--file", "/t/token", "--read-only"], env);
    assert.deepEqual(env, { BEVEL_TOKEN_FILE: "/t/token", BEVEL_ENABLE_WRITES: "false" });
  });

  it("start the built server with those settings", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = new Client({ name: "serve-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "serve", "--writes", "--timezone", "Europe/London"],
      env: { BEVEL_TOKEN: makeJwt({ userId: "u_1", iat: now, exp: now + 3600 }), BEVEL_LOG_LEVEL: "error" },
      stderr: "ignore",
    }));
    try {
      const result = await client.callTool({ name: "bevel_auth_status", arguments: {} });
      const part = (result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text");
      const status = JSON.parse(part!.text!);
      assert.equal(status.writesEnabled, true);
      assert.equal(status.timeZone, "Europe/London");
    } finally {
      await client.close();
    }
  });
});
