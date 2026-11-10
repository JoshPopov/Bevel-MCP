import { randomUUID, X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Build a removable iOS profile from the public CA of this capture proxy. */
export async function prepareIphoneProfile(configDir: string): Promise<string> {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(await readFile(join(configDir, "mitmproxy-ca-cert.pem")));
    if (!certificate.ca) throw new Error("Expected a CA certificate");
  } catch {
    throw new Error("Could not read the Bevel proxy’s public certificate. Restart setup and check that mitmproxy starts.");
  }

  const identifier = "local.bevel-mcp.capture-ca." + certificate.fingerprint256.replaceAll(":", "").slice(0, 16).toLowerCase();
  const path = join(configDir, "Bevel Capture Certificate.mobileconfig");
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>${identifier}</string>
  <key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
  <key>PayloadDisplayName</key><string>Bevel Capture Certificate</string>
  <key>PayloadDescription</key><string>Installs the public root certificate for the Bevel-MCP capture proxy on your Mac.</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>${identifier}.certificate</string>
      <key>PayloadUUID</key><string>${randomUUID().toUpperCase()}</string>
      <key>PayloadDisplayName</key><string>Bevel Capture Root Certificate</string>
      <key>PayloadCertificateFileName</key><string>mitmproxy-ca-cert.cer</string>
      <key>PayloadContent</key><data>${certificate.raw.toString("base64")}</data>
    </dict>
  </array>
</dict>
</plist>
`, { mode: 0o600 });
  return path;
}
