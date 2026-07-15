import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import type { ModelProviderConfig } from "../provider/model-router.js";
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

export class UserConfigLockLostError extends Error {
  readonly code = "CONFIG_LOCK_LOST" as const;

  constructor(readonly lockPath: string) {
    super(`用户配置写锁所有权已丢失: ${lockPath}`);
    this.name = "UserConfigLockLostError";
  }
}

interface UserConfigLockRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
}

interface UserConfigLockIdentity {
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

interface UserConfigLockSnapshot extends UserConfigLockIdentity {
  readonly raw: string;
  readonly mtimeMs: number;
  readonly record?: UserConfigLockRecord;
}

interface AcquiredUserConfigLock {
  readonly handle: FileHandle;
  readonly identity: UserConfigLockIdentity;
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
    return this.withWriteLock(async (lock) => {
      const current = await this.readUnlocked();
      if (options.expectedRevision !== current.revision) {
        throw new UserConfigRevisionConflictError(options.expectedRevision, current.revision);
      }
      await this.writeConfigAtomic(normalized, async () => {
        await this.assertOwnedLock(lock);
        await this.assertWritableTarget();
        const latest = await this.readUnlocked();
        if (options.expectedRevision !== latest.revision) {
          throw new UserConfigRevisionConflictError(options.expectedRevision, latest.revision);
        }
        await this.assertOwnedLock(lock);
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

  private async withWriteLock<T>(
    operation: (lock: UserConfigLockIdentity) => Promise<T>,
  ): Promise<T> {
    await this.secureDirectory();
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired: AcquiredUserConfigLock | undefined;
    while (acquired === undefined) {
      try {
        acquired = await this.acquireWriteLock();
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() >= deadline) throw new UserConfigLockTimeoutError(this.lockPath);
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await operation(acquired.identity);
    } finally {
      await acquired.handle.close().catch(() => undefined);
      await this.releaseOwnedLock(acquired.identity);
    }
  }

  private async acquireWriteLock(): Promise<AcquiredUserConfigLock> {
    const token = randomUUID();
    const handle = await open(this.lockPath, "wx", FILE_MODE);
    const metadata = await handle.stat();
    const identity = { token, dev: metadata.dev, ino: metadata.ino };
    try {
      const record: UserConfigLockRecord = {
        version: 1,
        token,
        pid: process.pid,
        acquiredAt: Date.now(),
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await this.assertOwnedLock(identity);
      return { handle, identity };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.removeLockByIdentity(identity, false);
      throw error;
    }
  }

  private async removeStaleLock(): Promise<boolean> {
    const snapshot = await this.readLockSnapshot(this.lockPath);
    if (snapshot === undefined) return true;
    if (Date.now() - snapshot.mtimeMs < this.staleLockMs) return false;
    // Age only makes a lock eligible for inspection. A live owner is authoritative even when a
    // write is paused longer than the stale threshold.
    if (snapshot.record !== undefined && isProcessAlive(snapshot.record.pid)) return false;
    return this.claimAndRemoveLock(snapshot, "stale");
  }

  private async releaseOwnedLock(identity: UserConfigLockIdentity): Promise<void> {
    await this.removeLockByIdentity(identity, true);
  }

  private async removeLockByIdentity(
    identity: UserConfigLockIdentity,
    requireToken: boolean,
  ): Promise<void> {
    const snapshot = await this.readLockSnapshot(this.lockPath);
    if (snapshot === undefined || !matchesIdentity(snapshot, identity, requireToken)) return;
    await this.claimAndRemoveLock(snapshot, "release", requireToken);
  }

  private async claimAndRemoveLock(
    expected: UserConfigLockSnapshot,
    purpose: "release" | "stale",
    requireToken = true,
  ): Promise<boolean> {
    const claimPath = `${this.lockPath}.${purpose}-${sha256(
      `${expected.dev}:${expected.ino}:${expected.token}:${sha256(expected.raw)}`,
    )}`;
    let createdClaim = false;
    try {
      // Only the contender that creates this hard-link claim may unlink lockPath. The claim and
      // the two identity checks prevent delayed reclaimers from deleting a successor lock.
      try {
        await link(this.lockPath, claimPath);
        createdClaim = true;
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return true;
        if (isErrnoCode(error, "EEXIST")) return false;
        throw error;
      }

      const claimed = await this.readLockSnapshot(claimPath);
      if (claimed === undefined || !matchesSnapshot(claimed, expected, requireToken)) return false;
      const current = await this.readLockSnapshot(this.lockPath);
      if (current === undefined) return true;
      if (!matchesSnapshot(current, expected, requireToken)) return false;

      await unlink(this.lockPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      });
      return true;
    } finally {
      if (createdClaim) {
        await unlink(claimPath).catch(() => undefined);
      }
    }
  }

  private async assertOwnedLock(identity: UserConfigLockIdentity): Promise<void> {
    const snapshot = await this.readLockSnapshot(this.lockPath);
    if (snapshot === undefined || !matchesIdentity(snapshot, identity, true)) {
      throw new UserConfigLockLostError(this.lockPath);
    }
  }

  private async readLockSnapshot(path: string): Promise<UserConfigLockSnapshot | undefined> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`用户配置写锁必须是普通文件: ${path}`);
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const opened = await handle.stat();
      if (!sameFile(before, opened)) return undefined;
      const raw = await handle.readFile("utf8");
      let after;
      try {
        after = await lstat(path);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return undefined;
        throw error;
      }
      if (!sameFile(opened, after)) return undefined;
      const record = parseLockRecord(raw);
      return {
        token: record?.token ?? `legacy:${sha256(raw)}`,
        dev: opened.dev,
        ino: opened.ino,
        raw,
        mtimeMs: opened.mtimeMs,
        ...(record !== undefined ? { record } : {}),
      };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeConfigAtomic(
    config: PicoUserConfig,
    beforePublish: () => Promise<void>,
  ): Promise<void> {
    const temporaryPath = join(
      this.directoryPath,
      `.config.json.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(temporaryPath, "wx", FILE_MODE);
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      await beforePublish();
      await rename(temporaryPath, this.filePath);
      published = true;
      await syncDirectory(this.directoryPath);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await unlink(temporaryPath).catch(() => undefined);
    }
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

function parseLockRecord(raw: string): UserConfigLockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["token"] !== "string" ||
    value["token"].length === 0 ||
    typeof value["pid"] !== "number" ||
    !Number.isSafeInteger(value["pid"]) ||
    value["pid"] <= 0 ||
    typeof value["acquiredAt"] !== "number" ||
    !Number.isFinite(value["acquiredAt"])
  ) {
    return undefined;
  }
  return {
    version: 1,
    token: value["token"],
    pid: value["pid"],
    acquiredAt: value["acquiredAt"],
  };
}

function matchesIdentity(
  snapshot: UserConfigLockSnapshot,
  identity: UserConfigLockIdentity,
  requireToken: boolean,
): boolean {
  return (
    snapshot.dev === identity.dev &&
    snapshot.ino === identity.ino &&
    (!requireToken || snapshot.token === identity.token)
  );
}

function matchesSnapshot(
  actual: UserConfigLockSnapshot,
  expected: UserConfigLockSnapshot,
  requireToken: boolean,
): boolean {
  return matchesIdentity(actual, expected, requireToken) && actual.raw === expected.raw;
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    isErrnoCode(error, "EACCES") ||
    isErrnoCode(error, "EINVAL") ||
    isErrnoCode(error, "EISDIR") ||
    isErrnoCode(error, "ENOTSUP") ||
    isErrnoCode(error, "EPERM")
  );
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
