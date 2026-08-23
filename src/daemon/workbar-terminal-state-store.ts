import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { WorkbarTerminalRecord, WorkbarTerminalStateStore } from "@pico/runtime-host";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { quarantineCorruptJson, writeJsonAtomic } from "../storage/atomic-json.js";

const SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 1_024;
const STATE_FILE_NAME = "workbar-terminals.json";

interface StoredWorkbarTerminalState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly records: readonly WorkbarTerminalRecord[];
}

export interface FileWorkbarTerminalStateStoreOptions {
  readonly picoHome?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxRecords?: number | undefined;
}

export class WorkbarTerminalStateStoreError extends Error {
  constructor(
    readonly code: "invalid_state" | "state_too_large",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkbarTerminalStateStoreError";
  }
}

/**
 * Global Host-owned terminal metadata. Process output remains in the Host's bounded in-memory
 * ring; this store only makes lifecycle ownership and restart interruption durable.
 */
export class FileWorkbarTerminalStateStore implements WorkbarTerminalStateStore {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxRecords: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: FileWorkbarTerminalStateStoreOptions = {}) {
    const picoHome = resolvePicoHome({ picoHome: options.picoHome });
    this.filePath = join(picoHome, STATE_FILE_NAME);
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.maxRecords = positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords");
  }

  load(): Promise<readonly WorkbarTerminalRecord[]> {
    return this.#serialized(async () => {
      try {
        const contents = await this.#readBoundedState();
        if (contents === undefined) return [];
        return decodeState(JSON.parse(contents) as unknown, this.maxRecords).records;
      } catch (error) {
        if (!isCorruptStateError(error)) throw error;
        await quarantineCorruptJson(this.filePath, {
          component: "workbar-terminal-state-store",
          reason: safeErrorMessage(error),
        });
        return [];
      }
    });
  }

  save(records: readonly WorkbarTerminalRecord[]): Promise<void> {
    return this.#serialized(async () => {
      const state = decodeState({ schemaVersion: SCHEMA_VERSION, records }, this.maxRecords);
      const bytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
      if (bytes > this.maxBytes) {
        throw new WorkbarTerminalStateStoreError(
          "state_too_large",
          `Workbar terminal state exceeds ${this.maxBytes} bytes`,
        );
      }
      await writeJsonAtomic(this.filePath, state, {
        directoryMode: 0o700,
        fileMode: 0o600,
        durability: "file-and-directory",
      });
    });
  }

  async #readBoundedState(): Promise<string | undefined> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let info;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!info.isFile()) {
      throw new WorkbarTerminalStateStoreError(
        "invalid_state",
        "Workbar terminal state must be a regular file",
      );
    }
    await chmod(this.filePath, 0o600);
    if (info.size > this.maxBytes) {
      throw new WorkbarTerminalStateStoreError(
        "state_too_large",
        `Workbar terminal state exceeds ${this.maxBytes} bytes`,
      );
    }
    const contents = await readFile(this.filePath, "utf8");
    if (Buffer.byteLength(contents) > this.maxBytes) {
      throw new WorkbarTerminalStateStoreError(
        "state_too_large",
        `Workbar terminal state exceeds ${this.maxBytes} bytes`,
      );
    }
    return contents;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#queue.then(operation, operation);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

function decodeState(value: unknown, maxRecords: number): StoredWorkbarTerminalState {
  const state = objectValue(value, "state");
  if (state["schemaVersion"] !== SCHEMA_VERSION || !Array.isArray(state["records"])) {
    throw invalidState("Workbar terminal state schema is invalid");
  }
  if (state["records"].length > maxRecords) {
    throw invalidState(`Workbar terminal state contains more than ${maxRecords} records`);
  }
  const records = state["records"].map((record, index) => decodeRecord(record, index));
  if (new Set(records.map((record) => record.resourceId)).size !== records.length) {
    throw invalidState("Workbar terminal state contains duplicate resource ids");
  }
  return { schemaVersion: SCHEMA_VERSION, records };
}

function decodeRecord(value: unknown, index: number): WorkbarTerminalRecord {
  const label = `records[${index}]`;
  const record = objectValue(value, label);
  const workspacePath = absolutePath(record["workspacePath"], `${label}.workspacePath`);
  const cwd = absolutePath(record["cwd"], `${label}.cwd`);
  if (!isWithin(workspacePath, cwd)) {
    throw invalidState(`${label}.cwd escapes its workspace`);
  }
  const status = enumValue(
    record["status"],
    ["running", "exited", "stopped", "interrupted"] as const,
    `${label}.status`,
  );
  const capability = enumValue(
    record["capability"],
    ["pty", "pipe"] as const,
    `${label}.capability`,
  );
  const createdAt = nonNegativeInteger(record["createdAt"], `${label}.createdAt`);
  const updatedAt = nonNegativeInteger(record["updatedAt"], `${label}.updatedAt`);
  if (updatedAt < createdAt) throw invalidState(`${label}.updatedAt precedes createdAt`);
  const pid = optionalPositiveInteger(record["pid"], `${label}.pid`);
  if (status === "running" && pid === undefined) {
    throw invalidState(`${label}.pid is required while running`);
  }
  if (status !== "running" && pid !== undefined) {
    throw invalidState(`${label}.pid is forbidden after termination`);
  }
  const exitCode = optionalInteger(record["exitCode"], `${label}.exitCode`);
  const signal = optionalBoundedString(record["signal"], `${label}.signal`, 128);
  if (status === "running" && (exitCode !== undefined || signal !== undefined)) {
    throw invalidState(`${label} cannot contain an exit outcome while running`);
  }
  return {
    resourceId: boundedString(record["resourceId"], `${label}.resourceId`, 256),
    resourceEpoch: boundedString(record["resourceEpoch"], `${label}.resourceEpoch`, 256),
    workspacePath,
    sessionId: boundedString(record["sessionId"], `${label}.sessionId`, 512),
    status,
    capability,
    resizeSupported: booleanValue(record["resizeSupported"], `${label}.resizeSupported`),
    cwd,
    shell: boundedString(record["shell"], `${label}.shell`, 4_096),
    cols: boundedInteger(record["cols"], `${label}.cols`, 2, 500),
    rows: boundedInteger(record["rows"], `${label}.rows`, 1, 300),
    sequence: nonNegativeInteger(record["sequence"], `${label}.sequence`),
    createdAt,
    updatedAt,
    ...(pid !== undefined ? { pid } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 16_384);
  if (!isAbsolute(path)) throw invalidState(`${label} must be absolute`);
  return path;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw invalidState(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidState(`${label} must be boolean`);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidState(`${label} is invalid`);
  }
  return value as T[number];
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidState(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw invalidState(`${label} must be an integer`);
  return value as number;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkbarTerminalStateStoreError(
      "invalid_state",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function invalidState(message: string): WorkbarTerminalStateStoreError {
  return new WorkbarTerminalStateStoreError("invalid_state", message);
}

function isCorruptStateError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof WorkbarTerminalStateStoreError;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "Workbar terminal state JSON is malformed";
  return error instanceof Error ? error.message : "unknown invalid state";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
