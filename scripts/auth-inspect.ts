/**
 * npm run auth:inspect [-- --json]
 *
 * Reads the token from the configured source (BEVEL_TOKEN_COMMAND / BEVEL_TOKEN_FILE / BEVEL_TOKEN,
 * or a local .env file) and prints its non-secret claims. The token itself is never printed.
 */
import { existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { buildDeps } from "../src/server.js";
import { getAuthStatus } from "../src/tools/auth.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const asJson = process.argv.includes("--json");
const config = loadConfig();
const status = await getAuthStatus(buildDeps(config, { logger: silentLogger }));

if (asJson) {
  console.log(JSON.stringify(status, null, 2));
} else {
  const c = status.claims;
  const rows: [string, unknown][] = [
    ["Token source", status.source ?? "(none configured)"],
    ["Readable", status.sourceReadable ?? false],
    ...(status.sourceError ? ([["Read error", status.sourceError]] as [string, unknown][]) : []),
    ...(c
      ? ([
          ["Issuer (iss)", c.issuer ?? "(none)"],
          ["Likely provider", c.providerHint ?? "(unrecognised issuer)"],
          ["Sign-in provider", c.signInProvider ?? "(n/a)"],
          ["Audience (aud)", c.audience ?? "(none)"],
          ["Subject (sub, masked)", c.subject ?? "(none)"],
          ["Algorithm", c.algorithm ?? "(none)"],
          ["Issued at", c.issuedAt ?? "(no iat)"],
          ["Expires at", c.expiresAt ?? "(no exp)"],
          ["Lifetime", c.lifetime ?? "(unknown)"],
          ["Expires in", c.expiresIn ?? "(unknown)"],
          ["Claim names", c.claimNames.join(", ")],
        ] as [string, unknown][])
      : []),
    ...(status.claimsError ? ([["Decode error", status.claimsError]] as [string, unknown][]) : []),
    ...(status.credentialShape
      ? ([
          ["Token length", `${status.credentialShape.length} characters`],
          ["Segments", `${status.credentialShape.segments} (a JWT has 3)`],
        ] as [string, unknown][])
      : []),
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    console.log(`${key.padEnd(width)}  ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  for (const note of status.notes) console.log(`\nNote: ${note}`);
  console.log("\nSafe to share: everything above. Never share the token itself.");
}
