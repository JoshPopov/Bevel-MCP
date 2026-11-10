/**
 * Where `bevel-mcp token …` saves the token. On macOS that's the Keychain item the server reads by
 * default; elsewhere a file with owner-only permissions.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactString } from "../log.js";

export const KEYCHAIN_SERVICE = "bevel-mcp";
export const KEYCHAIN_ACCOUNT = "token";
export const DEFAULT_TOKEN_FILE = join(homedir(), ".config", "bevel-mcp", "token");
export const CAPTURE_CONFIG_DIR = join(homedir(), ".config", "bevel-mcp", "proxy");

export type Runner = (file: string, args: string[], input?: string) => Promise<{ stdout: string }>;

/**
 * Runs a command without a shell. Errors are rebuilt from the exit code and stderr only: Node's own
 * message includes the full argument list, which may contain the token.
 */
export const defaultRunner: Runner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code ?? (error as { signal?: string }).signal ?? "error";
        const detail = redactString(String(stderr).trim()).slice(0, 300);
        reject(new Error(`${file.split("/").pop()} failed (${code})${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve({ stdout: String(stdout) });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // execFile reports failures if the child closes its pipe.
      child.stdin.end(input);
    }
  });

export interface TokenStore {
  readonly description: string;
  save(token: string): Promise<void>;
  /** The currently saved token, if any (used to avoid replacing it with an older one). */
  load?(): Promise<string | undefined>;
}

export class KeychainStore implements TokenStore {
  readonly description: string;
  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly service = KEYCHAIN_SERVICE,
    private readonly account = KEYCHAIN_ACCOUNT,
  ) {
    this.description = `macOS Keychain (service "${service}", account "${account}")`;
  }

  async save(token: string): Promise<void> {
    // Feed security's batch parser over a pipe. The password prompt truncates long tokens.
    const values = [this.service, this.account, token];
    if (values.some((value) => /[\r\n\0]/.test(value))) throw new Error("Invalid Keychain input.");
    const [service, account, password] = values.map((value) => JSON.stringify(value));
    const command = `add-generic-password -U -s ${service} -a ${account} -w ${password}\n`;
    if (Buffer.byteLength(command) >= 4096) throw new Error("The token is too long for the macOS Keychain command. Use --file.");
    try {
      await this.run("/usr/bin/security", ["-i"], command);
    } catch {
      throw new Error("Could not save the token in macOS Keychain. Check that your login Keychain is unlocked.");
    }
    const { stdout } = await this.run("/usr/bin/security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
    if (stdout.trim() !== token) throw new Error("The Keychain item did not read back correctly after saving.");
  }

  async load(): Promise<string | undefined> {
    try {
      const { stdout } = await this.run("/usr/bin/security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
      return stdout.trim() || undefined;
    } catch (error) {
      if (error instanceof Error && /failed \(44\)|could not be found in the keychain/i.test(error.message)) return undefined;
      throw error;
    }
  }
}

export class FileStore implements TokenStore {
  readonly description: string;
  constructor(private readonly path: string = DEFAULT_TOKEN_FILE) {
    this.description = `file ${path}`;
  }

  async save(token: string): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(parent, ".bevel-token-"));
    try {
      const pending = join(temporary, "token");
      await writeFile(pending, token, { mode: 0o600 });
      await rename(pending, this.path);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async load(): Promise<string | undefined> {
    try {
      return (await readFile(this.path, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export function defaultStore(platform: NodeJS.Platform = process.platform): TokenStore {
  return platform === "darwin" ? new KeychainStore() : new FileStore();
}
