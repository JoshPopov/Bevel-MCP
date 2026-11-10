# Security

Bevel MCP handles a Bevel account token and personal health data, so security reports are welcome.

## Reporting a problem

Please report vulnerabilities privately through this repository's **Security › Report a
vulnerability** page, not in a public issue. Only the latest release is supported.

Never include any of these in a report or an issue:
- a Bevel token, or an `Authorization` header;
- a raw capture (`.mitm` file, `fixtures/captures/`) or `--show-private-output` results;
- your health data.

A `npm run doctor` report or the default `npm run live-check` summary is safe to share.

## How the token is protected

- On macOS it's stored in the Keychain, and written over stdin so it never appears in process arguments.
- Logs and error messages redact anything that looks like a token.
- The capture proxy intercepts only `api.supersethealth.com`, records no traffic, and uses its own
  certificate in `~/.config/bevel-mcp/proxy`. Remove the iPhone profile when you no longer need it.
- Write tools are off unless you turn them on, and every write supports a dry run.
