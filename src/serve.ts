import { parseArgs } from "node:util";

/**
 * `bevel-mcp serve [--writes | --read-only] [--file PATH] [--timezone TZ] [--app-version V]` runs
 * the MCP server with its settings as arguments. Every MCP client can pass a command and arguments,
 * but they differ in how (or whether) they set environment variables. Arguments override the
 * environment.
 */
export interface ServeSettings {
  writes: boolean;
  tokenFile?: string;
  timeZone?: string;
  appVersion?: string;
}

/** The environment variables that `serve` arguments stand for. Throws on unknown or conflicting flags. */
export function serveEnv(args: string[]): Record<string, string> {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      writes: { type: "boolean" },
      "read-only": { type: "boolean" },
      file: { type: "string" },
      timezone: { type: "string" },
      "app-version": { type: "string" },
    },
  });
  if (values.writes && values["read-only"]) throw new Error("Choose either --writes or --read-only, not both.");
  return {
    ...(values.writes ? { BEVEL_ENABLE_WRITES: "true" } : {}),
    ...(values["read-only"] ? { BEVEL_ENABLE_WRITES: "false" } : {}),
    ...(values.file ? { BEVEL_TOKEN_FILE: values.file } : {}),
    ...(values.timezone ? { BEVEL_TIMEZONE: values.timezone } : {}),
    ...(values["app-version"] ? { BEVEL_APP_VERSION: values["app-version"] } : {}),
  };
}

/** Applies `serve` arguments to the environment. An explicit --file beats a BEVEL_TOKEN set elsewhere. */
export function applyServeArgs(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const overrides = serveEnv(args);
  if (overrides.BEVEL_TOKEN_FILE) delete env.BEVEL_TOKEN;
  Object.assign(env, overrides);
}

/** The `serve` arguments for these settings (read-only needs none: it is the default). */
export function serveArgs(settings: ServeSettings): string[] {
  return [
    "serve",
    ...(settings.writes ? ["--writes"] : []),
    ...(settings.tokenFile ? ["--file", settings.tokenFile] : []),
    ...(settings.timeZone ? ["--timezone", settings.timeZone] : []),
    ...(settings.appVersion ? ["--app-version", settings.appVersion] : []),
  ];
}
