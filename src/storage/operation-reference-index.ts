import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import { isFileHistoryMutationLeaseHeld } from "./file-history-mutation-lease.js";
import type { StorageOperation, StorageOperationState } from "./operation-journal.js";

const LEGACY_OPERATION_REFERENCE_INDEX_VERSION = 1 as const;
const OPERATION_REFERENCE_INDEX_VERSION = 2 as const;
const GC_PROTOCOL_VERSION = 1 as const;
const GC_ELIGIBILITY_VERSION = 1 as const;
const GC_PROTOCOL_ID = "pico-cas-gc-operation-index" as const;
const GC_PROTOCOL_FILE_NAME = "gc-protocol.json";
const GC_ELIGIBILITY_DIRECTORY_NAME = "gc-eligible-blobs";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA256_PREFIX_RE = /^[a-f0-9]{2}$/u;

interface OperationReferenceIndexEntryBase {
  readonly journalDirectory: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly kind: StorageOperation["kind"];
  readonly state: StorageOperationState;
  readonly referencedDigests: readonly string[];
  readonly stagingDirectory?: string;
  readonly updatedAt: string;
}

export type OperationReferenceIndexEntry = OperationReferenceIndexEntryBase &
  (
    | {
        readonly schemaVersion: typeof LEGACY_OPERATION_REFERENCE_INDEX_VERSION;
      }
    | {
        readonly schemaVersion: typeof OPERATION_REFERENCE_INDEX_VERSION;
        readonly protocolGeneration: string;
      }
  );

interface GcProtocolMetadata {
  readonly schemaVersion: typeof GC_PROTOCOL_VERSION;
  readonly protocol: typeof GC_PROTOCOL_ID;
  readonly generation: string;
  readonly initializedAt: string;
}

interface BlobGcEligibilityMarker {
  readonly schemaVersion: typeof GC_ELIGIBILITY_VERSION;
  readonly protocolGeneration: string;
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly createdAt: string;
}

export interface OperationReferenceIndexFailure {
  readonly path: string;
  readonly message: string;
}

export interface OperationReferenceIndexScan {
  readonly entries: readonly OperationReferenceIndexEntry[];
  /** 只有同代、完整可解析的 marker 才会出现在此集合中。 */
  readonly gcEligibleDigests: readonly string[];
  readonly failures: readonly OperationReferenceIndexFailure[];
}

/**
 * 共享 CAS 的全局 operation roots 与 GC 代际证明。所有扫描都限定在
 * baseDir/.operation-references 内，不通过 workspace 或用户目录反向发现引用。
 */
export class OperationReferenceIndex {
  readonly directory: string;
  private readonly baseDir: string;
  private readonly protocolPath: string;
  private readonly eligibilityDirectory: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
    this.directory = join(this.baseDir, ".operation-references");
    this.protocolPath = join(this.directory, GC_PROTOCOL_FILE_NAME);
    this.eligibilityDirectory = join(this.directory, GC_ELIGIBILITY_DIRECTORY_NAME);
  }

  async upsert(journalDirectory: string, operation: StorageOperation): Promise<void> {
    const protocol = await this.ensureProtocol();
    const normalizedJournalDirectory = resolve(journalDirectory);
    const entry = {
      schemaVersion: OPERATION_REFERENCE_INDEX_VERSION,
      protocolGeneration: protocol.generation,
      journalDirectory: normalizedJournalDirectory,
      operationId: operation.operationId,
      operationVersion: operation.version,
      kind: operation.kind,
      state: operation.state,
      referencedDigests: collectReferencedDigests(operation),
      ...(operation.kind === "fork" ? { stagingDirectory: operation.stagingDirectory } : {}),
      updatedAt: operation.updatedAt,
    } satisfies OperationReferenceIndexEntry;
    await writeJsonAtomic(this.entryPath(normalizedJournalDirectory, operation.operationId), entry);
  }

  /**
   * 仅新建的 blob 可调用。EEXIST 的旧 blob 不得补 marker，否则会把
   * 无法证明已纳入新索引协议的升级数据误当成可回收数据。
   */
  async markNewBlobGcEligible(digest: string): Promise<void> {
    assertSha256Digest(digest);
    const protocol = await this.ensureProtocol();
    const marker = {
      schemaVersion: GC_ELIGIBILITY_VERSION,
      protocolGeneration: protocol.generation,
      algorithm: "sha256",
      digest,
      createdAt: new Date().toISOString(),
    } satisfies BlobGcEligibilityMarker;
    const path = this.eligibilityMarkerPath(digest);
    if (await writeJsonExclusiveAtomic(path, marker)) return;

    const existing = parseBlobGcEligibilityMarker(await readRegularJson(path));
    if (
      !existing ||
      existing.digest !== digest ||
      existing.protocolGeneration !== protocol.generation
    ) {
      throw new Error(`Conflicting or malformed blob GC eligibility marker: ${path}`);
    }
  }

  /**
   * 在删除 blob 前持久撤销其 GC 资格。调用方必须持有共享 mutation
   * lease；若 marker 已不存在则返回 false，调用方必须保留 blob。
   */
  async revokeBlobGcEligibility(digest: string): Promise<boolean> {
    assertSha256Digest(digest);
    if (!isFileHistoryMutationLeaseHeld(this.baseDir)) {
      throw new Error("Blob GC eligibility can only be revoked while holding the mutation lease");
    }
    const protocol = await this.readProtocolRequired();
    const path = this.eligibilityMarkerPath(digest);
    try {
      const parsed = parseBlobGcEligibilityMarker(await readRegularJson(path));
      if (
        !parsed ||
        parsed.digest !== digest ||
        parsed.protocolGeneration !== protocol.generation
      ) {
        throw new Error(`Conflicting or malformed blob GC eligibility marker: ${path}`);
      }
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return false;
      throw error;
    }

    // marker 的 unlink + 目录 sync 必须先于 blob 删除持久化。任意一步失败
    // 都会让调用方停在 blob 删除之前，最多遗留不可回收数据。
    try {
      await unlink(path);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return false;
      throw error;
    }
    await syncDirectoryStrict(dirname(path));
    return true;
  }

  async scan(): Promise<OperationReferenceIndexScan> {
    let directoryEntries: Dirent[];
    try {
      const metadata = await lstat(this.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("global operation reference index is not a regular directory");
      }
      directoryEntries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) {
        return { entries: [], gcEligibleDigests: [], failures: [] };
      }
      return {
        entries: [],
        gcEligibleDigests: [],
        failures: [{ path: this.directory, message: errorMessage(error) }],
      };
    }

    const entries: OperationReferenceIndexEntry[] = [];
    const failures: OperationReferenceIndexFailure[] = [];
    const protocolEntry = directoryEntries.find((entry) => entry.name === GC_PROTOCOL_FILE_NAME);
    const protocol = await this.readProtocolForScan(protocolEntry, failures);
    for (const directoryEntry of directoryEntries.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const name = directoryEntry.name;
      if (name === GC_PROTOCOL_FILE_NAME || !name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      try {
        if (!directoryEntry.isFile()) {
          throw new Error("global operation reference entry is not a regular file");
        }
        const entry = parseOperationReferenceIndexEntry(
          await readRegularJson(path),
          protocol?.generation,
        );
        if (!entry) throw new Error("malformed global operation reference entry");
        if (name !== this.entryName(entry.journalDirectory, entry.operationId)) {
          throw new Error("operation reference identity does not match its filename");
        }
        entries.push(entry);
      } catch (error) {
        failures.push({ path, message: errorMessage(error) });
      }
    }

    const eligibilityEntry = directoryEntries.find(
      (entry) => entry.name === GC_ELIGIBILITY_DIRECTORY_NAME,
    );
    const gcEligibleDigests = await this.scanEligibilityMarkers(
      eligibilityEntry,
      protocol,
      failures,
    );
    return {
      entries,
      gcEligibleDigests: [...gcEligibleDigests].toSorted(),
      failures,
    };
  }

  private async ensureProtocol(): Promise<GcProtocolMetadata> {
    await assertRegularDirectoryIfExists(this.directory);
    try {
      return await this.readProtocolRequired();
    } catch (error) {
      if (!isNodeCode(error, "ENOENT")) throw error;
    }

    await this.assertSafeToInitializeProtocol();
    const candidate = {
      schemaVersion: GC_PROTOCOL_VERSION,
      protocol: GC_PROTOCOL_ID,
      generation: randomUUID(),
      initializedAt: new Date().toISOString(),
    } satisfies GcProtocolMetadata;
    if (await writeJsonExclusiveAtomic(this.protocolPath, candidate)) return candidate;
    return this.readProtocolRequired();
  }

  private async readProtocolRequired(): Promise<GcProtocolMetadata> {
    const protocol = parseGcProtocolMetadata(await readRegularJson(this.protocolPath));
    if (!protocol) throw new Error(`Malformed CAS GC protocol metadata: ${this.protocolPath}`);
    return protocol;
  }

  private async readProtocolForScan(
    entry: Dirent | undefined,
    failures: OperationReferenceIndexFailure[],
  ): Promise<GcProtocolMetadata | undefined> {
    if (!entry) return undefined;
    try {
      if (!entry.isFile()) throw new Error("CAS GC protocol metadata is not a regular file");
      return await this.readProtocolRequired();
    } catch (error) {
      failures.push({ path: this.protocolPath, message: errorMessage(error) });
      return undefined;
    }
  }

  private async assertSafeToInitializeProtocol(): Promise<void> {
    let entries: Dirent[];
    try {
      const metadata = await lstat(this.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("global operation reference index is not a regular directory");
      }
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name === GC_PROTOCOL_FILE_NAME) {
        throw new Error(
          `CAS GC protocol metadata appeared during initialization: ${this.protocolPath}`,
        );
      }
      if (entry.name === GC_ELIGIBILITY_DIRECTORY_NAME) {
        if (!entry.isDirectory()) {
          throw new Error(
            `Cannot initialize CAS GC protocol with a non-directory eligibility root: ${this.eligibilityDirectory}`,
          );
        }
        if (await directoryHasEntries(this.eligibilityDirectory)) {
          throw new Error(
            `Cannot initialize CAS GC protocol while eligibility markers lack metadata: ${this.eligibilityDirectory}`,
          );
        }
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const path = join(this.directory, entry.name);
      let value: unknown;
      try {
        if (!entry.isFile()) {
          throw new Error("operation index entry is not a regular file");
        }
        value = await readRegularJson(path);
      } catch (error) {
        throw new Error(
          `Cannot initialize CAS GC protocol with an unreadable operation index entry: ${path}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      const legacy = parseOperationReferenceIndexEntry(value, undefined);
      if (!legacy || legacy.schemaVersion !== LEGACY_OPERATION_REFERENCE_INDEX_VERSION) {
        throw new Error(
          `Cannot initialize CAS GC protocol with an unproven operation index entry: ${path}`,
        );
      }
    }
  }

  private async scanEligibilityMarkers(
    eligibilityEntry: Dirent | undefined,
    protocol: GcProtocolMetadata | undefined,
    failures: OperationReferenceIndexFailure[],
  ): Promise<Set<string>> {
    const eligible = new Set<string>();
    if (!eligibilityEntry) return eligible;
    if (!eligibilityEntry.isDirectory()) {
      failures.push({
        path: this.eligibilityDirectory,
        message: "blob GC eligibility root is not a regular directory",
      });
      return eligible;
    }
    for (const prefix of await readDirectoryEntries(this.eligibilityDirectory)) {
      const prefixPath = join(this.eligibilityDirectory, prefix.name);
      if (!prefix.isDirectory() || !SHA256_PREFIX_RE.test(prefix.name)) {
        failures.push({
          path: prefixPath,
          message: "malformed blob GC eligibility prefix entry",
        });
        continue;
      }
      for (const markerEntry of await readDirectoryEntries(prefixPath)) {
        const path = join(prefixPath, markerEntry.name);
        try {
          if (!markerEntry.isFile() || !markerEntry.name.endsWith(".json")) {
            throw new Error("malformed blob GC eligibility entry");
          }
          const digest = markerEntry.name.slice(0, -".json".length);
          if (!SHA256_RE.test(digest) || !digest.startsWith(prefix.name)) {
            throw new Error("blob GC eligibility identity does not match its path");
          }
          if (!protocol)
            throw new Error("blob GC eligibility marker has no valid protocol metadata");
          const marker = parseBlobGcEligibilityMarker(await readRegularJson(path));
          if (!marker) throw new Error("malformed blob GC eligibility marker");
          if (marker.digest !== digest || marker.protocolGeneration !== protocol.generation) {
            throw new Error("blob GC eligibility marker belongs to another protocol generation");
          }
          eligible.add(digest);
        } catch (error) {
          failures.push({ path, message: errorMessage(error) });
        }
      }
    }
    return eligible;
  }

  private entryPath(journalDirectory: string, operationId: string): string {
    return join(this.directory, this.entryName(journalDirectory, operationId));
  }

  private entryName(journalDirectory: string, operationId: string): string {
    return `${createHash("sha256")
      .update(resolve(journalDirectory))
      .update("\0")
      .update(operationId)
      .digest("hex")}.json`;
  }

  private eligibilityMarkerPath(digest: string): string {
    return join(this.eligibilityDirectory, digest.slice(0, 2), `${digest}.json`);
  }
}

function collectReferencedDigests(operation: StorageOperation): string[] {
  if (operation.kind !== "rewind") return [];
  const digests = new Set<string>();
  for (const file of operation.files) {
    if (file.before.kind === "file") digests.add(file.before.blobSha256);
    if (file.after.kind === "file") digests.add(file.after.blobSha256);
  }
  return [...digests].toSorted();
}

function parseOperationReferenceIndexEntry(
  value: unknown,
  protocolGeneration: string | undefined,
): OperationReferenceIndexEntry | undefined {
  if (
    !isRecord(value) ||
    (value["schemaVersion"] !== LEGACY_OPERATION_REFERENCE_INDEX_VERSION &&
      value["schemaVersion"] !== OPERATION_REFERENCE_INDEX_VERSION) ||
    typeof value["journalDirectory"] !== "string" ||
    !isAbsolute(value["journalDirectory"]) ||
    typeof value["operationId"] !== "string" ||
    value["operationId"].length === 0 ||
    !isPositiveInteger(value["operationVersion"]) ||
    !isOperationKind(value["kind"]) ||
    !isOperationState(value["state"]) ||
    !Array.isArray(value["referencedDigests"]) ||
    !value["referencedDigests"].every(
      (digest): digest is string => typeof digest === "string" && SHA256_RE.test(digest),
    ) ||
    !isOptionalAbsolutePath(value["stagingDirectory"]) ||
    typeof value["updatedAt"] !== "string"
  ) {
    return undefined;
  }
  if (value["kind"] === "fork" && value["stagingDirectory"] === undefined) return undefined;
  if (value["kind"] === "rewind" && value["stagingDirectory"] !== undefined) return undefined;
  if (value["schemaVersion"] === OPERATION_REFERENCE_INDEX_VERSION) {
    if (
      protocolGeneration === undefined ||
      typeof value["protocolGeneration"] !== "string" ||
      value["protocolGeneration"] !== protocolGeneration
    ) {
      return undefined;
    }
  }
  return structuredClone(value) as unknown as OperationReferenceIndexEntry;
}

function parseGcProtocolMetadata(value: unknown): GcProtocolMetadata | undefined {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== GC_PROTOCOL_VERSION ||
    value["protocol"] !== GC_PROTOCOL_ID ||
    typeof value["generation"] !== "string" ||
    value["generation"].length === 0 ||
    typeof value["initializedAt"] !== "string"
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as GcProtocolMetadata;
}

function parseBlobGcEligibilityMarker(value: unknown): BlobGcEligibilityMarker | undefined {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== GC_ELIGIBILITY_VERSION ||
    typeof value["protocolGeneration"] !== "string" ||
    value["protocolGeneration"].length === 0 ||
    value["algorithm"] !== "sha256" ||
    typeof value["digest"] !== "string" ||
    !SHA256_RE.test(value["digest"]) ||
    typeof value["createdAt"] !== "string"
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as BlobGcEligibilityMarker;
}

async function writeJsonExclusiveAtomic(path: string, value: unknown): Promise<boolean> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isNodeCode(error, "EEXIST")) return false;
      throw error;
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** GC marker 撤销的目录同步不能降级为 best-effort。 */
async function syncDirectoryStrict(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Expected a regular directory: ${path}`);
    }
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function readDirectoryEntries(path: string): Promise<Dirent[]> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Expected a regular directory: ${path}`);
    }
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function readRegularJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular JSON file: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function assertRegularDirectoryIfExists(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Expected a regular directory: ${path}`);
    }
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
  }
}

function assertSha256Digest(digest: string): void {
  if (!SHA256_RE.test(digest)) {
    throw new TypeError("Blob GC eligibility digest must be 64 lowercase hexadecimal characters");
  }
}

function isOperationKind(value: unknown): value is StorageOperation["kind"] {
  return value === "rewind" || value === "fork";
}

function isOperationState(value: unknown): value is StorageOperationState {
  return (
    value === "prepared" ||
    value === "workspace_applied" ||
    value === "session_committed" ||
    value === "sidecars_committed" ||
    value === "completed" ||
    value === "aborted" ||
    value === "needs_attention"
  );
}

function isOptionalAbsolutePath(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && isAbsolute(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(String(error.code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
