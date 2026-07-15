import { chmod, mkdir, open, readFile, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RuntimeEventIntegrityError,
  assertRuntimeEvent,
  type RuntimeEvent,
} from "./runtime-event.js";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";

const RUNTIME_SESSION_MANIFEST_VERSION = 1 as const;
const SAFE_FILE_PART = /[^A-Za-z0-9._-]/g;

export interface RuntimeSessionManifest {
  readonly schemaVersion: typeof RUNTIME_SESSION_MANIFEST_VERSION;
  readonly sessionId: string;
  readonly workDir: string;
  readonly historySource: "runtime-event-v1";
  readonly createdAt: string;
  readonly activeBranchId: string;
}

export interface InitializeRuntimeSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly now?: () => Date;
}

export interface RuntimeEventStoreOptions {
  readonly baseDir: string;
}

export interface RuntimeEventStoreAppendResult {
  readonly inserted: boolean;
}

export class RuntimeEventStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventStoreIntegrityError";
  }
}

/**
 * Canonical per-run runtime fact storage. The run ledger header and Session JSONL
 * are projections; this log is the source used for replay and recovery.
 */
export class RuntimeEventStore {
  private static readonly writeTails = new Map<string, Promise<void>>();
  private readonly baseDir: string;

  constructor(options: RuntimeEventStoreOptions) {
    this.baseDir = resolve(options.baseDir);
  }

  async initializeSession(
    options: InitializeRuntimeSessionOptions,
  ): Promise<RuntimeSessionManifest> {
    const existing = await this.readSessionManifest(options.sessionId);
    if (existing) {
      if (existing.workDir !== options.workDir) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session ${options.sessionId} belongs to another workspace`,
        );
      }
      return existing;
    }
    const manifest: RuntimeSessionManifest = {
      schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
      sessionId: options.sessionId,
      workDir: options.workDir,
      historySource: "runtime-event-v1",
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      activeBranchId: "main",
    };
    await writeJsonAtomic(this.sessionManifestPath(options.sessionId), manifest, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    return manifest;
  }

  async readSessionManifest(sessionId: string): Promise<RuntimeSessionManifest | undefined> {
    try {
      return await readVersionedJson(this.sessionManifestPath(sessionId), decodeManifest);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async append(event: RuntimeEvent): Promise<RuntimeEventStoreAppendResult> {
    assertRuntimeEvent(event);
    const path = this.runtimeEventsPath(event.sessionId, event.runId);
    const key = path;
    let resolveResult!: (value: RuntimeEventStoreAppendResult) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<RuntimeEventStoreAppendResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const previous = RuntimeEventStore.writeTails.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        const inserted = await appendEvent(path, event);
        resolveResult({ inserted });
      } catch (error) {
        rejectResult(error);
      }
    });
    RuntimeEventStore.writeTails.set(
      key,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    await operation;
    return result;
  }

  async readRun(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return readEvents(this.runtimeEventsPath(sessionId, runId), sessionId, runId);
  }

  async readSession(sessionId: string): Promise<RuntimeEvent[]> {
    const directory = this.sessionDirectory(sessionId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ordered: Array<{
      readonly event: RuntimeEvent;
      readonly runId: string;
      readonly index: number;
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const events = await this.readRun(sessionId, entry.name);
      events.forEach((event, index) => ordered.push({ event, runId: entry.name, index }));
    }
    ordered.sort(
      (left, right) =>
        Date.parse(left.event.at) - Date.parse(right.event.at) ||
        left.runId.localeCompare(right.runId) ||
        left.index - right.index ||
        left.event.eventId.localeCompare(right.event.eventId),
    );
    return ordered.map(({ event }) => event);
  }

  async listRunIds(sessionId: string): Promise<string[]> {
    try {
      const entries = await readdir(this.sessionDirectory(sessionId), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  sessionDirectory(sessionId: string): string {
    return join(this.baseDir, sanitizeFilePart(sessionId));
  }

  sessionManifestPath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), "runtime-session.json");
  }

  runtimeEventsPath(sessionId: string, runId: string): string {
    return join(this.sessionDirectory(sessionId), sanitizeFilePart(runId), "runtime-events.jsonl");
  }
}

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}

async function appendEvent(path: string, event: RuntimeEvent): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "a+", 0o600);
    await chmod(path, 0o600);
    await repairTornTail(handle);
    const existing = await readEventsFromHandle(handle, event.sessionId, event.runId);
    const sameId = existing.find((candidate) => candidate.eventId === event.eventId);
    if (sameId) {
      if (JSON.stringify(sameId) !== JSON.stringify(event)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ID ${event.eventId} is already bound to another payload`,
        );
      }
      return false;
    }
    await writeAll(handle, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
    await handle.datasync();
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readEvents(
  path: string,
  expectedSessionId: string,
  expectedRunId: string,
): Promise<RuntimeEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return decodeEventLines(raw, expectedSessionId, expectedRunId);
}

async function readEventsFromHandle(
  handle: FileHandle,
  expectedSessionId: string,
  expectedRunId: string,
): Promise<RuntimeEvent[]> {
  const { size } = await handle.stat();
  if (size === 0) return [];
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0)
      throw new RuntimeEventStoreIntegrityError("Runtime event read made no progress");
    offset += bytesRead;
  }
  return decodeEventLines(bytes.toString("utf8"), expectedSessionId, expectedRunId);
}

function decodeEventLines(
  raw: string,
  expectedSessionId: string,
  expectedRunId: string,
): RuntimeEvent[] {
  const lines = raw.split("\n");
  const tornTail = raw.length > 0 && !raw.endsWith("\n");
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      assertRuntimeEvent(parsed);
      if (parsed.sessionId !== expectedSessionId || parsed.runId !== expectedRunId) {
        throw new RuntimeEventStoreIntegrityError("Runtime event identity does not match its path");
      }
      if (events.some((event) => event.eventId === parsed.eventId)) {
        throw new RuntimeEventStoreIntegrityError(`Duplicate runtime event ID ${parsed.eventId}`);
      }
      events.push(parsed);
    } catch (error) {
      if (tornTail && index === lines.length - 1) break;
      if (
        error instanceof RuntimeEventIntegrityError ||
        error instanceof RuntimeEventStoreIntegrityError
      ) {
        throw error;
      }
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event log has invalid JSON at line ${index + 1}`,
      );
    }
  }
  return events;
}

async function repairTornTail(handle: FileHandle): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0)
      throw new RuntimeEventStoreIntegrityError("Runtime event tail read made no progress");
    offset += bytesRead;
  }
  if (bytes.at(-1) === 0x0a) return;
  const tailStart = bytes.lastIndexOf(0x0a) + 1;
  try {
    JSON.parse(bytes.subarray(tailStart).toString("utf8"));
    await writeAll(handle, Buffer.from("\n", "utf8"));
  } catch {
    await handle.truncate(tailStart);
  }
  await handle.datasync();
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0)
      throw new RuntimeEventStoreIntegrityError("Runtime event write made no progress");
    offset += bytesWritten;
  }
}

function decodeManifest(value: unknown): RuntimeSessionManifest {
  if (!isRecord(value) || value["schemaVersion"] !== RUNTIME_SESSION_MANIFEST_VERSION) {
    throw new RuntimeEventStoreIntegrityError(
      "Runtime session manifest has an invalid schema version",
    );
  }
  if (
    !isNonEmptyString(value["sessionId"]) ||
    !isNonEmptyString(value["workDir"]) ||
    value["historySource"] !== "runtime-event-v1" ||
    !isNonEmptyString(value["createdAt"]) ||
    !isNonEmptyString(value["activeBranchId"])
  ) {
    throw new RuntimeEventStoreIntegrityError("Runtime session manifest is invalid");
  }
  return {
    schemaVersion: RUNTIME_SESSION_MANIFEST_VERSION,
    sessionId: value["sessionId"],
    workDir: value["workDir"],
    historySource: "runtime-event-v1",
    createdAt: value["createdAt"],
    activeBranchId: value["activeBranchId"],
  };
}

function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(SAFE_FILE_PART, "_");
  if (!sanitized) throw new RuntimeEventStoreIntegrityError("Runtime path identifier is empty");
  return sanitized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
