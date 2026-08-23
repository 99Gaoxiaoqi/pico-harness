import { spawn as spawnChild, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type WorkbarTerminalCapability = "pty" | "pipe";
export type WorkbarTerminalStatus = "running" | "exited" | "stopped" | "interrupted";

export interface WorkbarTerminalOwner {
  readonly workspacePath: string;
  readonly sessionId: string;
}

export interface WorkbarTerminalRecord extends WorkbarTerminalOwner {
  readonly resourceId: string;
  readonly resourceEpoch: string;
  readonly status: WorkbarTerminalStatus;
  readonly capability: WorkbarTerminalCapability;
  readonly resizeSupported: boolean;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly sequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly pid?: number | undefined;
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
}

export type WorkbarTerminalEvent =
  | {
      readonly kind: "output";
      readonly resourceId: string;
      readonly resourceEpoch: string;
      readonly sequence: number;
      readonly at: number;
      readonly data: string;
    }
  | {
      readonly kind: "status";
      readonly resourceId: string;
      readonly resourceEpoch: string;
      readonly sequence: number;
      readonly at: number;
      readonly status: Exclude<WorkbarTerminalStatus, "running">;
      readonly exitCode?: number | undefined;
      readonly signal?: string | undefined;
    };

export interface WorkbarTerminalAttachment extends WorkbarTerminalRecord {
  readonly events: readonly WorkbarTerminalEvent[];
  readonly truncated: boolean;
  readonly firstAvailableSequence: number;
}

export interface WorkbarTerminalStateStore {
  load(): Promise<readonly WorkbarTerminalRecord[]>;
  save(records: readonly WorkbarTerminalRecord[]): Promise<void>;
}

export interface WorkbarTerminalProcessExit {
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
}

export interface WorkbarTerminalProcess {
  readonly pid: number;
  readonly capability: WorkbarTerminalCapability;
  readonly resizeSupported: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> | void;
}

export interface WorkbarTerminalProcessFactory {
  readonly capability: WorkbarTerminalCapability;
  readonly unavailableReason?: string | undefined;
  spawn(
    input: {
      readonly shell: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly cols: number;
      readonly rows: number;
    },
    handlers: {
      readonly onData: (data: string) => void;
      readonly onExit: (exit: WorkbarTerminalProcessExit) => void;
    },
  ): Promise<WorkbarTerminalProcess>;
}

export interface WorkbarTerminalAuthorityOptions {
  readonly store: WorkbarTerminalStateStore;
  readonly processFactory?: WorkbarTerminalProcessFactory | undefined;
  readonly shell?: string | undefined;
  readonly shellArgs?: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly maxRunningPerSession?: number | undefined;
  readonly maxRunningTotal?: number | undefined;
  readonly maxRecords?: number | undefined;
  readonly maxRingBytes?: number | undefined;
  readonly maxRingEvents?: number | undefined;
  readonly maxInputBytes?: number | undefined;
  readonly maxOutputEventBytes?: number | undefined;
  readonly stopGraceMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly onEvent?:
    | ((event: WorkbarTerminalEvent, attachmentIds: readonly string[]) => void)
    | undefined;
}

export type WorkbarTerminalErrorCode =
  | "invalid_request"
  | "not_found"
  | "resource_epoch_mismatch"
  | "not_running"
  | "capacity_exceeded"
  | "admission_closed"
  | "spawn_failed";

export class WorkbarTerminalError extends Error {
  constructor(
    readonly code: WorkbarTerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkbarTerminalError";
  }
}

interface RuntimeResource {
  record: WorkbarTerminalRecord;
  readonly events: WorkbarTerminalEvent[];
  eventBytes: number;
  readonly attachments: Set<string>;
  process?: WorkbarTerminalProcess | undefined;
  exitPromise?: Promise<void> | undefined;
  resolveExit?: (() => void) | undefined;
  stopRequested: boolean;
}

const DEFAULT_MAX_RUNNING_PER_SESSION = 8;
const DEFAULT_MAX_RUNNING_TOTAL = 32;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_RING_BYTES = 1024 * 1024;
const DEFAULT_MAX_RING_EVENTS = 2_000;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_EVENT_BYTES = 64 * 1024;
const DEFAULT_STOP_GRACE_MS = 1_000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export class WorkbarTerminalAuthority {
  readonly processFactory: WorkbarTerminalProcessFactory;
  readonly processCapability: WorkbarTerminalCapability;
  readonly processUnavailableReason: string | undefined;
  readonly #resources = new Map<string, RuntimeResource>();
  readonly #options: Required<
    Pick<
      WorkbarTerminalAuthorityOptions,
      | "maxRunningPerSession"
      | "maxRunningTotal"
      | "maxRecords"
      | "maxRingBytes"
      | "maxRingEvents"
      | "maxInputBytes"
      | "maxOutputEventBytes"
      | "stopGraceMs"
      | "now"
    >
  > &
    WorkbarTerminalAuthorityOptions;
  readonly #pendingCreates = new Set<Promise<WorkbarTerminalAttachment>>();
  #persistQueue: Promise<void> = Promise.resolve();
  #stopAllPromise: Promise<number> | undefined;
  #acceptingCreates = true;

  constructor(options: WorkbarTerminalAuthorityOptions) {
    this.processFactory = options.processFactory ?? createPreferredWorkbarTerminalProcessFactory();
    this.processCapability = this.processFactory.capability;
    this.processUnavailableReason = this.processFactory.unavailableReason;
    this.#options = {
      ...options,
      maxRunningPerSession: positiveInteger(
        options.maxRunningPerSession ?? DEFAULT_MAX_RUNNING_PER_SESSION,
        "maxRunningPerSession",
      ),
      maxRunningTotal: positiveInteger(
        options.maxRunningTotal ?? DEFAULT_MAX_RUNNING_TOTAL,
        "maxRunningTotal",
      ),
      maxRecords: positiveInteger(options.maxRecords ?? DEFAULT_MAX_RECORDS, "maxRecords"),
      maxRingBytes: positiveInteger(options.maxRingBytes ?? DEFAULT_MAX_RING_BYTES, "maxRingBytes"),
      maxRingEvents: positiveInteger(
        options.maxRingEvents ?? DEFAULT_MAX_RING_EVENTS,
        "maxRingEvents",
      ),
      maxInputBytes: positiveInteger(
        options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
        "maxInputBytes",
      ),
      maxOutputEventBytes: positiveInteger(
        options.maxOutputEventBytes ?? DEFAULT_MAX_OUTPUT_EVENT_BYTES,
        "maxOutputEventBytes",
        4,
      ),
      stopGraceMs: positiveInteger(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS, "stopGraceMs"),
      now: options.now ?? Date.now,
    };
    if (this.#options.maxRunningPerSession > this.#options.maxRunningTotal) {
      throw new WorkbarTerminalError(
        "invalid_request",
        "maxRunningPerSession cannot exceed maxRunningTotal",
      );
    }
    if (this.#options.maxRunningTotal > this.#options.maxRecords) {
      throw new WorkbarTerminalError("invalid_request", "maxRunningTotal cannot exceed maxRecords");
    }
  }

  async recover(): Promise<void> {
    const records = await this.#options.store.load();
    const now = this.#options.now();
    for (const record of records.slice(-this.#options.maxRecords)) {
      if (!isValidRecord(record) || this.#resources.has(record.resourceId)) continue;
      const recovered =
        record.status === "running"
          ? {
              ...record,
              resourceEpoch: randomUUID(),
              status: "interrupted" as const,
              sequence: 1,
              updatedAt: now,
              pid: undefined,
              signal: "host_restart",
            }
          : record;
      const resource = emptyRuntimeResource(recovered);
      if (record.status === "running") {
        const event: WorkbarTerminalEvent = {
          kind: "status",
          resourceId: recovered.resourceId,
          resourceEpoch: recovered.resourceEpoch,
          sequence: recovered.sequence,
          at: now,
          status: "interrupted",
          signal: "host_restart",
        };
        resource.events.push(event);
        resource.eventBytes = eventBytes(event);
      }
      this.#resources.set(recovered.resourceId, resource);
    }
    await this.#persist();
  }

  create(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly cwd?: string | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
  }): Promise<WorkbarTerminalAttachment> {
    if (!this.#acceptingCreates) {
      return Promise.reject(
        new WorkbarTerminalError(
          "admission_closed",
          "Terminal generation is closed; reconnect the Desktop before creating a terminal",
        ),
      );
    }
    const creation = this.#create(input);
    this.#pendingCreates.add(creation);
    void creation.then(
      () => this.#pendingCreates.delete(creation),
      () => this.#pendingCreates.delete(creation),
    );
    return creation;
  }

  async #create(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly cwd?: string | undefined;
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
  }): Promise<WorkbarTerminalAttachment> {
    const owner = await normalizeOwner(input.workspacePath, input.sessionId);
    this.#assertCapacity(owner);
    const cwd = await normalizeCwd(owner.workspacePath, input.cwd);
    const cols = terminalDimension(input.cols ?? DEFAULT_COLS, "cols", 2, 500);
    const rows = terminalDimension(input.rows ?? DEFAULT_ROWS, "rows", 1, 300);
    const now = this.#options.now();
    const resourceId = randomUUID();
    const resourceEpoch = randomUUID();
    const shell = this.#options.shell ?? defaultShell();
    const shellArgs = this.#options.shellArgs ?? defaultShellArgs();
    const pendingEvents: Array<
      { kind: "data"; data: string } | { kind: "exit"; exit: WorkbarTerminalProcessExit }
    > = [];
    let installed = false;
    let terminalProcess: WorkbarTerminalProcess;
    try {
      terminalProcess = await this.processFactory.spawn(
        {
          shell,
          args: shellArgs,
          cwd,
          env: terminalEnvironment(this.#options.env),
          cols,
          rows,
        },
        {
          onData: (data) => {
            if (!installed) pendingEvents.push({ kind: "data", data });
            else this.#acceptOutput(resourceId, data);
          },
          onExit: (exit) => {
            if (!installed) pendingEvents.push({ kind: "exit", exit });
            else this.#acceptExit(resourceId, exit);
          },
        },
      );
    } catch (error) {
      throw new WorkbarTerminalError(
        "spawn_failed",
        error instanceof Error ? error.message : "Terminal process could not be started",
      );
    }
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const record: WorkbarTerminalRecord = {
      ...owner,
      resourceId,
      resourceEpoch,
      status: "running",
      capability: terminalProcess.capability,
      resizeSupported: terminalProcess.resizeSupported,
      cwd,
      shell,
      cols,
      rows,
      sequence: 0,
      createdAt: now,
      updatedAt: now,
      pid: terminalProcess.pid,
    };
    this.#resources.set(resourceId, {
      record,
      events: [],
      eventBytes: 0,
      attachments: new Set(),
      process: terminalProcess,
      exitPromise,
      resolveExit,
      stopRequested: false,
    });
    installed = true;
    for (const event of pendingEvents) {
      if (event.kind === "data") this.#acceptOutput(resourceId, event.data);
      else this.#acceptExit(resourceId, event.exit);
    }
    this.#pruneRecords();
    await this.#persist();
    return this.#attachment(this.#requireResource(resourceId), -1);
  }

  async list(owner: WorkbarTerminalOwner): Promise<readonly WorkbarTerminalRecord[]> {
    const { sessionId, workspacePath } = await normalizeOwner(owner.workspacePath, owner.sessionId);
    return [...this.#resources.values()]
      .map((resource) => resource.record)
      .filter((record) => record.workspacePath === workspacePath && record.sessionId === sessionId)
      .toSorted((left, right) => left.createdAt - right.createdAt);
  }

  attach(input: {
    readonly resourceId: string;
    readonly resourceEpoch: string;
    readonly attachmentId: string;
    readonly afterSequence?: number | undefined;
  }): WorkbarTerminalAttachment {
    const resource = this.#requireResource(input.resourceId, input.resourceEpoch);
    resource.attachments.add(nonEmpty(input.attachmentId, "attachmentId"));
    return this.#attachment(resource, input.afterSequence ?? -1);
  }

  detach(input: { readonly resourceId: string; readonly attachmentId: string }): void {
    const resource = this.#requireResource(input.resourceId);
    resource.attachments.delete(nonEmpty(input.attachmentId, "attachmentId"));
  }

  detachAttachment(attachmentId: string): void {
    const normalized = nonEmpty(attachmentId, "attachmentId");
    for (const resource of this.#resources.values()) resource.attachments.delete(normalized);
  }

  input(input: {
    readonly resourceId: string;
    readonly resourceEpoch: string;
    readonly data: string;
  }): void {
    const resource = this.#requireRunning(input.resourceId, input.resourceEpoch);
    if (
      typeof input.data !== "string" ||
      Buffer.byteLength(input.data) > this.#options.maxInputBytes
    ) {
      throw new WorkbarTerminalError(
        "invalid_request",
        `Terminal input exceeds ${this.#options.maxInputBytes} bytes`,
      );
    }
    resource.process?.write(input.data);
  }

  async resize(input: {
    readonly resourceId: string;
    readonly resourceEpoch: string;
    readonly cols: number;
    readonly rows: number;
  }): Promise<WorkbarTerminalRecord> {
    const resource = this.#requireRunning(input.resourceId, input.resourceEpoch);
    const cols = terminalDimension(input.cols, "cols", 2, 500);
    const rows = terminalDimension(input.rows, "rows", 1, 300);
    if (!resource.record.resizeSupported) {
      throw new WorkbarTerminalError("invalid_request", "Terminal backend does not support resize");
    }
    resource.process?.resize(cols, rows);
    resource.record = { ...resource.record, cols, rows, updatedAt: this.#options.now() };
    await this.#persist();
    return resource.record;
  }

  async stop(input: {
    readonly resourceId: string;
    readonly resourceEpoch: string;
  }): Promise<WorkbarTerminalRecord> {
    const resource = this.#requireResource(input.resourceId, input.resourceEpoch);
    if (resource.record.status !== "running") return resource.record;
    if (!resource.stopRequested) {
      resource.stopRequested = true;
      await resource.process?.terminate("SIGTERM");
    }
    const exited = await Promise.race([
      resource.exitPromise?.then(() => true) ?? Promise.resolve(true),
      delay(this.#options.stopGraceMs).then(() => false),
    ]);
    if (!exited && resource.record.status === "running") {
      await resource.process?.terminate("SIGKILL");
      await Promise.race([
        resource.exitPromise ?? Promise.resolve(),
        delay(this.#options.stopGraceMs),
      ]);
    }
    if (resource.record.status === "running") {
      this.#settle(resource, { status: "stopped", signal: "SIGKILL" });
    }
    await this.#persist();
    return resource.record;
  }

  /** Stops every live Workbar process owned by this authority before its UI owner disappears. */
  stopAll(): Promise<number> {
    this.#acceptingCreates = false;
    if (this.#stopAllPromise) return this.#stopAllPromise;
    const operation = this.#stopAllOnce();
    const lifecycle = operation.finally(() => {
      if (this.#stopAllPromise === lifecycle) this.#stopAllPromise = undefined;
    });
    this.#stopAllPromise = lifecycle;
    return lifecycle;
  }

  resumeCreates(): void {
    if (this.#stopAllPromise) {
      throw new WorkbarTerminalError("admission_closed", "Terminal cleanup is still in progress");
    }
    this.#acceptingCreates = true;
  }

  async #stopAllOnce(): Promise<number> {
    await Promise.allSettled([...this.#pendingCreates]);
    const running = [...this.#resources.values()].filter(
      (resource) => resource.record.status === "running",
    );
    const outcomes = await Promise.allSettled(
      running.map((resource) =>
        this.stop({
          resourceId: resource.record.resourceId,
          resourceEpoch: resource.record.resourceEpoch,
        }),
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Workbar terminal cleanup failed");
    }
    return running.length;
  }

  async close(): Promise<void> {
    await this.stopAll();
    await this.idle();
  }

  idle(): Promise<void> {
    return this.#persistQueue;
  }

  #assertCapacity(owner: WorkbarTerminalOwner): void {
    const running = [...this.#resources.values()].filter(
      (resource) => resource.record.status === "running",
    );
    if (running.length >= this.#options.maxRunningTotal) {
      throw new WorkbarTerminalError("capacity_exceeded", "Terminal capacity is exhausted");
    }
    const sessionCount = running.filter(
      (resource) =>
        resource.record.workspacePath === owner.workspacePath &&
        resource.record.sessionId === owner.sessionId,
    ).length;
    if (sessionCount >= this.#options.maxRunningPerSession) {
      throw new WorkbarTerminalError("capacity_exceeded", "Session terminal capacity is exhausted");
    }
  }

  #acceptOutput(resourceId: string, data: string): void {
    const resource = this.#resources.get(resourceId);
    if (!resource || resource.record.status !== "running" || !data) return;
    for (const part of splitUtf8(data, this.#options.maxOutputEventBytes)) {
      const event: WorkbarTerminalEvent = {
        kind: "output",
        resourceId,
        resourceEpoch: resource.record.resourceEpoch,
        sequence: resource.record.sequence + 1,
        at: this.#options.now(),
        data: part,
      };
      resource.record = {
        ...resource.record,
        sequence: event.sequence,
        updatedAt: event.at,
      };
      this.#appendEvent(resource, event);
    }
  }

  #acceptExit(resourceId: string, exit: WorkbarTerminalProcessExit): void {
    const resource = this.#resources.get(resourceId);
    if (!resource || resource.record.status !== "running") return;
    this.#settle(resource, {
      status: resource.stopRequested ? "stopped" : "exited",
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
    });
    void this.#persist();
  }

  #settle(
    resource: RuntimeResource,
    outcome: {
      readonly status: "exited" | "stopped" | "interrupted";
      readonly exitCode?: number | undefined;
      readonly signal?: string | undefined;
    },
  ): void {
    const now = this.#options.now();
    const event: WorkbarTerminalEvent = {
      kind: "status",
      resourceId: resource.record.resourceId,
      resourceEpoch: resource.record.resourceEpoch,
      sequence: resource.record.sequence + 1,
      at: now,
      status: outcome.status,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
    };
    resource.record = {
      ...resource.record,
      status: outcome.status,
      sequence: event.sequence,
      updatedAt: now,
      pid: undefined,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
    };
    resource.process = undefined;
    this.#appendEvent(resource, event);
    resource.resolveExit?.();
    resource.resolveExit = undefined;
  }

  #appendEvent(resource: RuntimeResource, event: WorkbarTerminalEvent): void {
    const bytes = eventBytes(event);
    resource.events.push(event);
    resource.eventBytes += bytes;
    while (
      resource.events.length > this.#options.maxRingEvents ||
      resource.eventBytes > this.#options.maxRingBytes
    ) {
      const removed = resource.events.shift();
      if (!removed) break;
      resource.eventBytes -= eventBytes(removed);
    }
    this.#options.onEvent?.(event, [...resource.attachments]);
  }

  #attachment(resource: RuntimeResource, afterSequence: number): WorkbarTerminalAttachment {
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      throw new WorkbarTerminalError("invalid_request", "afterSequence must be an integer >= -1");
    }
    const firstAvailableSequence = resource.events[0]?.sequence ?? resource.record.sequence + 1;
    const truncated = resource.record.sequence > 0 && afterSequence < firstAvailableSequence - 1;
    return {
      ...resource.record,
      events: resource.events.filter((event) => event.sequence > afterSequence),
      truncated,
      firstAvailableSequence,
    };
  }

  #requireRunning(resourceId: string, resourceEpoch: string): RuntimeResource {
    const resource = this.#requireResource(resourceId, resourceEpoch);
    if (resource.record.status !== "running") {
      throw new WorkbarTerminalError("not_running", "Terminal resource is not running");
    }
    return resource;
  }

  #requireResource(resourceId: string, resourceEpoch?: string): RuntimeResource {
    const normalizedId = nonEmpty(resourceId, "resourceId");
    const resource = this.#resources.get(normalizedId);
    if (!resource) throw new WorkbarTerminalError("not_found", "Terminal resource was not found");
    if (resourceEpoch !== undefined && resource.record.resourceEpoch !== resourceEpoch) {
      throw new WorkbarTerminalError("resource_epoch_mismatch", "Terminal resource epoch is stale");
    }
    return resource;
  }

  #pruneRecords(): void {
    if (this.#resources.size <= this.#options.maxRecords) return;
    const terminal = [...this.#resources.values()]
      .filter((resource) => resource.record.status !== "running")
      .toSorted((left, right) => left.record.updatedAt - right.record.updatedAt);
    for (const resource of terminal) {
      if (this.#resources.size <= this.#options.maxRecords) break;
      this.#resources.delete(resource.record.resourceId);
    }
  }

  #persist(): Promise<void> {
    const records = [...this.#resources.values()].map((resource) => resource.record);
    this.#persistQueue = this.#persistQueue.then(() => this.#options.store.save(records));
    void this.#persistQueue.catch(() => undefined);
    return this.#persistQueue;
  }
}

export function createPreferredWorkbarTerminalProcessFactory(): WorkbarTerminalProcessFactory {
  try {
    const require = createRequire(import.meta.url);
    ensureNodePtySpawnHelperExecutable(require);
    const nodePty = require("node-pty") as NodePtyModule;
    if (typeof nodePty.spawn !== "function")
      throw new Error("node-pty spawn export is unavailable");
    return new NodePtyProcessFactory(nodePty);
  } catch (error) {
    return new ChildProcessFallbackFactory(
      error instanceof Error ? error.message : "node-pty could not be loaded",
    );
  }
}

function ensureNodePtySpawnHelperExecutable(require: NodeJS.Require): void {
  if (process.platform === "win32") return;
  try {
    const packageRoot = dirname(require.resolve("node-pty/package.json"));
    for (const helper of [
      join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(packageRoot, "build", "Release", "spawn-helper"),
    ]) {
      try {
        chmodSync(helper, 0o755);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch {
    // The packaged copy is prepared at build time. A read-only installation
    // may reject chmod even though the helper already has the correct mode.
  }
}

export function createChildProcessWorkbarTerminalFallback(
  unavailableReason = "node-pty was not selected",
): WorkbarTerminalProcessFactory {
  return new ChildProcessFallbackFactory(unavailableReason);
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): {
    readonly pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  };
}

class NodePtyProcessFactory implements WorkbarTerminalProcessFactory {
  readonly capability = "pty" as const;

  constructor(private readonly nodePty: NodePtyModule) {}

  async spawn(
    input: Parameters<WorkbarTerminalProcessFactory["spawn"]>[0],
    handlers: Parameters<WorkbarTerminalProcessFactory["spawn"]>[1],
  ): Promise<WorkbarTerminalProcess> {
    const pty = this.nodePty.spawn(input.shell, input.args, {
      name: input.env.TERM ?? "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: stringEnvironment(input.env),
    });
    pty.onData(handlers.onData);
    pty.onExit((event) =>
      handlers.onExit({
        exitCode: event.exitCode,
        ...(event.signal !== undefined ? { signal: String(event.signal) } : {}),
      }),
    );
    return {
      pid: pty.pid,
      capability: "pty",
      resizeSupported: true,
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      terminate: async (signal) => {
        if (process.platform !== "win32") {
          try {
            process.kill(-pty.pid, signal);
            return;
          } catch {
            // node-pty remains the fallback when the child is not a process-group leader.
          }
        }
        pty.kill(signal);
      },
    };
  }
}

class ChildProcessFallbackFactory implements WorkbarTerminalProcessFactory {
  readonly capability = "pipe" as const;

  constructor(readonly unavailableReason: string) {}

  async spawn(
    input: Parameters<WorkbarTerminalProcessFactory["spawn"]>[0],
    handlers: Parameters<WorkbarTerminalProcessFactory["spawn"]>[1],
  ): Promise<WorkbarTerminalProcess> {
    const child = spawnChild(input.shell, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer | string) => handlers.onData(data.toString()));
    child.stderr?.on("data", (data: Buffer | string) => handlers.onData(data.toString()));
    child.once("exit", (exitCode, signal) =>
      handlers.onExit({
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal !== null ? { signal } : {}),
      }),
    );
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Terminal child process did not expose a pid");
    return {
      pid: child.pid,
      capability: "pipe",
      resizeSupported: false,
      write: (data) => child.stdin?.write(data),
      resize: () => {
        throw new WorkbarTerminalError("invalid_request", "Pipe fallback cannot resize");
      },
      terminate: (signal) => terminateProcessGroup(child.pid!, signal),
    };
  }
}

function terminateProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> | void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  return new Promise((resolvePromise, reject) => {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ESRCH") reject(error);
      else resolvePromise();
    });
  });
}

function emptyRuntimeResource(record: WorkbarTerminalRecord): RuntimeResource {
  return {
    record,
    events: [],
    eventBytes: 0,
    attachments: new Set(),
    stopRequested: false,
  };
}

async function normalizeOwner(
  workspacePath: string,
  sessionId: string,
): Promise<WorkbarTerminalOwner> {
  let canonical: string;
  try {
    canonical = await realpath(nonEmpty(workspacePath, "workspacePath"));
  } catch {
    throw new WorkbarTerminalError("invalid_request", "Workspace path does not exist");
  }
  return { workspacePath: canonical, sessionId: nonEmpty(sessionId, "sessionId") };
}

async function normalizeCwd(workspaceRoot: string, cwd: string | undefined): Promise<string> {
  const candidate = cwd ? (isAbsolute(cwd) ? cwd : resolve(workspaceRoot, cwd)) : workspaceRoot;
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new WorkbarTerminalError("invalid_request", "Terminal cwd does not exist");
  }
  if (!isWithin(workspaceRoot, canonical)) {
    throw new WorkbarTerminalError("invalid_request", "Terminal cwd escapes the workspace");
  }
  return canonical;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function terminalEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    TERM: overrides?.TERM ?? process.env.TERM ?? "xterm-256color",
  };
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

function defaultShellArgs(): readonly string[] {
  return process.platform === "win32" ? [] : ["-l"];
}

function terminalDimension(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkbarTerminalError(
      "invalid_request",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function positiveInteger(value: number, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new WorkbarTerminalError(
      "invalid_request",
      `${field} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkbarTerminalError("invalid_request", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maximumBytes) return [value];
  const parts: string[] = [];
  let part = "";
  let partBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (part && partBytes + characterBytes > maximumBytes) {
      parts.push(part);
      part = "";
      partBytes = 0;
    }
    part += character;
    partBytes += characterBytes;
  }
  if (part) parts.push(part);
  return parts;
}

function eventBytes(event: WorkbarTerminalEvent): number {
  return event.kind === "output" ? Buffer.byteLength(event.data) : 64;
}

function isValidRecord(value: WorkbarTerminalRecord): boolean {
  return (
    typeof value.resourceId === "string" &&
    value.resourceId.length > 0 &&
    typeof value.resourceEpoch === "string" &&
    value.resourceEpoch.length > 0 &&
    typeof value.workspacePath === "string" &&
    value.workspacePath.length > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    ["running", "exited", "stopped", "interrupted"].includes(value.status) &&
    ["pty", "pipe"].includes(value.capability) &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  );
}
