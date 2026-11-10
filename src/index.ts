#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { redactString } from "./log.js";
import { applyServeArgs } from "./serve.js";
import { buildDeps, createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = buildDeps(config);
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  deps.logger.info("bevel-mcp started", {
    version: SERVER_VERSION,
    baseUrl: config.baseUrl,
    tokenSource: deps.tokenProvider?.source ?? "none",
    writesEnabled: config.enableWrites,
    timeZone: config.timeZone,
  });
}

const args = process.argv.slice(2);
if (args.length > 0 && args[0] !== "serve") {
  // Helper commands (bevel-mcp token capture, status, …). With no arguments, run the MCP server.
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const { runCli, terminalIo } = await import("./cli/index.js");
  process.exitCode = await runCli(args, terminalIo(controller.signal));
} else {
  // No arguments, or `serve` with settings as flags: run the MCP server.
  try {
    applyServeArgs(args.slice(1));
  } catch (error) {
    process.stderr.write(`bevel-mcp serve: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  main().catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`bevel-mcp failed to start: ${redactString(message)}\n`);
    process.exit(1);
  });
}
