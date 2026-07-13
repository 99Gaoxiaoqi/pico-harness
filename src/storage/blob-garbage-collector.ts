import { lstat, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { OwnerLease } from "./owner-lease.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const TERMINAL_OPERATION_STATES = new Set(["completed", "aborted", "needs_attention"]);

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
  readonly reachableDigests: readonly string[];
  readonly retainedPaths: readonly string[];
  readonly candidatePaths: readonly string[];
  readonly deletedPaths: readonly string[];
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
    const lease = await OwnerLease.acquire({
      leaseDirectory: join(this.baseDir, ".leases", "cas-gc"),
      ownerId: `cas-gc:${process.pid}`,
    });
    try {
      const reachable = await this.collectReachableDigests();
      const retainedPaths: string[] = [];
      const candidatePaths: string[] = [];
      const deletedPaths: string[] = [];
      for (const path of await this.listBlobPaths()) {
        const digest = basename(path);
        const metadata = await stat(path);
        if (reachable.has(digest) || this.now() - metadata.mtimeMs < this.gracePeriodMs) {
          retainedPaths.push(path);
          continue;
        }
        candidatePaths.push(path);
        if (options.apply === true) {
          await lease.assertOwnership();
          await unlink(path);
          deletedPaths.push(path);
        }
      }
      return {
        dryRun: options.apply !== true,
        reachableDigests: [...reachable].toSorted(),
        retainedPaths: retainedPaths.toSorted(),
        candidatePaths: candidatePaths.toSorted(),
        deletedPaths: deletedPaths.toSorted(),
      };
    } finally {
      await lease.release();
    }
  }

  private async collectReachableDigests(): Promise<Set<string>> {
    const reachable = new Set<string>();
    const fileHistoryDirectories = (await readDirectoryEntries(this.baseDir))
      .filter((entry) => entry.isDirectory() && entry.name !== "blobs" && entry.name !== ".leases")
      .map((entry) => join(this.baseDir, entry.name, "manifest.json"));
    const operationsDirectory = join(this.workDir, ".claw", "storage-operations");
    const operationPaths = (await readDirectoryEntries(operationsDirectory))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(operationsDirectory, entry.name));

    for (const path of fileHistoryDirectories) {
      await collectReferencesFromJsonFile(path, reachable, false);
    }
    for (const path of operationPaths) {
      const value = await readJsonIfPossible(path);
      if (!isRecord(value) || TERMINAL_OPERATION_STATES.has(String(value["state"]))) continue;
      collectDigestReferences(value, reachable);
      if (value["kind"] === "fork" && typeof value["stagingDirectory"] === "string") {
        await collectReferencesFromTree(value["stagingDirectory"], reachable);
      }
    }

    const defaultReferenceRoots = [
      join(this.workDir, ".claw", "memory", "summaries"),
      join(this.workDir, ".claw", "artifacts"),
    ];
    for (const root of [...defaultReferenceRoots, ...this.additionalReferenceRoots]) {
      await collectReferencesFromTree(root, reachable);
    }
    return reachable;
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

async function collectReferencesFromTree(path: string, target: Set<string>): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    if (path.endsWith(".json")) await collectReferencesFromJsonFile(path, target, false);
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await collectReferencesFromTree(join(path, entry.name), target);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
