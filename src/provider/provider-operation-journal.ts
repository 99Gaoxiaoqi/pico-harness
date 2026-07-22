import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { PicoUserConfig } from "../input/user-config-store.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import {
  assertCredentialRefMatchesProvider,
  parseProviderCredentialRef,
  type CredentialRef,
} from "./credential-vault.js";
import type { ProviderUserConfigParser } from "./model-runtime-config-contract.js";

const SCHEMA_VERSION = 1 as const;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;

export type ProviderOperationKind = "import" | "delete";
export type ProviderOperationPhase =
  | "prepared"
  | "credential-imported"
  | "credential-deleted"
  | "config-committed";

export interface ProviderOperationRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operationId: string;
  readonly kind: ProviderOperationKind;
  readonly phase: ProviderOperationPhase;
  readonly previousUserConfig: PicoUserConfig;
  readonly targetUserConfig: PicoUserConfig;
  readonly credentialRef: CredentialRef;
  readonly credentialExistedBefore: boolean;
  /** Revision observed before the first cross-store side effect. */
  readonly preparedConfigRevision: string;
  /** Latest config revision durably observed by the coordinator. */
  readonly configRevision: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderOperationPrepareInput {
  readonly kind: ProviderOperationKind;
  readonly previousUserConfig: PicoUserConfig;
  readonly targetUserConfig: PicoUserConfig;
  readonly credentialRef: CredentialRef;
  readonly credentialExistedBefore: boolean;
  readonly configRevision: string;
}

export interface ProviderOperationUpdate {
  readonly phase: ProviderOperationPhase;
  readonly configRevision?: string;
}

export interface ProviderOperationJournalOptions {
  /** Pure user-config schema parser supplied by the input composition root. */
  readonly parseUserConfig: ProviderUserConfigParser;
  readonly picoHome?: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class ProviderOperationConflictError extends Error {
  readonly code = "PROVIDER_OPERATION_CONFLICT" as const;

  constructor(
    readonly expectedOperationId: string | undefined,
    readonly actualOperationId: string | undefined,
  ) {
    super(
      actualOperationId === undefined
        ? "Provider 操作日志不存在"
        : expectedOperationId === undefined
          ? `Provider 操作 ${actualOperationId} 尚未完成`
          : `Provider 操作已更改: expected ${expectedOperationId}, actual ${actualOperationId}`,
    );
    this.name = "ProviderOperationConflictError";
  }
}

export class ProviderOperationLockTimeoutError extends Error {
  readonly code = "PROVIDER_OPERATION_LOCK_TIMEOUT" as const;

  constructor(readonly lockPath: string) {
    super(`等待 Provider 操作日志写锁超时: ${lockPath}`);
    this.name = "ProviderOperationLockTimeoutError";
  }
}

interface JournalLockRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
}

interface JournalLockIdentity {
  readonly token: string;
  readonly dev: number;
  readonly ino: number;
}

interface JournalLockSnapshot extends JournalLockIdentity {
  readonly raw: string;
  readonly mtimeMs: number;
  readonly record?: JournalLockRecord;
}

interface AcquiredJournalLock {
  readonly handle: FileHandle;
  readonly identity: JournalLockIdentity;
}

/**
 * Durable, non-secret intent journal for one Provider config/credential operation.
 *
 * The journal is intentionally single-entry: the daemon reconciles the pending operation before
 * preparing another one. Every mutation is serialized by a short-lived process lock and published
 * by fsync + atomic rename. The operation id is the OCC token used by update and clear.
 */
export class ProviderOperationJournal {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly parseUserConfig: ProviderUserConfigParser;

  constructor(options: ProviderOperationJournalOptions) {
    this.parseUserConfig = options.parseUserConfig;
    this.directoryPath = options.picoHome ?? resolvePicoHome();
    this.filePath = join(this.directoryPath, "provider-operation.json");
    this.lockPath = join(this.directoryPath, ".provider-operation.json.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  async read(): Promise<ProviderOperationRecord | undefined> {
    await this.secureDirectory();
    return this.readUnlocked();
  }

  async prepare(input: ProviderOperationPrepareInput): Promise<ProviderOperationRecord> {
    assertExactObject(
      input,
      [
        "kind",
        "previousUserConfig",
        "targetUserConfig",
        "credentialRef",
        "credentialExistedBefore",
        "configRevision",
      ],
      this.filePath,
    );
    const previousUserConfig = strictUserConfig(
      input.previousUserConfig,
      this.filePath,
      this.parseUserConfig,
      { redactApiKeys: true },
    );
    const targetUserConfig = strictUserConfig(
      input.targetUserConfig,
      this.filePath,
      this.parseUserConfig,
      { redactApiKeys: true },
    );
    const credentialRef = parseProviderCredentialRef(input.credentialRef).ref;
    const configRevision = parseRevision(input.configRevision, "configRevision");
    const kind = parseKind(input.kind);
    assertOperationMetadata(kind, previousUserConfig, targetUserConfig, credentialRef);

    return this.withWriteLock(async (lock) => {
      const pending = await this.readUnlocked();
      if (pending !== undefined) {
        throw new ProviderOperationConflictError(undefined, pending.operationId);
      }
      const now = Date.now();
      const record: ProviderOperationRecord = {
        schemaVersion: SCHEMA_VERSION,
        operationId: randomUUID(),
        kind,
        phase: "prepared",
        previousUserConfig,
        targetUserConfig,
        credentialRef,
        credentialExistedBefore: parseBoolean(
          input.credentialExistedBefore,
          "credentialExistedBefore",
        ),
        preparedConfigRevision: configRevision,
        configRevision,
        createdAt: now,
        updatedAt: now,
      };
      await this.writeAtomic(record, () => this.assertOwnedLock(lock));
      return record;
    });
  }

  async update(
    operationId: string,
    patch: ProviderOperationUpdate,
  ): Promise<ProviderOperationRecord> {
    parseOperationId(operationId);
    assertUpdatePatch(patch, this.filePath);
    return this.withWriteLock(async (lock) => {
      const current = await this.readUnlocked();
      this.assertOperationId(operationId, current);
      const phase = parsePhase(patch.phase);
      assertPhaseTransition(current.kind, current.phase, phase);
      const configRevision =
        patch.configRevision === undefined
          ? current.configRevision
          : parseRevision(patch.configRevision, "configRevision");
      const updated = parseRecord(
        {
          ...current,
          phase,
          configRevision,
          updatedAt: Math.max(Date.now(), current.updatedAt),
        },
        this.filePath,
        this.parseUserConfig,
      );
      await this.writeAtomic(updated, async () => {
        await this.assertOwnedLock(lock);
        const latest = await this.readUnlocked();
        this.assertOperationId(operationId, latest);
      });
      return updated;
    });
  }

  async clear(operationId: string): Promise<void> {
    parseOperationId(operationId);
    await this.withWriteLock(async (lock) => {
      const current = await this.readUnlocked();
      if (current === undefined) return;
      this.assertOperationId(operationId, current);
      await this.assertOwnedLock(lock);
      await this.assertWritableTarget();
      await unlink(this.filePath);
      await syncDirectory(this.directoryPath);
    });
  }

  private assertOperationId(
    operationId: string,
    current: ProviderOperationRecord | undefined,
  ): asserts current is ProviderOperationRecord {
    if (current?.operationId !== operationId) {
      throw new ProviderOperationConflictError(operationId, current?.operationId);
    }
  }

  private async readUnlocked(): Promise<ProviderOperationRecord | undefined> {
    let before;
    try {
      before = await lstat(this.filePath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`Provider 操作日志必须是普通文件: ${this.filePath}`);
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(this.filePath, "r");
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened)) {
        throw new Error(`读取 Provider 操作日志时文件已被替换: ${this.filePath}`);
      }
      await handle.chmod(FILE_MODE);
      const raw = await handle.readFile("utf8");
      const after = await lstat(this.filePath);
      if (!sameFile(opened, after)) {
        throw new Error(`读取 Provider 操作日志时文件已被替换: ${this.filePath}`);
      }
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error(`Provider 操作日志 JSON 已损坏: ${this.filePath}`, { cause: error });
      }
      return parseRecord(value, this.filePath, this.parseUserConfig);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeAtomic(
    record: ProviderOperationRecord,
    beforePublish: () => Promise<void>,
  ): Promise<void> {
    const temporaryPath = join(
      this.directoryPath,
      `.provider-operation.json.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(temporaryPath, "wx", FILE_MODE);
      await handle.chmod(FILE_MODE);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      await beforePublish();
      await this.assertWritableTarget();
      await rename(temporaryPath, this.filePath);
      published = true;
      await chmod(this.filePath, FILE_MODE);
      await syncDirectory(this.directoryPath);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async withWriteLock<T>(operation: (lock: JournalLockIdentity) => Promise<T>): Promise<T> {
    await this.secureDirectory();
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired: AcquiredJournalLock | undefined;
    while (acquired === undefined) {
      try {
        acquired = await this.acquireWriteLock();
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() >= deadline) throw new ProviderOperationLockTimeoutError(this.lockPath);
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await operation(acquired.identity);
    } finally {
      await acquired.handle.close().catch(() => undefined);
      await this.removeLockByIdentity(acquired.identity, true);
    }
  }

  private async acquireWriteLock(): Promise<AcquiredJournalLock> {
    const token = randomUUID();
    const handle = await open(this.lockPath, "wx", FILE_MODE);
    const metadata = await handle.stat();
    const identity = { token, dev: metadata.dev, ino: metadata.ino };
    try {
      const record: JournalLockRecord = {
        version: 1,
        token,
        pid: process.pid,
        acquiredAt: Date.now(),
      };
      await handle.chmod(FILE_MODE);
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
    if (snapshot.record !== undefined && isProcessAlive(snapshot.record.pid)) return false;
    return this.claimAndRemoveLock(snapshot, "stale");
  }

  private async removeLockByIdentity(
    identity: JournalLockIdentity,
    requireToken: boolean,
  ): Promise<void> {
    const snapshot = await this.readLockSnapshot(this.lockPath);
    if (snapshot === undefined || !matchesIdentity(snapshot, identity, requireToken)) return;
    await this.claimAndRemoveLock(snapshot, "release", requireToken);
  }

  private async claimAndRemoveLock(
    expected: JournalLockSnapshot,
    purpose: "release" | "stale",
    requireToken = true,
  ): Promise<boolean> {
    const claimPath = `${this.lockPath}.${purpose}-${sha256(
      `${expected.dev}:${expected.ino}:${expected.token}:${sha256(expected.raw)}`,
    )}`;
    let createdClaim = false;
    let matchedClaim = false;
    try {
      try {
        await link(this.lockPath, claimPath);
        createdClaim = true;
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) return true;
        if (!isErrnoCode(error, "EEXIST")) throw error;
      }

      const claimed = await this.readLockSnapshot(claimPath);
      if (claimed === undefined || !matchesSnapshot(claimed, expected, requireToken)) return false;
      matchedClaim = true;
      const current = await this.readLockSnapshot(this.lockPath);
      if (current === undefined) return true;
      if (!matchesSnapshot(current, expected, requireToken)) return false;

      await unlink(this.lockPath).catch((error: unknown) => {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      });
      return true;
    } finally {
      if (createdClaim || matchedClaim) await unlink(claimPath).catch(() => undefined);
    }
  }

  private async assertOwnedLock(identity: JournalLockIdentity): Promise<void> {
    const snapshot = await this.readLockSnapshot(this.lockPath);
    if (snapshot === undefined || !matchesIdentity(snapshot, identity, true)) {
      throw new Error(`Provider 操作日志写锁所有权已丢失: ${this.lockPath}`);
    }
  }

  private async readLockSnapshot(path: string): Promise<JournalLockSnapshot | undefined> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`Provider 操作日志写锁必须是普通文件: ${path}`);
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

  private async assertWritableTarget(): Promise<void> {
    try {
      const metadata = await lstat(this.filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Provider 操作日志必须是普通文件: ${this.filePath}`);
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

function parseRecord(
  value: unknown,
  path: string,
  parseUserConfig: ProviderUserConfigParser,
): ProviderOperationRecord {
  assertExactObject(
    value,
    [
      "schemaVersion",
      "operationId",
      "kind",
      "phase",
      "previousUserConfig",
      "targetUserConfig",
      "credentialRef",
      "credentialExistedBefore",
      "preparedConfigRevision",
      "configRevision",
      "createdAt",
      "updatedAt",
    ],
    path,
  );
  if (value["schemaVersion"] !== SCHEMA_VERSION) {
    throw journalError(path, `schemaVersion 必须等于 ${SCHEMA_VERSION}`);
  }
  const operationId = parseOperationId(value["operationId"]);
  const kind = parseKind(value["kind"]);
  const phase = parsePhase(value["phase"]);
  assertPhaseForKind(kind, phase);
  const previousUserConfig = strictUserConfig(value["previousUserConfig"], path, parseUserConfig);
  const targetUserConfig = strictUserConfig(value["targetUserConfig"], path, parseUserConfig);
  if (typeof value["credentialRef"] !== "string") {
    throw journalError(path, "credentialRef 必须是字符串");
  }
  const credentialRef = parseProviderCredentialRef(value["credentialRef"]).ref;
  const credentialExistedBefore = parseBoolean(
    value["credentialExistedBefore"],
    "credentialExistedBefore",
  );
  const preparedConfigRevision = parseRevision(
    value["preparedConfigRevision"],
    "preparedConfigRevision",
  );
  const configRevision = parseRevision(value["configRevision"], "configRevision");
  const createdAt = parseTimestamp(value["createdAt"], "createdAt");
  const updatedAt = parseTimestamp(value["updatedAt"], "updatedAt");
  if (updatedAt < createdAt) throw journalError(path, "updatedAt 不能早于 createdAt");
  assertOperationMetadata(kind, previousUserConfig, targetUserConfig, credentialRef);
  return {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    kind,
    phase,
    previousUserConfig,
    targetUserConfig,
    credentialRef,
    credentialExistedBefore,
    preparedConfigRevision,
    configRevision,
    createdAt,
    updatedAt,
  };
}

function strictUserConfig(
  value: unknown,
  path: string,
  parseUserConfig: ProviderUserConfigParser,
  options: { readonly redactApiKeys?: boolean } = {},
): PicoUserConfig {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw journalError(path, `User config 不是 JSON: ${String(error)}`);
  }
  if (json === undefined) throw journalError(path, "User config 不是 JSON");
  const jsonValue = JSON.parse(json) as unknown;
  const normalized = parseUserConfig(jsonValue, path);
  if (canonicalJson(jsonValue) !== canonicalJson(normalized)) {
    throw journalError(path, "User config 包含未知字段或非规范值");
  }
  if (options.redactApiKeys) return redactUserConfigApiKeys(normalized);
  if (hasUserConfigApiKey(normalized)) {
    throw journalError(
      path,
      "Provider operation journal 不得保存 apiKey；明文凭证仅允许存在于用户级 config.json",
    );
  }
  return normalized;
}

function redactUserConfigApiKeys(config: PicoUserConfig): PicoUserConfig {
  if (!hasUserConfigApiKey(config)) return config;
  return {
    version: config.version,
    ...(config.defaults ? { defaults: config.defaults } : {}),
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([providerId, provider]) => {
        const metadata = { ...provider };
        delete metadata.apiKey;
        return [providerId, metadata];
      }),
    ),
  };
}

function hasUserConfigApiKey(config: PicoUserConfig): boolean {
  return Object.values(config.providers).some((provider) => provider.apiKey !== undefined);
}

function assertExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw journalError(path, "root 必须是对象");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw journalError(path, `字段必须严格为 ${expected.join(", ")}`);
  }
}

function assertUpdatePatch(value: unknown, path: string): asserts value is ProviderOperationUpdate {
  if (!isRecord(value)) throw journalError(path, "update patch 必须是对象");
  const keys = Object.keys(value);
  if (
    !Object.hasOwn(value, "phase") ||
    keys.some((key) => key !== "phase" && key !== "configRevision")
  ) {
    throw journalError(path, "update patch 只允许 phase 和 configRevision");
  }
}

function parseOperationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new Error("Provider operationId 必须是 UUID v4");
  }
  return value;
}

function parseKind(value: unknown): ProviderOperationKind {
  if (value !== "import" && value !== "delete") {
    throw new Error("Provider operation kind 必须是 import 或 delete");
  }
  return value;
}

function parsePhase(value: unknown): ProviderOperationPhase {
  if (
    value !== "prepared" &&
    value !== "credential-imported" &&
    value !== "credential-deleted" &&
    value !== "config-committed"
  ) {
    throw new Error("Provider operation phase 无效");
  }
  return value;
}

function assertPhaseForKind(kind: ProviderOperationKind, phase: ProviderOperationPhase): void {
  if (
    (kind === "import" && phase === "credential-deleted") ||
    (kind === "delete" && phase === "credential-imported")
  ) {
    throw new Error(`Provider ${kind} 操作不支持阶段 ${phase}`);
  }
}

function assertOperationMetadata(
  kind: ProviderOperationKind,
  previousUserConfig: PicoUserConfig,
  targetUserConfig: PicoUserConfig,
  credentialRef: CredentialRef,
): void {
  const identity = parseProviderCredentialRef(credentialRef);
  const authorityConfig =
    kind === "import"
      ? targetUserConfig.providers[identity.providerId]
      : previousUserConfig.providers[identity.providerId];
  if (authorityConfig === undefined) {
    throw new Error(`Provider ${kind} 操作配置快照中缺少 ${identity.providerId}`);
  }
  assertCredentialRefMatchesProvider(credentialRef, {
    providerId: identity.providerId,
    protocol: authorityConfig.protocol,
    baseURL: authorityConfig.baseURL,
    credentialSlot: identity.credentialSlot,
  });
  if (kind === "delete" && targetUserConfig.providers[identity.providerId] !== undefined) {
    throw new Error(`Provider delete 目标配置仍包含 ${identity.providerId}`);
  }
}

function assertPhaseTransition(
  kind: ProviderOperationKind,
  current: ProviderOperationPhase,
  target: ProviderOperationPhase,
): void {
  assertPhaseForKind(kind, target);
  const sequence: readonly ProviderOperationPhase[] =
    kind === "import"
      ? ["prepared", "credential-imported", "config-committed"]
      : ["prepared", "credential-deleted", "config-committed"];
  const currentIndex = sequence.indexOf(current);
  const targetIndex = sequence.indexOf(target);
  if (currentIndex < 0 || targetIndex < currentIndex || targetIndex > currentIndex + 1) {
    throw new Error(`Provider operation phase 不能从 ${current} 变为 ${target}`);
  }
}

function parseRevision(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Provider operation ${field} 必须是小写 SHA-256`);
  }
  return value;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Provider operation ${field} 必须是布尔值`);
  return value;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Provider operation ${field} 必须是非负安全整数`);
  }
  return value;
}

function parseLockRecord(raw: string): JournalLockRecord | undefined {
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function matchesIdentity(
  snapshot: JournalLockSnapshot,
  identity: JournalLockIdentity,
  requireToken: boolean,
): boolean {
  return (
    snapshot.dev === identity.dev &&
    snapshot.ino === identity.ino &&
    (!requireToken || snapshot.token === identity.token)
  );
}

function matchesSnapshot(
  actual: JournalLockSnapshot,
  expected: JournalLockSnapshot,
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalError(path: string, detail: string): Error {
  return new Error(`${path}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
