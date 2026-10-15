import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseStrictRuntimeParams, type RuntimeParams } from "@pico/protocol";
import { resolveCanonicalPicoHome } from "@pico/pico-host/pico-paths";
import { canonicalizeWorkspacePath } from "@pico/storage/workspace-path";

export interface PendingSendRecord {
  readonly version: 1;
  readonly params: RuntimeParams<"session.send">;
}

export interface PendingSendStore {
  load(): Promise<PendingSendRecord | undefined>;
  save(params: RuntimeParams<"session.send">): Promise<void>;
  clear(idempotencyKey: string): Promise<void>;
}

export class FilePendingSendStore implements PendingSendStore {
  private readonly recordPath: string;

  constructor(options: { picoHome?: string; workspacePath: string }) {
    const picoHome = options.picoHome ?? resolveCanonicalPicoHome();
    const workspace = canonicalizeWorkspacePath(options.workspacePath);
    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    this.recordPath = join(picoHome, "tui", "pending-sends", workspaceKey + ".json");
  }

  async load(): Promise<PendingSendRecord | undefined> {
    let metadata;
    try {
      metadata = await lstat(this.recordPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("待确认发送记录不是普通文件，已阻止自动恢复。");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.recordPath, "utf8"));
    } catch (error) {
      throw new Error("待确认发送记录无法读取：" + errorMessage(error), { cause: error });
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "params,version" ||
      (parsed as Record<string, unknown>)["version"] !== 1
    ) {
      throw new Error("待确认发送记录格式无效，已阻止重新发送。");
    }
    const params = parseStrictRuntimeParams(
      "session.send",
      (parsed as Record<string, unknown>)["params"],
    );
    if (!params.idempotencyKey || params.replayOnly) {
      throw new Error("待确认发送记录不包含有效的原始请求。");
    }
    return { version: 1, params };
  }

  async save(params: RuntimeParams<"session.send">): Promise<void> {
    const checked = parseStrictRuntimeParams("session.send", JSON.parse(JSON.stringify(params)));
    if (!checked.idempotencyKey || checked.replayOnly) {
      throw new Error("待确认发送缺少有效的原始幂等请求。");
    }
    await mkdir(dirname(this.recordPath), { recursive: true, mode: 0o700 });
    if (await this.load()) {
      throw new Error("已有发送结果待确认；先恢复原请求，不能提交新内容。");
    }
    const temporaryPath = this.recordPath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, params: checked }), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporaryPath, this.recordPath);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error("已有发送结果待确认；先恢复原请求，不能提交新内容。", { cause: error });
      }
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async clear(idempotencyKey: string): Promise<void> {
    const current = await this.load();
    if (current?.params.idempotencyKey === idempotencyKey) await unlink(this.recordPath);
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
