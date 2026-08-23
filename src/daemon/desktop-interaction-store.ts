import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { quarantineCorruptJson, writeJsonAtomic } from "../storage/atomic-json.js";

const SCHEMA_VERSION = 1 as const;
const STATE_FILE_NAME = "desktop-interactions.json";
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 4_000;

export type DesktopInteractionStatus = "pending" | "resolved" | "expired" | "interrupted";

export type DesktopInteractionResolution =
  | {
      readonly kind: "approval";
      readonly decision: "approve" | "approve-session" | "reject";
    }
  | {
      readonly kind: "prompt";
      readonly outcome: "answered";
    }
  | { readonly kind: "prompt"; readonly outcome: "cancelled" }
  | {
      readonly kind: "system";
      readonly reason: "expired" | "host_closed" | "host_restart";
    };

interface DesktopInteractionRecordBase {
  readonly ownerKey: string;
  readonly interactionId: string;
  readonly status: DesktopInteractionStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly resolution?: DesktopInteractionResolution | undefined;
}

export type DesktopInteractionRecord =
  | (DesktopInteractionRecordBase & {
      readonly kind: "approval";
      readonly metadata: {
        readonly toolName: string;
        readonly providerCallId: string;
      };
    })
  | (DesktopInteractionRecordBase & {
      readonly kind: "prompt";
      readonly metadata: {
        readonly optionCount: number;
        readonly freeText: boolean;
      };
    });

export interface DesktopInteractionStoreCommitInput {
  readonly record: DesktopInteractionRecord;
  readonly expectedVersion: number | null;
}

export interface DesktopInteractionStoreCommitResult {
  readonly record: DesktopInteractionRecord;
  readonly applied: boolean;
}

export interface DesktopInteractionStore {
  load(ownerKey: string): Promise<readonly DesktopInteractionRecord[]>;
  commit(input: DesktopInteractionStoreCommitInput): Promise<DesktopInteractionStoreCommitResult>;
  interruptPending(ownerKey: string, at: number): Promise<readonly DesktopInteractionRecord[]>;
}

export class DesktopInteractionStoreError extends Error {
  constructor(
    readonly code: "invalid_state" | "limit_exceeded" | "version_conflict",
    message: string,
    readonly currentVersion?: number | undefined,
  ) {
    super(message);
    this.name = "DesktopInteractionStoreError";
  }
}

export interface FileDesktopInteractionStoreOptions {
  readonly picoHome?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxRecords?: number | undefined;
}

interface StoredDesktopInteractionState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly records: readonly DesktopInteractionRecord[];
}

const fileQueues = new Map<string, Promise<void>>();

/** One instance is intended to be shared by main-chat and side-chat brokers in one Host. */
export class FileDesktopInteractionStore implements DesktopInteractionStore {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxRecords: number;

  constructor(options: FileDesktopInteractionStoreOptions = {}) {
    const picoHome = resolvePicoHome({ picoHome: options.picoHome });
    this.filePath = join(picoHome, STATE_FILE_NAME);
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.maxRecords = positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords");
  }

  load(ownerKey: string): Promise<readonly DesktopInteractionRecord[]> {
    const owner = boundedString(ownerKey, "ownerKey", 2_048);
    return this.#serialized(async () => {
      const state = await this.#readRecoverableState();
      return state.records.filter((record) => record.ownerKey === owner);
    });
  }

  commit(input: DesktopInteractionStoreCommitInput): Promise<DesktopInteractionStoreCommitResult> {
    const requested = decodeRecord(input.record, "record");
    if (input.expectedVersion !== null) {
      nonNegativeInteger(input.expectedVersion, "expectedVersion");
    }
    return this.#serialized(async () => {
      const state = await this.#readRecoverableState();
      const key = recordKey(requested);
      const index = state.records.findIndex((record) => recordKey(record) === key);
      const current = index >= 0 ? state.records[index] : undefined;
      if (current && sameTerminalOutcome(current, requested)) {
        return { record: current, applied: false };
      }
      if (requested.status === "pending" && current !== undefined) {
        throw new DesktopInteractionStoreError(
          "version_conflict",
          `Interaction ${requested.interactionId} cannot return to pending`,
          current.version,
        );
      }
      if (
        (input.expectedVersion === null && current !== undefined) ||
        (input.expectedVersion !== null && current?.version !== input.expectedVersion)
      ) {
        throw new DesktopInteractionStoreError(
          "version_conflict",
          `Interaction ${requested.interactionId} version conflict`,
          current?.version,
        );
      }
      const nextVersion = ownerVersion(state.records, requested.ownerKey) + 1;
      if (requested.version < nextVersion) {
        throw new DesktopInteractionStoreError(
          "version_conflict",
          `Interaction ${requested.interactionId} must use an owner version of at least ${nextVersion}`,
          current?.version,
        );
      }
      const records = [...state.records];
      if (index >= 0) records[index] = requested;
      else records.push(requested);
      await this.#writeState({ schemaVersion: SCHEMA_VERSION, records });
      return { record: requested, applied: true };
    });
  }

  interruptPending(ownerKey: string, at: number): Promise<readonly DesktopInteractionRecord[]> {
    const owner = boundedString(ownerKey, "ownerKey", 2_048);
    const interruptedAt = nonNegativeInteger(at, "at");
    return this.#serialized(async () => {
      const state = await this.#readRecoverableState();
      let version = ownerVersion(state.records, owner);
      let changed = false;
      const records = state.records.map((record): DesktopInteractionRecord => {
        if (record.ownerKey !== owner || record.status !== "pending") return record;
        changed = true;
        version += 1;
        return {
          ...record,
          status: "interrupted",
          version,
          updatedAt: interruptedAt,
          resolution: { kind: "system", reason: "host_restart" },
        };
      });
      const persisted = changed
        ? await this.#writeState({ schemaVersion: SCHEMA_VERSION, records })
        : { schemaVersion: SCHEMA_VERSION, records };
      return persisted.records.filter((record) => record.ownerKey === owner);
    });
  }

  async #readRecoverableState(): Promise<StoredDesktopInteractionState> {
    try {
      const contents = await this.#readBoundedFile();
      if (contents === undefined) return { schemaVersion: SCHEMA_VERSION, records: [] };
      return decodeState(JSON.parse(contents) as unknown, this.maxRecords);
    } catch (error) {
      if (!isCorruptStateError(error)) throw error;
      await quarantineCorruptJson(this.filePath, {
        component: "desktop-interaction-store",
        reason: diagnosticReason(error),
      });
      return { schemaVersion: SCHEMA_VERSION, records: [] };
    }
  }

  async #readBoundedFile(): Promise<string | undefined> {
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
    if (!info.isFile()) throw invalidState("Desktop interaction state must be a regular file");
    await chmod(this.filePath, 0o600);
    if (info.size > this.maxBytes) throw limitExceeded(this.maxBytes);
    const contents = await readFile(this.filePath, "utf8");
    if (Buffer.byteLength(contents) > this.maxBytes) throw limitExceeded(this.maxBytes);
    return contents;
  }

  async #writeState(state: StoredDesktopInteractionState): Promise<StoredDesktopInteractionState> {
    const decoded = decodeState(state, Number.MAX_SAFE_INTEGER);
    const bounded = boundState(decoded.records, this.maxRecords, this.maxBytes);
    await writeJsonAtomic(this.filePath, bounded, {
      directoryMode: 0o700,
      fileMode: 0o600,
      durability: "file-and-directory",
    });
    return bounded;
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = fileQueues.get(this.filePath) ?? Promise.resolve();
    const queued = current.then(operation, operation);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    fileQueues.set(this.filePath, tail);
    void tail.finally(() => {
      if (fileQueues.get(this.filePath) === tail) fileQueues.delete(this.filePath);
    });
    return queued;
  }
}

function decodeState(value: unknown, maxRecords: number): StoredDesktopInteractionState {
  const state = objectValue(value, "state");
  if (state["schemaVersion"] !== SCHEMA_VERSION || !Array.isArray(state["records"])) {
    throw invalidState("Desktop interaction state schema is invalid");
  }
  if (state["records"].length > maxRecords) {
    throw new DesktopInteractionStoreError(
      "limit_exceeded",
      `Desktop interaction state contains more than ${maxRecords} records`,
    );
  }
  const records = state["records"].map((record, index) =>
    decodeRecord(record, `records[${index}]`),
  );
  if (new Set(records.map(recordKey)).size !== records.length) {
    throw invalidState("Desktop interaction state contains duplicate ids in one owner");
  }
  const versionsByOwner = new Map<string, Set<number>>();
  for (const record of records) {
    const versions = versionsByOwner.get(record.ownerKey) ?? new Set<number>();
    if (versions.has(record.version)) {
      throw invalidState("Desktop interaction owner versions must be unique");
    }
    versions.add(record.version);
    versionsByOwner.set(record.ownerKey, versions);
  }
  return { schemaVersion: SCHEMA_VERSION, records };
}

function decodeRecord(value: unknown, label: string): DesktopInteractionRecord {
  const record = objectValue(value, label);
  const ownerKey = boundedString(record["ownerKey"], `${label}.ownerKey`, 2_048);
  const interactionId = boundedString(record["interactionId"], `${label}.interactionId`, 512);
  const kind = enumValue(record["kind"], ["approval", "prompt"] as const, `${label}.kind`);
  const status = enumValue(
    record["status"],
    ["pending", "resolved", "expired", "interrupted"] as const,
    `${label}.status`,
  );
  const version = positiveIntegerValue(record["version"], `${label}.version`);
  const createdAt = nonNegativeInteger(record["createdAt"], `${label}.createdAt`);
  const updatedAt = nonNegativeInteger(record["updatedAt"], `${label}.updatedAt`);
  if (updatedAt < createdAt) throw invalidState(`${label}.updatedAt precedes createdAt`);
  const resolution = decodeResolution(record["resolution"], status, kind, label);
  const metadata = objectValue(record["metadata"], `${label}.metadata`);
  if (kind === "approval") {
    return {
      ownerKey,
      interactionId,
      kind,
      status,
      version,
      createdAt,
      updatedAt,
      metadata: {
        toolName: boundedString(metadata["toolName"], `${label}.metadata.toolName`, 512),
        providerCallId: boundedString(
          metadata["providerCallId"],
          `${label}.metadata.providerCallId`,
          512,
        ),
      },
      ...(resolution ? { resolution } : {}),
    };
  }
  return {
    ownerKey,
    interactionId,
    kind,
    status,
    version,
    createdAt,
    updatedAt,
    metadata: {
      optionCount: boundedInteger(metadata["optionCount"], `${label}.metadata.optionCount`, 0, 6),
      freeText: booleanValue(metadata["freeText"], `${label}.metadata.freeText`),
    },
    ...(resolution ? { resolution } : {}),
  };
}

function decodeResolution(
  value: unknown,
  status: DesktopInteractionStatus,
  interactionKind: "approval" | "prompt",
  label: string,
): DesktopInteractionResolution | undefined {
  if (status === "pending") {
    if (value !== undefined) throw invalidState(`${label}.resolution is forbidden while pending`);
    return undefined;
  }
  const resolution = objectValue(value, `${label}.resolution`);
  const kind = enumValue(
    resolution["kind"],
    ["approval", "prompt", "system"] as const,
    `${label}.resolution.kind`,
  );
  if (status === "resolved" && kind === "approval" && interactionKind === "approval") {
    return {
      kind,
      decision: enumValue(
        resolution["decision"],
        ["approve", "approve-session", "reject"] as const,
        `${label}.resolution.decision`,
      ),
    };
  }
  if (status === "resolved" && kind === "prompt" && interactionKind === "prompt") {
    const outcome = enumValue(
      resolution["outcome"],
      ["answered", "cancelled"] as const,
      `${label}.resolution.outcome`,
    );
    if (outcome === "cancelled") return { kind, outcome };
    return { kind, outcome };
  }
  if (kind === "system") {
    const reason = enumValue(
      resolution["reason"],
      ["expired", "host_closed", "host_restart"] as const,
      `${label}.resolution.reason`,
    );
    if (status === "expired" && reason === "expired") return { kind, reason };
    if (status === "interrupted" && (reason === "host_closed" || reason === "host_restart")) {
      return { kind, reason };
    }
  }
  throw invalidState(`${label}.resolution does not match its lifecycle state`);
}

function sameTerminalOutcome(
  current: DesktopInteractionRecord,
  requested: DesktopInteractionRecord,
): boolean {
  return (
    current.status !== "pending" &&
    current.kind === requested.kind &&
    current.status === requested.status &&
    JSON.stringify(current.resolution) === JSON.stringify(requested.resolution)
  );
}

function ownerVersion(records: readonly DesktopInteractionRecord[], ownerKey: string): number {
  return records.reduce(
    (maximum, record) =>
      record.ownerKey === ownerKey ? Math.max(maximum, record.version) : maximum,
    0,
  );
}

function boundState(
  records: readonly DesktopInteractionRecord[],
  maxRecords: number,
  maxBytes: number,
): StoredDesktopInteractionState {
  const bounded = [...records];
  while (
    bounded.length > maxRecords ||
    Buffer.byteLength(
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: bounded }, null, 2)}\n`,
    ) > maxBytes
  ) {
    const terminal = bounded
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.status !== "pending")
      .toSorted(
        (left, right) =>
          left.record.updatedAt - right.record.updatedAt ||
          left.record.version - right.record.version,
      )[0];
    if (!terminal) {
      throw new DesktopInteractionStoreError(
        "limit_exceeded",
        "Desktop interaction pending state exceeds its storage limits",
      );
    }
    bounded.splice(terminal.index, 1);
  }
  return { schemaVersion: SCHEMA_VERSION, records: bounded };
}

function recordKey(record: Pick<DesktopInteractionRecord, "ownerKey" | "kind" | "interactionId">) {
  return `${record.ownerKey}\0${record.kind}\0${record.interactionId}`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function positiveIntegerValue(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidState(`${label} must be positive`);
  return value;
}

function invalidState(message: string): DesktopInteractionStoreError {
  return new DesktopInteractionStoreError("invalid_state", message);
}

function limitExceeded(maximum: number): DesktopInteractionStoreError {
  return new DesktopInteractionStoreError(
    "limit_exceeded",
    `Desktop interaction state exceeds ${maximum} bytes`,
  );
}

function isCorruptStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof DesktopInteractionStoreError && error.code !== "version_conflict")
  );
}

function diagnosticReason(error: unknown): string {
  if (error instanceof SyntaxError) return "Desktop interaction state JSON is malformed";
  return error instanceof Error ? error.message : "unknown invalid state";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
