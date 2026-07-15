import { AsyncLocalStorage } from "node:async_hooks";
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

export interface TurnStartedEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "turn.started";
  readonly data: {
    readonly turn: number;
  };
}

export interface ToolStartedEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "tool.started";
  readonly data: {
    readonly callId: string;
    readonly toolName: string;
    readonly turn: number;
  };
}

export interface ToolObservationCommittedEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "tool.observation_committed";
  readonly data: {
    readonly callId: string;
    readonly toolName: string;
    readonly turn: number;
    readonly isError: boolean;
  };
}

export interface ApprovalRequestedEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "approval.requested";
  readonly data: {
    readonly approvalId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly turn: number;
  };
}

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalSettledEvent {
  readonly schemaVersion: typeof RUN_LEDGER_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly at: string;
  readonly type: "approval.settled";
  readonly data: {
    readonly approvalId: string;
    readonly decision: ApprovalDecision;
  };
}

export type RunEvent =
  | RunStartedEvent
  | RunTerminalEvent
  | TurnStartedEvent
  | ToolStartedEvent
  | ToolObservationCommittedEvent
  | ApprovalRequestedEvent
  | ApprovalSettledEvent;

type RuntimeRunEvent = Exclude<RunEvent, RunStartedEvent | RunTerminalEvent>;

export interface RunLedgerTurnStartedOptions {
  readonly turn: number;
}

export interface RunLedgerToolStartedOptions {
  readonly callId: string;
  readonly toolName: string;
  readonly turn: number;
}

export interface RunLedgerToolObservationCommittedOptions extends RunLedgerToolStartedOptions {
  readonly isError: boolean;
}

export interface RunLedgerApprovalRequestedOptions extends RunLedgerToolStartedOptions {
  readonly approvalId: string;
}

export interface RunLedgerApprovalSettledOptions {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}

const runLedgerContext = new AsyncLocalStorage<RunLedger>();

/** Returns the durable ledger associated with the current async execution, if any. */
export function currentRunLedger(): RunLedger | undefined {
  return runLedgerContext.getStore();
}

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
  private operationTail: Promise<void> = Promise.resolve();
  private terminal?: RunTerminalEvent;
  private currentTurnNumber?: number;

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

  get currentTurn(): number | undefined {
    return this.currentTurnNumber;
  }

  /**
   * Binds this ledger to an async execution so middleware can append durable facts
   * without depending on Reporter plumbing. The context never carries event payloads.
   */
  static runInContext<Result>(ledger: RunLedger, fn: () => Result): Result {
    return runLedgerContext.run(ledger, fn);
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
      decodeRunEvent(started);
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
    return this.enqueue(async () => {
      if (this.terminal) {
        const snapshot = await this.readSnapshot();
        return this.writeProjection(snapshot.events);
      }

      const snapshot = await this.readSnapshot();
      const existing = findTerminalEvent(snapshot.events);
      if (existing) {
        this.terminal = existing;
        try {
          return await this.writeProjection(snapshot.events);
        } finally {
          this.releaseActiveRun();
        }
      }

      const terminal: RunTerminalEvent = {
        schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
        eventId: randomUUID(),
        runId: this.runId,
        at: this.nowIso(),
        type: "run.terminal",
        data: { status, ...(reason ? { reason } : {}) },
      };
      decodeRunEvent(terminal);
      validateRunEventFlow([...snapshot.events, terminal], this.runId);
      // The event is durable before `run.json` is allowed to say this run is terminal.
      try {
        await appendEventDurably(this.eventsPath, terminal);
        this.terminal = terminal;
        return await this.writeProjection([...snapshot.events, terminal]);
      } finally {
        this.releaseActiveRun();
      }
    });
  }

  /** Records a turn boundary without the user prompt or model response. */
  recordTurnStarted({ turn }: RunLedgerTurnStartedOptions): Promise<void> {
    return this.appendRuntimeEvent(() => ({
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "turn.started",
      data: { turn },
    })).then(() => {
      this.currentTurnNumber = turn;
    });
  }

  /** Records a tool invocation identity without its arguments. */
  recordToolStarted({ callId, toolName, turn }: RunLedgerToolStartedOptions): Promise<void> {
    return this.appendRuntimeEvent(() => ({
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "tool.started",
      data: { callId, toolName, turn },
    }));
  }

  /** Records that a tool observation crossed the model boundary, never its content. */
  recordToolObservationCommitted({
    callId,
    toolName,
    turn,
    isError,
  }: RunLedgerToolObservationCommittedOptions): Promise<void> {
    return this.appendRuntimeEvent(() => ({
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "tool.observation_committed",
      data: { callId, toolName, turn, isError },
    }));
  }

  /** Records an approval correlation identity without the approval preview or tool arguments. */
  recordApprovalRequested({
    approvalId,
    callId,
    toolName,
    turn,
  }: RunLedgerApprovalRequestedOptions): Promise<void> {
    return this.appendRuntimeEvent(() => ({
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "approval.requested",
      data: { approvalId, callId, toolName, turn },
    }));
  }

  /** Records only the approval outcome; the caller must not pass a reason or edited content. */
  recordApprovalSettled({ approvalId, decision }: RunLedgerApprovalSettledOptions): Promise<void> {
    return this.appendRuntimeEvent(() => ({
      schemaVersion: RUN_LEDGER_SCHEMA_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      at: this.nowIso(),
      type: "approval.settled",
      data: { approvalId, decision },
    }));
  }

  load(): Promise<RunLedgerSnapshot> {
    return this.enqueue(() => this.readSnapshot());
  }

  private async readSnapshot(): Promise<RunLedgerSnapshot> {
    const events = await loadEvents(this.eventsPath, this.runId);
    return { events, header: headerFromEvents(events, this.runId) };
  }

  private appendRuntimeEvent(createEvent: () => RuntimeRunEvent): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = await this.readSnapshot();
      if (this.terminal || findTerminalEvent(snapshot.events)) {
        throw new RunLedgerIntegrityError(`Run ${this.runId} is already terminal`);
      }

      const event = createEvent();
      decodeRunEvent(event);
      validateRunEventFlow([...snapshot.events, event], this.runId);
      await appendEventDurably(this.eventsPath, event);
      await this.writeProjection([...snapshot.events, event]);
    });
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
  if (value["type"] === "turn.started") {
    if (!isPositiveInteger(value["data"]["turn"])) {
      throw new RunLedgerIntegrityError("Run turn event has invalid data");
    }
    return value as unknown as TurnStartedEvent;
  }
  if (value["type"] === "tool.started") {
    if (
      !isNonEmptyString(value["data"]["callId"]) ||
      !isNonEmptyString(value["data"]["toolName"]) ||
      !isPositiveInteger(value["data"]["turn"])
    ) {
      throw new RunLedgerIntegrityError("Run tool start event has invalid data");
    }
    return value as unknown as ToolStartedEvent;
  }
  if (value["type"] === "tool.observation_committed") {
    if (
      !isNonEmptyString(value["data"]["callId"]) ||
      !isNonEmptyString(value["data"]["toolName"]) ||
      !isPositiveInteger(value["data"]["turn"]) ||
      typeof value["data"]["isError"] !== "boolean"
    ) {
      throw new RunLedgerIntegrityError("Run tool observation event has invalid data");
    }
    return value as unknown as ToolObservationCommittedEvent;
  }
  if (value["type"] === "approval.requested") {
    if (
      !isNonEmptyString(value["data"]["approvalId"]) ||
      !isNonEmptyString(value["data"]["callId"]) ||
      !isNonEmptyString(value["data"]["toolName"]) ||
      !isPositiveInteger(value["data"]["turn"])
    ) {
      throw new RunLedgerIntegrityError("Run approval request event has invalid data");
    }
    return value as unknown as ApprovalRequestedEvent;
  }
  if (value["type"] === "approval.settled") {
    if (
      !isNonEmptyString(value["data"]["approvalId"]) ||
      !isApprovalDecision(value["data"]["decision"])
    ) {
      throw new RunLedgerIntegrityError("Run approval settlement event has invalid data");
    }
    return value as unknown as ApprovalSettledEvent;
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
  validateRunEventFlow(events, runId);
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

function validateRunEventFlow(events: readonly RunEvent[], runId: string): void {
  const tools = new Map<
    string,
    { readonly toolName: string; readonly turn: number; observed: boolean }
  >();
  const approvals = new Map<string, boolean>();
  let sawStart = false;
  let terminalSeen = false;
  let currentTurn = 0;

  for (const event of events) {
    if (event.runId !== runId) {
      throw new RunLedgerIntegrityError(`Run ${runId} event identity mismatch`);
    }
    if (terminalSeen) {
      throw new RunLedgerIntegrityError(`Run ${runId} has facts after its terminal event`);
    }
    if (event.type === "run.started") {
      if (sawStart) throw new RunLedgerIntegrityError(`Run ${runId} has more than one start fact`);
      sawStart = true;
      continue;
    }
    if (!sawStart)
      throw new RunLedgerIntegrityError(`Run ${runId} has activity before its start fact`);
    switch (event.type) {
      case "run.terminal":
        terminalSeen = true;
        break;
      case "turn.started":
        if (event.data.turn <= currentTurn) {
          throw new RunLedgerIntegrityError(`Run ${runId} has a non-monotonic turn number`);
        }
        currentTurn = event.data.turn;
        break;
      case "tool.started":
        if (event.data.turn !== currentTurn || tools.has(event.data.callId)) {
          throw new RunLedgerIntegrityError(`Run ${runId} has an invalid tool start fact`);
        }
        tools.set(event.data.callId, {
          toolName: event.data.toolName,
          turn: event.data.turn,
          observed: false,
        });
        break;
      case "tool.observation_committed": {
        const tool = tools.get(event.data.callId);
        if (
          !tool ||
          tool.observed ||
          tool.toolName !== event.data.toolName ||
          tool.turn !== event.data.turn
        ) {
          throw new RunLedgerIntegrityError(`Run ${runId} has an invalid tool observation fact`);
        }
        tool.observed = true;
        break;
      }
      case "approval.requested": {
        const tool = tools.get(event.data.callId);
        if (
          !tool ||
          approvals.has(event.data.approvalId) ||
          tool.toolName !== event.data.toolName ||
          tool.turn !== event.data.turn
        ) {
          throw new RunLedgerIntegrityError(`Run ${runId} has an invalid approval request fact`);
        }
        approvals.set(event.data.approvalId, false);
        break;
      }
      case "approval.settled":
        if (
          !approvals.has(event.data.approvalId) ||
          approvals.get(event.data.approvalId) === true
        ) {
          throw new RunLedgerIntegrityError(`Run ${runId} has an invalid approval settlement fact`);
        }
        approvals.set(event.data.approvalId, true);
        break;
    }
  }
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "approved" || value === "rejected";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
