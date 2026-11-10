import { networkInterfaces } from "node:os";

/** This machine's LAN IPv4 addresses, Wi-Fi (en0) first: what the iPhone's proxy setting needs. */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push({ name, address: entry.address });
    }
  }
  const rank = (name: string) => (name === "en0" ? 0 : name.startsWith("en") ? 1 : 2);
  return found.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).map((f) => f.address);
}
