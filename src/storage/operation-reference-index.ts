import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import type { StorageOperation, StorageOperationState } from "./operation-journal.js";

const OPERATION_REFERENCE_INDEX_VERSION = 1 as const;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface OperationReferenceIndexEntry {
  readonly schemaVersion: typeof OPERATION_REFERENCE_INDEX_VERSION;
  readonly journalDirectory: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly kind: StorageOperation["kind"];
  readonly state: StorageOperationState;
  readonly referencedDigests: readonly string[];
  readonly stagingDirectory?: string;
  readonly updatedAt: string;
}

export interface OperationReferenceIndexFailure {
  readonly path: string;
  readonly message: string;
}

export interface OperationReferenceIndexScan {
  readonly entries: readonly OperationReferenceIndexEntry[];
  readonly failures: readonly OperationReferenceIndexFailure[];
}

/**
 * 共享 CAS 的全局 operation roots。每个 workspace 仍保留本地 journal，
 * 但 GC 只需扫描这个有界索引，无需发现或遍历其他 workspace。
 */
export class OperationReferenceIndex {
  readonly directory: string;

  constructor(baseDir: string) {
    this.directory = join(resolve(baseDir), ".operation-references");
  }

  async upsert(journalDirectory: string, operation: StorageOperation): Promise<void> {
    const normalizedJournalDirectory = resolve(journalDirectory);
    const entry = {
      schemaVersion: OPERATION_REFERENCE_INDEX_VERSION,
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

  async scan(): Promise<OperationReferenceIndexScan> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return { entries: [], failures: [] };
      throw error;
    }

    const entries: OperationReferenceIndexEntry[] = [];
    const failures: OperationReferenceIndexFailure[] = [];
    for (const name of names.toSorted()) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      try {
        const entry = parseOperationReferenceIndexEntry(
          JSON.parse(await readFile(path, "utf8")) as unknown,
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
    return { entries, failures };
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
): OperationReferenceIndexEntry | undefined {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== OPERATION_REFERENCE_INDEX_VERSION ||
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
  return structuredClone(value) as unknown as OperationReferenceIndexEntry;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
