import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VERSION = 1 as const;

/** User-level discovery index; the authoritative Jobs/Runs remain in each workspace SQLite ledger. */
export class WorkspaceRegistrationStore {
  readonly filePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(filePath = join(resolvePicoHome(), "daemon-workspaces.json")) {
    this.filePath = filePath;
  }

  async list(): Promise<readonly string[]> {
    let workspaces: readonly string[] = [];
    await this.mutate(async () => {
      const state = await this.read();
      workspaces = await normalizeWorkspacePaths(state.workspaces, true);
      const persisted = await normalizeWorkspacePaths(state.workspaces);
      if (!samePaths(state.workspaces, persisted)) {
        await this.write({ version: VERSION, workspaces: persisted });
      }
    });
    return workspaces;
  }

  async register(workspacePath: string): Promise<string> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    await this.mutate(async () => {
      const state = await this.read();
      const normalized = await normalizeWorkspacePaths(state.workspaces);
      const workspaces = [...new Set([...normalized, canonical])].sort();
      if (!samePaths(state.workspaces, workspaces)) {
        await this.write({ version: VERSION, workspaces });
      }
    });
    return canonical;
  }

  async unregister(workspacePath: string): Promise<string> {
    const candidates = await unregisterCandidates(workspacePath);
    let canonical = candidates[0] ?? resolve(workspacePath);
    await this.mutate(async () => {
      const state = await this.read();
      const normalized = await normalizeWorkspacePaths(state.workspaces);
      canonical = candidates.find((candidate) => normalized.includes(candidate)) ?? canonical;
      const workspaces = normalized.filter((path) => !candidates.includes(path));
      if (!samePaths(state.workspaces, workspaces)) {
        await this.write({
          version: VERSION,
          workspaces,
        });
      }
    });
    return canonical;
  }

  async resolveRegisteredPath(workspacePath: string): Promise<string> {
    const candidates = await unregisterCandidates(workspacePath);
    let canonical = candidates[0] ?? resolve(workspacePath);
    await this.mutate(async () => {
      const state = await this.read();
      const normalized = await normalizeWorkspacePaths(state.workspaces);
      canonical = candidates.find((candidate) => normalized.includes(candidate)) ?? canonical;
    });
    return canonical;
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    const queued = this.mutationQueue.then(operation, operation);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
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

  private async write(state: {
    version: typeof VERSION;
    workspaces: readonly string[];
  }): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
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

async function unregisterCandidates(workspacePath: string): Promise<string[]> {
  const absolute = resolve(workspacePath);
  try {
    return [await canonicalizeWorkspacePath(absolute)];
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const ancestor = await nearestExistingAncestor(absolute);
  if (!ancestor) return [absolute];
  const canonicalAncestor = await canonicalizeWorkspacePath(ancestor.physical);
  const physicalTarget = resolve(ancestor.physical, relative(ancestor.logical, absolute));
  return [...new Set([canonicalAncestor, physicalTarget, absolute])];
}

async function nearestExistingAncestor(
  input: string,
): Promise<{ logical: string; physical: string } | undefined> {
  let candidate = input;
  while (true) {
    try {
      return { logical: candidate, physical: await realpath(candidate) };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function normalizeWorkspacePaths(
  paths: readonly string[],
  dropMissing = false,
): Promise<string[]> {
  const normalized = await Promise.all(
    paths.map(
      async (path) =>
        await canonicalizeWorkspacePath(path).catch((error: unknown) => {
          if (dropMissing && isErrno(error, "ENOENT")) return undefined;
          return path;
        }),
    ),
  );
  return [...new Set(normalized.filter((path): path is string => path !== undefined))].sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isState(value: unknown): value is { version: typeof VERSION; workspaces: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === VERSION &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    (value as { workspaces: unknown[] }).workspaces.every((path) => typeof path === "string")
  );
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
