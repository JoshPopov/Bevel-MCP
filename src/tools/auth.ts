import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatDuration, summarizeJwt } from "../auth/jwt.js";
import { BevelAuthError, BevelNetworkError } from "../http/errors.js";
import { describeError, jsonResult, safeHandler, type ToolDeps } from "./shared.js";

/** Interactive password prompts on macOS (getpass/readpassphrase) silently cap input at 128 characters. */
const MACOS_PROMPT_LIMIT = 128;

export interface AuthStatus {
  configured: boolean;
  source?: string;
  sourceReadable?: boolean;
  sourceError?: string;
  claims?: ReturnType<typeof summarizeJwt> & { expiresIn?: string; lifetime?: string };
  claimsError?: string;
  /** Non-secret shape of an undecodable token, to diagnose truncation or paste errors. */
  credentialShape?: { length: number; segments: number };
  baseUrl: string;
  appVersion: string;
  timeZone: string;
  writesEnabled: boolean;
  notes: string[];
}

/** One minimal real request (custom Journal types changed since now) to see whether Bevel accepts the token. */
export type ApiCheck =
  | { ok: true; message: string }
  | { ok: false; message: string; reason: "credential" | "network" | "api" };

export async function checkApi(deps: ToolDeps): Promise<ApiCheck> {
  try {
    await deps.journal.pullCustomJournalTypes({ lastSyncDate: Date.now(), limit: 1, maxPages: 1, fresh: true });
    return { ok: true, message: "Bevel accepted the token." };
  } catch (error) {
    const { message } = describeError(error);
    const reason = error instanceof BevelNetworkError
      ? "network"
      : error instanceof BevelAuthError && !message.includes("BEVEL_APP_VERSION")
        ? "credential"
        : "api";
    return { ok: false, message, reason };
  }
}

/** Builds the auth report. Never includes the token itself. */
export async function getAuthStatus(deps: ToolDeps): Promise<AuthStatus> {
  const { config, tokenProvider } = deps;
  const status: AuthStatus = {
    configured: tokenProvider !== undefined,
    baseUrl: config.baseUrl,
    appVersion: config.appVersion,
    timeZone: config.timeZone,
    writesEnabled: config.enableWrites,
    notes: [],
  };
  if (!tokenProvider) {
    status.notes.push(
      "No token source configured. On macOS run `bevel-mcp token capture`; elsewhere set BEVEL_TOKEN_FILE, BEVEL_TOKEN_COMMAND or BEVEL_TOKEN.",
    );
    return status;
  }
  status.source = tokenProvider.source;

  let token: string;
  try {
    token = await tokenProvider.getToken();
    status.sourceReadable = true;
  } catch (error) {
    status.sourceReadable = false;
    status.sourceError = describeError(error).message;
    return status;
  }

  try {
    const claims = summarizeJwt(token, Date.now());
    status.claims = {
      ...claims,
      ...(claims.secondsUntilExpiry !== undefined ? { expiresIn: formatDuration(claims.secondsUntilExpiry) } : {}),
      ...(claims.lifetimeSeconds !== undefined ? { lifetime: formatDuration(claims.lifetimeSeconds) } : {}),
    };
    if (claims.expired) {
      status.notes.push("Token is expired: capture a fresh one from the app's traffic.");
    } else if (claims.secondsUntilExpiry !== undefined && claims.secondsUntilExpiry < 7 * 86400) {
      status.notes.push("Token expires within 7 days: capture a fresh one soon.");
    }
    if (!claims.issuer && !claims.providerHint) {
      status.notes.push("Token has no `iss` claim, so the auth provider cannot be inferred from it.");
    }
    if (claims.providerHint === "Firebase Authentication") {
      status.notes.push(
        "Firebase-issued token: a refresh-token flow via securetoken.googleapis.com is probably possible later.",
      );
    }
  } catch (error) {
    status.claimsError = describeError(error).message;
    const segments = token.split(".").length;
    status.credentialShape = { length: token.length, segments };
    if (segments < 3 && token.startsWith("eyJ") && token.length <= MACOS_PROMPT_LIMIT) {
      status.notes.push(
        `Token looks truncated: it is ${token.length} characters with ${segments} segment(s), but a Bevel JWT has 3 segments and is several hundred characters. ` +
          `The macOS \`security add-generic-password -w\` prompt keeps only the first ${MACOS_PROMPT_LIMIT} characters. ` +
          "Copy the token again, then run bevel-mcp token set.",
      );
    } else {
      status.notes.push("Token is not a decodable JWT; check that the whole value was copied (a JWT is three dot-separated segments starting with eyJ).");
    }
  }
  return status;
}

export function registerAuthTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "bevel_auth_status",
    {
      title: "Bevel auth status",
      description:
        "Reports whether a Bevel API token is configured and decodes its non-secret JWT claims locally " +
        "(account, issued/expiry times, lifetime). With checkApi, also makes one tiny request to confirm Bevel accepts it. " +
        "Never returns the token.",
      inputSchema: { checkApi: z.boolean().optional().describe("Also confirm with Bevel that the token works (one small request).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeHandler("bevel_auth_status", deps.logger, async (args) => {
      const status = await getAuthStatus(deps);
      return jsonResult(args.checkApi && status.sourceReadable && !status.claimsError && !status.claims?.expired
        ? { ...status, api: await checkApi(deps) }
        : status);
    }),
  );
}
