import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import type { ModelProviderConfig } from "../provider/model-router.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { parseModelProviderConfigs, parseModelRouteId } from "./pico-config.js";

const USER_CONFIG_VERSION = 1 as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;

export const EMPTY_USER_CONFIG_REVISION = sha256("");

export type PicoInteractionMode = "default" | "plan" | "auto" | "yolo";

export interface PicoUserConfigDefaults {
  readonly modelRouteId?: string;
  readonly mode?: PicoInteractionMode;
  readonly thinkingEffort?: string;
}

export interface PicoUserConfigV1 {
  readonly version: typeof USER_CONFIG_VERSION;
  readonly defaults?: PicoUserConfigDefaults;
  readonly providers: Readonly<Record<string, ModelProviderConfig>>;
}

export type PicoUserConfig = PicoUserConfigV1;

export interface UserConfigSnapshot {
  readonly config: PicoUserConfig;
  /** Lowercase SHA-256 of the exact file bytes, or SHA-256("") when absent. */
  readonly revision: string;
}

export interface UserConfigWriteOptions {
  readonly expectedRevision: string;
}

export interface UserConfigStoreOptions {
  readonly picoHome?: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class UserConfigRevisionConflictError extends Error {
  readonly code = "CONFIG_REVISION_CONFLICT" as const;

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(`用户配置已更改: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "UserConfigRevisionConflictError";
  }
}

export class UserConfigLockTimeoutError extends Error {
  readonly code = "CONFIG_LOCK_TIMEOUT" as const;

  constructor(readonly lockPath: string) {
    super(`等待用户配置写锁超时: ${lockPath}`);
    this.name = "UserConfigLockTimeoutError";
  }
}

/**
 * Device-local configuration shared by TUI and Desktop.
 *
 * Mutations hold a cooperative lock only while rechecking the revision and atomically replacing
 * config.json. Secrets never belong in this store.
 */
export class UserConfigStore {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options: UserConfigStoreOptions = {}) {
    this.directoryPath = options.picoHome ?? resolvePicoHome();
    this.filePath = join(this.directoryPath, "config.json");
    this.lockPath = join(this.directoryPath, ".config.json.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  async read(): Promise<UserConfigSnapshot> {
    await this.secureDirectory();
    return this.readUnlocked();
  }

  async write(
    config: PicoUserConfig,
    options: UserConfigWriteOptions,
  ): Promise<UserConfigSnapshot> {
    const normalized = parseUserConfig(config, this.filePath);
    return this.withWriteLock(async () => {
      const current = await this.readUnlocked();
      if (options.expectedRevision !== current.revision) {
        throw new UserConfigRevisionConflictError(options.expectedRevision, current.revision);
      }
      await this.assertWritableTarget();
      await writeJsonAtomic(this.filePath, normalized, {
        directoryMode: DIRECTORY_MODE,
        fileMode: FILE_MODE,
        durability: "file-and-directory",
      });
      return this.readUnlocked();
    });
  }

  private async readUnlocked(): Promise<UserConfigSnapshot> {
    let metadata;
    try {
      metadata = await lstat(this.filePath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return { config: emptyUserConfig(), revision: EMPTY_USER_CONFIG_REVISION };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`用户配置必须是普通文件，不能是符号链接: ${this.filePath}`);
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(this.filePath, "r");
      const openedMetadata = await handle.stat();
      if (
        !openedMetadata.isFile() ||
        openedMetadata.dev !== metadata.dev ||
        openedMetadata.ino !== metadata.ino
      ) {
        throw new Error(`读取用户配置时文件已被替换: ${this.filePath}`);
      }
      await handle.chmod(FILE_MODE);
      const raw = await handle.readFile("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error(`用户配置 JSON 已损坏: ${this.filePath}`, { cause: error });
      }
      return { config: parseUserConfig(parsed, this.filePath), revision: sha256(raw) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.secureDirectory();
    const deadline = Date.now() + this.lockTimeoutMs;
    let lockHandle: FileHandle | undefined;
    let token = "";
    while (lockHandle === undefined) {
      token = randomUUID();
      let createdLock = false;
      try {
        lockHandle = await open(this.lockPath, "wx", FILE_MODE);
        createdLock = true;
        await lockHandle.writeFile(
          `${JSON.stringify({ version: 1, token, pid: process.pid, acquiredAt: Date.now() })}\n`,
          "utf8",
        );
        await lockHandle.sync();
      } catch (error) {
        await lockHandle?.close().catch(() => undefined);
        lockHandle = undefined;
        if (createdLock) {
          await unlink(this.lockPath).catch((cleanupError: unknown) => {
            if (!isErrnoCode(cleanupError, "ENOENT")) throw cleanupError;
          });
        }
        if (!isErrnoCode(error, "EEXIST")) throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() >= deadline) throw new UserConfigLockTimeoutError(this.lockPath);
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await this.releaseOwnedLock(token);
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(this.lockPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return true;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`用户配置写锁必须是普通文件: ${this.lockPath}`);
    }
    if (Date.now() - metadata.mtimeMs < this.staleLockMs) return false;
    let currentMetadata;
    try {
      currentMetadata = await lstat(this.lockPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return true;
      throw error;
    }
    if (
      currentMetadata.dev !== metadata.dev ||
      currentMetadata.ino !== metadata.ino ||
      currentMetadata.mtimeMs !== metadata.mtimeMs
    ) {
      return false;
    }
    await unlink(this.lockPath).catch((error: unknown) => {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    });
    return true;
  }

  private async releaseOwnedLock(token: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
    if (!raw.includes(`"token":"${token}"`)) return;
    await unlink(this.lockPath).catch((error: unknown) => {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    });
  }

  private async assertWritableTarget(): Promise<void> {
    try {
      const metadata = await lstat(this.filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`用户配置必须是普通文件，不能是符号链接: ${this.filePath}`);
      }
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    }
  }

  private async secureDirectory(): Promise<void> {
    await mkdir(this.directoryPath, { recursive: true, mode: DIRECTORY_MODE });
    const metadata = await lstat(this.directoryPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`PICO_HOME 必须是普通目录，不能是符号链接: ${this.directoryPath}`);
    }
    await chmod(this.directoryPath, DIRECTORY_MODE);
  }
}

export function parseUserConfig(value: unknown, configPath: string): PicoUserConfig {
  if (!isRecord(value)) throw configError(configPath, "root", "must be an object");
  if (value["version"] !== USER_CONFIG_VERSION) {
    throw configError(configPath, "version", `must equal ${USER_CONFIG_VERSION}`);
  }
  const defaults = parseDefaults(value["defaults"], configPath);
  return {
    version: USER_CONFIG_VERSION,
    ...(defaults !== undefined ? { defaults } : {}),
    providers: parseModelProviderConfigs(value["providers"], configPath),
  };
}

function parseDefaults(value: unknown, configPath: string): PicoUserConfigDefaults | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw configError(configPath, "defaults", "must be an object");
  const modelRouteId = parseModelRouteId(
    value["modelRouteId"],
    configPath,
    "defaults.modelRouteId",
  );
  const mode = value["mode"];
  if (mode !== undefined && !isRuntimeInteractionMode(mode)) {
    throw configError(configPath, "defaults.mode", "must be default, plan, auto, or yolo");
  }
  const thinkingEffort = value["thinkingEffort"];
  if (
    thinkingEffort !== undefined &&
    (typeof thinkingEffort !== "string" || thinkingEffort.trim().length === 0)
  ) {
    throw configError(configPath, "defaults.thinkingEffort", "must be a non-empty string");
  }
  return {
    ...(modelRouteId !== undefined ? { modelRouteId } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(typeof thinkingEffort === "string" ? { thinkingEffort: thinkingEffort.trim() } : {}),
  };
}

function emptyUserConfig(): PicoUserConfig {
  return { version: USER_CONFIG_VERSION, providers: {} };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRuntimeInteractionMode(value: unknown): value is PicoInteractionMode {
  return value === "default" || value === "plan" || value === "auto" || value === "yolo";
}

function configError(configPath: string, field: string, detail: string): Error {
  return new Error(`${configPath}: ${field} ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
