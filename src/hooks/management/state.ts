import { readFile } from "node:fs/promises";
import { assertRegularNonSymlink, writeWorkspaceFileAtomic } from "../trust/secure-file.js";
import { resolvePicoPaths, type ResolvePicoPathsOptions } from "../../paths/pico-paths.js";

interface HookLocalStateFile {
  version: 1;
  enabled: Readonly<Record<string, boolean>>;
}

export class HookLocalStateStore {
  readonly filePath: string;

  constructor(workDir: string, options: ResolvePicoPathsOptions = {}) {
    this.filePath = resolvePicoPaths(workDir, options).workspace.hookState;
  }

  async getAll(): Promise<Readonly<Record<string, boolean>>> {
    if ((await assertRegularNonSymlink(this.filePath)) === "missing") return {};
    const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !isBooleanRecord(parsed.enabled)) {
      throw new Error("hooks-state.local.json schema 无效");
    }
    return parsed.enabled;
  }

  async set(handlerId: string, enabled: boolean): Promise<void> {
    if (!/^[a-z]+:[a-f0-9]{64}$/.test(handlerId)) throw new Error("Hook handler id 无效");
    const current = await this.getAll();
    const body: HookLocalStateFile = { version: 1, enabled: { ...current, [handlerId]: enabled } };
    await writeWorkspaceFileAtomic(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isBooleanRecord(input: unknown): input is Record<string, boolean> {
  return isRecord(input) && Object.values(input).every((value) => typeof value === "boolean");
}
