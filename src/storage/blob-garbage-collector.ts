import { constants } from "node:fs";
import { lstat, open, readFile, readdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createFileHistoryState, fileHistoryLoadState } from "../safety/file-history.js";
import { withFileHistoryMutationLease } from "./file-history-mutation-lease.js";
import { OperationReferenceIndex } from "./operation-reference-index.js";
import type { OwnerLease } from "./owner-lease.js";
import { StorageOperationJournal } from "./operation-journal.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;
// needs_attention 仍表示尚未被人工明确放弃或完成的 Saga，必须持续作为 GC root。
const TERMINAL_OPERATION_STATES = new Set(["completed", "aborted"]);

export interface BlobGarbageCollectorOptions {
  readonly workDir: string;
  readonly baseDir: string;
  readonly gracePeriodMs: number;
  readonly now?: () => number;
  /** 未来 fork/summary/artifact 将 CAS 引用外部化时可显式增加根。 */
  readonly additionalReferenceRoots?: readonly string[];
}

export interface BlobGarbageCollectionResult {
  readonly dryRun: boolean;
  readonly blocked: boolean;
  readonly blockedReasons: readonly BlobGarbageCollectionBlock[];
  readonly reachableDigests: readonly string[];
  readonly retainedPaths: readonly string[];
  readonly candidatePaths: readonly string[];
  readonly deletedPaths: readonly string[];
}

export interface BlobGarbageCollectionBlock {
  readonly component: "file_history" | "operation";
  readonly path: string;
  readonly message: string;
}

export interface BlobGarbageCollectionRunOptions {
  /** 默认 false；只有显式 apply 才删除。 */
  readonly apply?: boolean;
}

/** File History CAS 的保守型 mark-and-sweep。 */
export class ContentAddressedBlobGarbageCollector {
  private readonly workDir: string;
  private readonly baseDir: string;
  private readonly gracePeriodMs: number;
  private readonly now: () => number;
  private readonly additionalReferenceRoots: readonly string[];

  constructor(options: BlobGarbageCollectorOptions) {
    if (!Number.isFinite(options.gracePeriodMs) || options.gracePeriodMs < 0) {
      throw new Error("gracePeriodMs must be non-negative");
    }
    this.workDir = resolve(options.workDir);
    this.baseDir = resolve(options.baseDir);
    this.gracePeriodMs = options.gracePeriodMs;
    this.now = options.now ?? Date.now;
    this.additionalReferenceRoots = options.additionalReferenceRoots ?? [];
  }

  async run(options: BlobGarbageCollectionRunOptions = {}): Promise<BlobGarbageCollectionResult> {
    if (options.apply !== true) return this.collectAndSweep(false);
    return withFileHistoryMutationLease(
      this.baseDir,
      `cas-gc:${process.pid}`,
      async (lease) => this.collectAndSweep(true, lease),
      { waitForExternalLease: false },
    );
  }

  private async collectAndSweep(
    apply: boolean,
    lease?: OwnerLease,
  ): Promise<BlobGarbageCollectionResult> {
    const mark = await this.collectReachableDigests();
    const reachable = mark.reachable;
    const retainedPaths: string[] = [];
    const candidatePaths: string[] = [];
    const deletedPaths: string[] = [];
    const operationReferenceIndex = new OperationReferenceIndex(this.baseDir);
    const blobPaths = await this.listBlobPaths();
    if (mark.blockedReasons.length > 0) {
      return {
        dryRun: true,
        blocked: true,
        blockedReasons: mark.blockedReasons.toSorted(compareBlocks),
        reachableDigests: [...reachable].toSorted(),
        retainedPaths: blobPaths,
        candidatePaths: [],
        deletedPaths: [],
      };
    }
    for (const path of blobPaths) {
      const digest = basename(path);
      const metadata = await stat(path);
      if (
        !mark.gcEligible.has(digest) ||
        reachable.has(digest) ||
        this.now() - metadata.mtimeMs < this.gracePeriodMs
      ) {
        retainedPaths.push(path);
        continue;
      }
      if (apply) {
        await lease?.assertOwnership();
        // marker 是 blob 当前 incarnation 的回收资格。必须先持久撤销，
        // 再删除 blob；否则同 digest 被旧 writer 重建后会继承旧资格。
        if (!(await operationReferenceIndex.revokeBlobGcEligibility(digest))) {
          retainedPaths.push(path);
          continue;
        }
        candidatePaths.push(path);
        await unlink(path);
        await syncDirectory(dirname(path));
        deletedPaths.push(path);
      } else {
        candidatePaths.push(path);
      }
    }
    return {
      dryRun: !apply,
      blocked: false,
      blockedReasons: [],
      reachableDigests: [...reachable].toSorted(),
      retainedPaths: retainedPaths.toSorted(),
      candidatePaths: candidatePaths.toSorted(),
      deletedPaths: deletedPaths.toSorted(),
    };
  }

  private async collectReachableDigests(): Promise<{
    reachable: Set<string>;
    gcEligible: Set<string>;
    blockedReasons: BlobGarbageCollectionBlock[];
  }> {
    const reachable = new Set<string>();
    const blockedReasons: BlobGarbageCollectionBlock[] = [];
    const fileHistoryDirectories = (await readDirectoryEntries(this.baseDir))
      .filter(
        (entry) => entry.isDirectory() && entry.name !== "blobs" && !entry.name.startsWith("."),
      )
      .map((entry) => join(this.baseDir, entry.name, "manifest.json"));
    const workspacePaths = resolvePicoPaths(this.workDir).workspace;
    const operationsDirectory = workspacePaths.storageOperations;
    const operationPaths = (await readDirectoryEntries(operationsDirectory))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(operationsDirectory, entry.name));

    for (const path of fileHistoryDirectories) {
      try {
        const value = await readJsonRequired(path);
        if (
          !isRecord(value) ||
          value["schemaVersion"] !== 2 ||
          typeof value["sessionId"] !== "string"
        ) {
          throw new Error("legacy or malformed manifest must be migrated before CAS GC");
        }
        const sessionId = value["sessionId"];
        const state = createFileHistoryState();
        if (!(await fileHistoryLoadState(state, sessionId, this.baseDir))) {
          throw new Error("manifest disappeared during mark phase");
        }
        for (const snapshot of state.snapshots) {
          for (const backup of snapshot.trackedFileBackups.values()) {
            if (backup.blobRef) reachable.add(backup.blobRef.digest);
          }
        }
      } catch (error) {
        blockedReasons.push({
          component: "file_history",
          path,
          message: errorMessage(error),
        });
      }
    }
    const journal = new StorageOperationJournal({ workDir: this.workDir });
    for (const path of operationPaths) {
      try {
        const name = basename(path);
        const operationId = name.slice(0, -".json".length);
        if (!/^[A-Za-z0-9._-]+$/u.test(operationId)) throw new Error("invalid operation filename");
        const operation = await journal.get(operationId);
        if (!operation) throw new Error("operation disappeared during mark phase");
        if (TERMINAL_OPERATION_STATES.has(operation.state)) continue;
        collectDigestReferences(operation, reachable);
        if (operation.kind === "fork") {
          await collectReferencesFromTree(operation.stagingDirectory, reachable, true);
        }
      } catch (error) {
        blockedReasons.push({
          component: "operation",
          path,
          message: errorMessage(error),
        });
      }
    }

    const globalOperationReferences = await new OperationReferenceIndex(this.baseDir).scan();
    for (const failure of globalOperationReferences.failures) {
      blockedReasons.push({
        component: "operation",
        path: failure.path,
        message: failure.message,
      });
    }
    for (const operation of globalOperationReferences.entries) {
      if (TERMINAL_OPERATION_STATES.has(operation.state)) continue;
      for (const digest of operation.referencedDigests) reachable.add(digest);
      if (operation.kind === "fork" && operation.stagingDirectory) {
        try {
          await collectReferencesFromTree(operation.stagingDirectory, reachable, true);
        } catch (error) {
          blockedReasons.push({
            component: "operation",
            path: operation.stagingDirectory,
            message: errorMessage(error),
          });
        }
      }
    }
    const gcEligible = new Set(globalOperationReferences.gcEligibleDigests);

    const defaultReferenceRoots = [workspacePaths.summaries, workspacePaths.artifacts];
    for (const root of [...defaultReferenceRoots, ...this.additionalReferenceRoots]) {
      await collectReferencesFromTree(root, reachable, false);
    }
    return { reachable, gcEligible, blockedReasons };
  }

  private async listBlobPaths(): Promise<string[]> {
    const root = join(this.baseDir, "blobs", "sha256");
    const paths: string[] = [];
    for (const prefix of await readDirectoryEntries(root)) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      for (const entry of await readDirectoryEntries(join(root, prefix.name))) {
        if (!entry.isFile() || !SHA256_RE.test(entry.name) || !entry.name.startsWith(prefix.name)) {
          continue;
        }
        const path = join(root, prefix.name, entry.name);
        const metadata = await lstat(path);
        if (metadata.isFile() && !metadata.isSymbolicLink()) paths.push(path);
      }
    }
    return paths.toSorted();
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

async function collectReferencesFromTree(
  path: string,
  target: Set<string>,
  required: boolean,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT") && !required) return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    if (path.endsWith(".json")) await collectReferencesFromJsonFile(path, target, required);
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await collectReferencesFromTree(join(path, entry.name), target, required);
  }
}

async function collectReferencesFromJsonFile(
  path: string,
  target: Set<string>,
  throwOnInvalid: boolean,
): Promise<void> {
  const value = await readJsonIfPossible(path, throwOnInvalid);
  if (value !== undefined) collectDigestReferences(value, target);
}

function collectDigestReferences(value: unknown, target: Set<string>, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const child of value) collectDigestReferences(child, target, parentKey);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      SHA256_RE.test(child) &&
      (key === "blobSha256" ||
        key === "digest" ||
        key === "blobDigest" ||
        key === "contentBlobSha256" ||
        parentKey === "blob" ||
        parentKey === "blobRef")
    ) {
      target.add(child);
    }
    collectDigestReferences(child, target, key);
  }
}

async function readJsonIfPossible(path: string, throwOnInvalid = false): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
    if (!throwOnInvalid && error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readJsonRequired(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }
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

function compareBlocks(
  left: BlobGarbageCollectionBlock,
  right: BlobGarbageCollectionBlock,
): number {
  return left.component.localeCompare(right.component) || left.path.localeCompare(right.path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
