import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";

const RUN_LEDGER_SCHEMA_VERSION = 1 as const;

export type RunTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type RunStatus = "running" | RunTerminalStatus;

export interface RunStartedEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "run.started";
  readonly data: {
    readonly sessionId: string;
    readonly workDir: string;
  };
}

export interface RunTerminalEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "run.terminal";
  readonly data: {
    readonly status: RunTerminalStatus;
    readonly reason?: string;
  };
}

export type RunEvent = RunStartedEvent | RunTerminalEvent;

/**
 * `run.json` is a projection. `events.jsonl` remains the source of truth so a stale
 * projection can be rebuilt after a process crash.
 */
export interface RunHeader {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly runId: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: RunStatus;
  readonly endedAt?: string;
  readonly terminalEventId?: string;
  readonly terminalReason?: string;
}

export interface RunLedgerSnapshot {
  readonly header: RunHeader;
  readonly events: readonly RunEvent[];
}

export interface RunLedgerStartOptions {
  readonly baseDir: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly runId?: string;
  readonly now?: () => Date;
}

export interface ReconcileRunLedgerOptions {
  readonly baseDir: string;
  readonly sessionId: string;
  readonly now?: () => Date;
}

export class RunLedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLedgerIntegrityError";
  }
}

/**
 * A durable control-plane ledger for one Agent execution.
 *
 * The Session JSONL is the conversational memory. This ledger answers a different
 * question: whether a particular execution reached a durable terminal state.
 */
export class RunLedger {
  /** Live runs in this process must not be mistaken for crash remnants by a later call. */
  private static readonly activeRunKeys = new Set<string>();
  private readonly runDirectory: string;
  private readonly eventsPath: string;
  private readonly headerPath: string;
  private terminal?: RunTerminalEvent;

  private constructor(
    private readonly options: Required<
      Pick<RunLedgerStartOptions, "baseDir" | "sessionId" | "workDir">
    > & {
      readonly runId: string;
      readonly now: () => Date;
    },
  ) {
    this.runDirectory = join(options.baseDir, sanitizeFilePart(options.sessionId), options.runId);
    this.eventsPath = join(this.runDirectory, "events.jsonl");
    this.headerPath = join(this.runDirectory, "run.json");
  }

  get runId(): string {
    return this.options.runId;
  }

  static async start(options: RunLedgerStartOptions): Promise<RunLedger> {
    const ledger = new RunLedger({
      baseDir: options.baseDir,
      sessionId: options.sessionId,
      workDir: options.workDir,
      runId: options.runId ?? randomUUID(),
      now: options.now ?? (() => new Date()),
    });
    if (RunLedger.activeRunKeys.has(ledger.activeRunKey)) {
      throw new RunLedgerIntegrityError(`Run ${ledger.runId} is already active in this process`);
    }
    RunLedger.activeRunKeys.add(ledger.activeRunKey);
    try {
      await mkdir(dirname(ledger.runDirectory), { recursive: true, mode: 0o700 });
      await mkdir(ledger.runDirectory, { recursive: false, mode: 0o700 });
      await chmod(ledger.runDirectory, 0o700);

      const started: RunStartedEvent = {
        schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
        eventId: randomUUID(),
        runId: ledger.runId,
        at: ledger.nowIso(),
        type: "run.started",
        data: { sessionId: ledger.options.sessionId, workDir: ledger.options.workDir },
      };
      await appendEventDurably(ledger.eventsPath, started);
      await ledger.writeProjection([started]);
      return ledger;
    } catch (error) {
      ledger.releaseActiveRun();
      throw error;
    }
  }

  static async startForSession(
    sessionId: string,
    workDir: string,
    options: Omit<RunLedgerStartOptions, "baseDir" | "sessionId" | "workDir"> = {},
  ): Promise<RunLedger> {
    return RunLedger.start({
      ...options,
      baseDir: resolvePicoPaths(workDir).workspace.runs,
      sessionId,
      workDir,
    });
  }

  /**
   * Recover only the control plane: every run lacking a terminal fact is closed as
   * interrupted. The engine deliberately does not resume a half-completed tool call.
   */
  static async reconcileIncompleteRuns(options: ReconcileRunLedgerOptions): Promise<RunHeader[]> {
    const sessionDirectory = join(options.baseDir, sanitizeFilePart(options.sessionId));
    let entries;
    try {
      entries = await readdir(sessionDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const reconciled: RunHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDirectory = join(sessionDirectory, entry.name);
      if (RunLedger.activeRunKeys.has(runKey(options.baseDir, options.sessionId, entry.name))) {
        continue;
      }
      const eventsPath = join(runDirectory, "events.jsonl");
      const events = await loadEvents(eventsPath, entry.name);
      if (events.length === 0) continue;
      const header = headerFromEvents(events, entry.name);
      if (header.sessionId !== options.sessionId) {
        throw new RunLedgerIntegrityError(`Run ${entry.name} belongs to another session`);
      }
      const terminal = findTerminalEvent(events);
      if (terminal) {
        await writeRunHeader(join(runDirectory, "run.json"), header);
        continue;
      }

      const interrupted: RunTerminalEvent = {
        schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
        eventId: randomUUID(),
        runId: entry.name,
        at: (options.now ?? (() => new Date()))().toISOString(),
        type: "run.terminal",
        data: { status: "interrupted", reason: "recovered_without_terminal_fact" },
      };
      // Durable terminal fact first. The header update below is intentionally second.
      await appendEventDurably(eventsPath, interrupted);
      const recoveredHeader = headerFromEvents([...events, interrupted], entry.name);
      await writeRunHeader(join(runDirectory, "run.json"), recoveredHeader);
      reconciled.push(recoveredHeader);
    }
    return reconciled;
  }

  async finish(status: RunTerminalStatus, reason?: string): Promise<RunHeader> {
    if (this.terminal) {
      const snapshot = await this.load();
      return snapshot.header;
    }
    const snapshot = await this.load();
    const existing = findTerminalEvent(snapshot.events);
    if (existing) {
      this.terminal = existing;
      this.releaseActiveRun();
      return snapshot.header;
    }

    const terminal: RunTerminalEvent = {
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "run.terminal",
      data: { status, ...(reason ? { reason } : {}) },
    };
    // The event is durable before `run.json` is allowed to say this run is terminal.
    try {
      await appendEventDurably(this.eventsPath, terminal);
      this.terminal = terminal;
      return await this.writeProjection([...snapshot.events, terminal]);
    } finally {
      this.releaseActiveRun();
    }
  }

  async load(): Promise<RunLedgerSnapshot> {
    const events = await loadEvents(this.eventsPath, this.runId);
    return { events, header: headerFromEvents(events, this.runId) };
  }

  private async writeProjection(events: readonly RunEvent[]): Promise<RunHeader> {
    const header = headerFromEvents(events, this.runId);
    await writeRunHeader(this.headerPath, header);
    return header;
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private get activeRunKey(): string {
    return runKey(this.options.baseDir, this.options.sessionId, this.runId);
  }

  private releaseActiveRun(): void {
    RunLedger.activeRunKeys.delete(this.activeRunKey);
  }
}

async function appendEventDurably(path: string, event: RunEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "a+", 0o600);
    await repairTornTail(handle);
    await writeAll(handle, Buffer.from(`${JSON.stringify(event)}\n`, "utf8"));
    await handle.datasync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function repairTornTail(handle: FileHandle): Promise<void> {
  const { size } = await handle.stat();
  if (size === 0) return;
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead <= 0) throw new RunLedgerIntegrityError("Run ledger read made no progress");
    offset += bytesRead;
  }
  if (bytes.at(-1) === 0x0a) return;

  const tailStart = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(tailStart).toString("utf8");
  try {
    JSON.parse(tail);
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
    if (bytesWritten <= 0) throw new RunLedgerIntegrityError("Run ledger write made no progress");
    offset += bytesWritten;
  }
}

async function loadEvents(path: string, expectedRunId: string): Promise<RunEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const lines = raw.split("\n");
  const hasTornTail = raw.length > 0 && !raw.endsWith("\n");
  const events: RunEvent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) continue;
    try {
      const event = decodeRunEvent(JSON.parse(line) as unknown);
      if (event.runId !== expectedRunId) {
        throw new RunLedgerIntegrityError(
          `Run event belongs to ${event.runId}, expected ${expectedRunId}`,
        );
      }
      events.push(event);
    } catch (error) {
      if (
        hasTornTail &&
        index === lines.length - 1 &&
        !(error instanceof RunLedgerIntegrityError)
      ) {
        break;
      }
      throw error instanceof RunLedgerIntegrityError
        ? error
        : new RunLedgerIntegrityError(`Malformed run ledger event: ${String(error)}`);
    }
  }
  return events;
}

function decodeRunEvent(value: unknown): RunEvent {
  if (!isRecord(value)) throw new RunLedgerIntegrityError("Run event must be an object");
  if (
    value["schemaVersion"] !== RUN_LEDGER_SCHEMA_VERSION ||
    !isNonEmptyString(value["eventId"]) ||
    !isNonEmptyString(value["runId"]) ||
    !isNonEmptyString(value["at"]) ||
    !isRecord(value["data"])
  ) {
    throw new RunLedgerIntegrityError("Run event has an invalid envelope");
  }
  if (value["type"] === "run.started") {
    if (
      !isNonEmptyString(value["data"]["sessionId"]) ||
      !isNonEmptyString(value["data"]["workDir"])
    ) {
      throw new RunLedgerIntegrityError("Run start event has invalid data");
    }
    return value as unknown as RunStartedEvent;
  }
  if (value["type"] === "run.terminal") {
    const status = value["data"]["status"];
    if (!isRunTerminalStatus(status) || !isOptionalString(value["data"]["reason"])) {
      throw new RunLedgerIntegrityError("Run terminal event has invalid data");
    }
    return value as unknown as RunTerminalEvent;
  }
  throw new RunLedgerIntegrityError(`Unknown run event type: ${String(value["type"])}`);
}

function headerFromEvents(events: readonly RunEvent[], runId: string): RunHeader {
  const started = events.find((event): event is RunStartedEvent => event.type === "run.started");
  if (!started) throw new RunLedgerIntegrityError(`Run ${runId} has no start fact`);
  if (events.filter((event) => event.type === "run.started").length !== 1) {
    throw new RunLedgerIntegrityError(`Run ${runId} has more than one start fact`);
  }
  const terminal = findTerminalEvent(events);
  if (events.filter((event) => event.type === "run.terminal").length > 1) {
    throw new RunLedgerIntegrityError(`Run ${runId} has more than one terminal fact`);
  }
  return {
    schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
    runId,
    sessionId: started.data.sessionId,
    workDir: started.data.workDir,
    startedAt: started.at,
    updatedAt: terminal?.at ?? started.at,
    status: terminal?.data.status ?? "running",
    ...(terminal
      ? {
          endedAt: terminal.at,
          terminalEventId: terminal.eventId,
          ...(terminal.data.reason ? { terminalReason: terminal.data.reason } : {}),
        }
      : {}),
  };
}

function findTerminalEvent(events: readonly RunEvent[]): RunTerminalEvent | undefined {
  return events.find((event): event is RunTerminalEvent => event.type === "run.terminal");
}

async function writeRunHeader(path: string, header: RunHeader): Promise<void> {
  await writeJsonAtomic(path, header, { directoryMode: 0o700, fileMode: 0o600 });
}

function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

function runKey(baseDir: string, sessionId: string, runId: string): string {
  return `${resolve(baseDir)}\0${sanitizeFilePart(sessionId)}\0${runId}`;
}

function isRunTerminalStatus(value: unknown): value is RunTerminalStatus {
  return (
    value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
