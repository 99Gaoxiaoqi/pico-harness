import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VERSION = 1 as const;

/** User-level discovery index; the authoritative Jobs/Runs remain in each workspace SQLite ledger. */
export class WorkspaceRegistrationStore {
  readonly filePath: string;

  constructor(filePath = join(homedir(), ".pico", "daemon-workspaces.json")) {
    this.filePath = filePath;
  }

  async list(): Promise<readonly string[]> {
    return (await this.read()).workspaces;
  }

  async register(workspacePath: string): Promise<string> {
    const canonical = await realpath(workspacePath);
    const state = await this.read();
    if (!state.workspaces.includes(canonical)) {
      await this.write({ version: VERSION, workspaces: [...state.workspaces, canonical].sort() });
    }
    return canonical;
  }

  async unregister(workspacePath: string): Promise<string> {
    const canonical = await realpath(workspacePath);
    const state = await this.read();
    if (state.workspaces.includes(canonical)) {
      await this.write({ version: VERSION, workspaces: state.workspaces.filter((path) => path !== canonical) });
    }
    return canonical;
  }

  private async read(): Promise<{ version: typeof VERSION; workspaces: string[] }> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: DIRECTORY_MODE });
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isState(value)) throw new Error(`daemon workspace registry 格式无效: ${this.filePath}`);
      return { version: VERSION, workspaces: [...new Set(value.workspaces)].sort() };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { version: VERSION, workspaces: [] };
      throw error;
    }
  }

  private async write(state: { version: typeof VERSION; workspaces: readonly string[] }): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      await chmod(temporary, FILE_MODE);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, FILE_MODE);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }
}

function isState(value: unknown): value is { version: typeof VERSION; workspaces: string[] } {
  return typeof value === "object" && value !== null &&
    (value as { version?: unknown }).version === VERSION &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    (value as { workspaces: unknown[] }).workspaces.every((path) => typeof path === "string");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
