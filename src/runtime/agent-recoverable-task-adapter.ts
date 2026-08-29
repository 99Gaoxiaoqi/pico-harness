import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import { RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION } from "../tasks/task-run-contract.js";
import {
  deriveRecoverableTaskRuntimeLaunchIdentity,
  type RecoverableTaskAdapter,
  type RecoverableTaskResumeContext,
} from "../tasks/recoverable-task.js";
import {
  FileStorageIntegrityError,
  mkdirPrivateSync,
  readJsonFileSync,
  withFileLock,
  writeJsonAtomicSync,
} from "../storage/local-file-storage.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeRunStartedEvent,
} from "../storage/runtime-event.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type { EngineRuntimeWriteGuard } from "../engine/runtime-port.js";
import {
  assertWorkspaceSqliteStorageRootIdentitySync,
  readWorkspaceSqliteStorageRootIdentitySync,
  type WorkspaceStorageRootIdentity,
} from "../storage/sqlite/sqlite-workspace-storage.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../storage/sqlite/workspace-scopes.js";

export const AGENT_RECOVERABLE_TASK_ADAPTER_ID = "pico.core-agent";
export const AGENT_RECOVERABLE_TASK_ADAPTER_VERSION = 1 as const;
export const AGENT_RECOVERABLE_TASK_INPUT_SCHEMA_VERSION = 1 as const;
export const AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION = 1 as const;
export const AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION = 1 as const;

const INTENT_DIRECTORY_NAME = "agent-recovery-launch-intents";
const INTENT_FILE_NAME = "intent.json";
const INTENT_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Immutable, secret-free identity needed to rebuild one core Agent execution.
 *
 * Provider keys, credential values and prompts deliberately do not belong here. The
 * host resolves current credentials at its own trust boundary and resumes the
 * canonical Session history without committing another user message.
 */
export type AgentRecoverableTaskInput = Readonly<{
  schemaVersion: typeof AGENT_RECOVERABLE_TASK_INPUT_SCHEMA_VERSION;
  taskRunId: string;
  executionId: string;
  workspacePath: string;
  storageRootId: string;
  sessionId: string;
}>;

export interface CreateAgentRecoverableTaskInputOptions {
  readonly taskRunId: string;
  readonly executionId: string;
  readonly workspacePath: string;
  readonly storageRootId: string;
  readonly sessionId: string;
}

/**
 * Durable worker intent. `resumeExistingSession` is a literal safety instruction,
 * not a caller option: the worker must never synthesize a continuation prompt.
 */
export type AgentRecoveryLaunchIntent = Readonly<{
  schemaVersion: typeof AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION;
  launchId: string;
  taskRunId: string;
  executionId: string;
  sourceAttemptId: string;
  attemptId: string;
  attemptNumber: number;
  workspacePath: string;
  storageRootId: string;
  sessionId: string;
  sourceRunId: string;
  sourceEventHighWater: number;
  checkpointRef: string;
  runId: string;
  invocationId: string;
  runStartedEventId: string;
  runStartedSequence: number;
  runStartedAt: string;
  resumeExistingSession: true;
}>;

/** Stable proof returned by the host's durable worker scheduler. */
export type AgentRecoveryWorkerReceipt = Readonly<{
  schemaVersion: typeof AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION;
  launchId: string;
  workerId: string;
}>;

export type AgentRecoveryWorkerTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentRecoveryWorkerTerminal {
  readonly launchId: string;
  readonly workerId: string;
  readonly status: AgentRecoveryWorkerTerminalStatus;
  readonly terminalEventId?: string;
  readonly at?: string;
}

/**
 * The host owns actual cold reconstruction. It must durably install-or-confirm by
 * launchId, rebuild the SessionRuntime for intent.sessionId, and execute the
 * prestarted run with resumeExistingSession=true. Returning from this method means
 * the worker installation itself is durable; it does not mean the Agent run finished.
 */
export interface AgentRecoveryWorkerInstaller {
  installOrConfirmWorker(
    intent: AgentRecoveryLaunchIntent,
  ): AgentRecoveryWorkerReceipt | Promise<AgentRecoveryWorkerReceipt>;
}

export interface AgentRecoveryLaunchIntentPort {
  installOrConfirm(intent: AgentRecoveryLaunchIntent): Promise<AgentRecoveryWorkerReceipt>;
  markTerminal(terminal: AgentRecoveryWorkerTerminal): Promise<void>;
}

export type AgentRecoveryLaunchIntentProjection =
  | AgentRecoveryPreparedIntent
  | AgentRecoveryInstallingIntent
  | AgentRecoveryInstalledIntent
  | AgentRecoveryTerminalIntent;

interface AgentRecoveryIntentBase {
  readonly type: "agent-recovery-launch-intent";
  readonly schemaVersion: typeof AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION;
  readonly intent: AgentRecoveryLaunchIntent;
  readonly preparedAt: string;
  readonly claimEpoch: number;
}

interface AgentRecoveryPreparedIntent extends AgentRecoveryIntentBase {
  readonly state: "prepared";
}

interface AgentRecoveryInstallingIntent extends AgentRecoveryIntentBase {
  readonly state: "installing";
  readonly claimId: string;
  readonly ownerId: string;
  readonly claimedAt: string;
  readonly claimExpiresAt: string;
}

interface AgentRecoveryInstalledIntent extends AgentRecoveryIntentBase {
  readonly state: "installed";
  readonly worker: AgentRecoveryWorkerReceipt;
  readonly installedAt: string;
}

interface AgentRecoveryTerminalIntent extends AgentRecoveryIntentBase {
  readonly state: "terminal";
  readonly worker: AgentRecoveryWorkerReceipt;
  readonly installedAt: string;
  readonly terminal: Readonly<{
    status: AgentRecoveryWorkerTerminalStatus;
    terminalEventId?: string;
    at: string;
  }>;
}

export interface FileAgentRecoveryLaunchIntentPortOptions {
  readonly storageRoot: string;
  readonly storageRootId: string;
  readonly installer: AgentRecoveryWorkerInstaller;
  readonly ownerId?: string;
  readonly claimTtlMs?: number;
  readonly contentionTimeoutMs?: number;
  readonly contentionPollMs?: number;
  readonly now?: () => Date;
}

/**
 * File-backed cross-process claim and worker-intent store.
 *
 * The per-launch state machine is:
 * prepared -> installing(epoch/lease) -> installed -> terminal.
 *
 * A failed installer call returns the caller's still-owned claim to prepared. If
 * the process dies, a later process takes over the expired installing lease and
 * calls the host's idempotent install-or-confirm operation with the same launchId.
 */
export class FileAgentRecoveryLaunchIntentPort implements AgentRecoveryLaunchIntentPort {
  readonly storageRoot: string;
  readonly storageRootId: string;
  private readonly rootIdentity: WorkspaceStorageRootIdentity;
  private readonly intentsRoot: string;
  private readonly ownerId: string;
  private readonly claimTtlMs: number;
  private readonly contentionTimeoutMs: number;
  private readonly contentionPollMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: FileAgentRecoveryLaunchIntentPortOptions) {
    if (!options.storageRootId.trim()) {
      throw new Error("Agent recovery launch-intent storageRootId must not be empty");
    }
    const rootIdentity = readWorkspaceSqliteStorageRootIdentitySync(
      options.storageRoot,
      ALL_WORKSPACE_SQLITE_SCOPES,
    );
    if (!rootIdentity) {
      throw new Error(
        `Agent recovery launch-intent storage root is not initialized: ${options.storageRoot}`,
      );
    }
    if (rootIdentity.storageRootId !== options.storageRootId) {
      throw new Error(
        `Agent recovery launch-intent storage root mismatch: expected ${options.storageRootId}, got ${rootIdentity.storageRootId}`,
      );
    }
    this.rootIdentity = rootIdentity;
    this.storageRoot = rootIdentity.canonicalPath;
    this.storageRootId = rootIdentity.storageRootId;
    // SQLite 纪元:claim 文件不得落在 legacy marker 目录(control/ 会触发旧纪元
    // fail-closed 门禁),与 memory/、evidence/ 同级的并存目录。
    this.intentsRoot = join(this.storageRoot, INTENT_DIRECTORY_NAME);
    this.ownerId =
      options.ownerId?.trim() || `agent-recovery-intent:${process.pid}:${randomUUID()}`;
    this.claimTtlMs = positiveDuration(options.claimTtlMs ?? 30_000, "claimTtlMs");
    this.contentionTimeoutMs = nonNegativeDuration(
      options.contentionTimeoutMs ?? this.claimTtlMs,
      "contentionTimeoutMs",
    );
    this.contentionPollMs = positiveDuration(options.contentionPollMs ?? 25, "contentionPollMs");
    this.now = options.now ?? (() => new Date());
    ensurePrivateIntentDirectorySync(this.intentsRoot);
  }

  async installOrConfirm(
    requestedIntent: AgentRecoveryLaunchIntent,
  ): Promise<AgentRecoveryWorkerReceipt> {
    const intent = decodeAgentRecoveryLaunchIntent(requestedIntent);
    if (intent.storageRootId !== this.storageRootId) {
      throw new Error(`Agent recovery launch ${intent.launchId} belongs to another storage root`);
    }
    const deadline = this.now().getTime() + this.contentionTimeoutMs;
    for (;;) {
      const claim = await this.claimInstall(intent);
      if (claim.status === "settled") return claim.worker;
      if (claim.status === "waiting") {
        if (this.now().getTime() >= deadline) {
          throw new Error(
            `Agent recovery launch ${intent.launchId} is still installing under another live claim`,
          );
        }
        await delay(this.contentionPollMs);
        continue;
      }

      let worker: AgentRecoveryWorkerReceipt;
      try {
        worker = decodeAgentRecoveryWorkerReceipt(
          await this.options.installer.installOrConfirmWorker(intent),
        );
        if (worker.launchId !== intent.launchId) {
          throw new Error(
            `Agent recovery worker receipt belongs to ${worker.launchId}, expected ${intent.launchId}`,
          );
        }
      } catch (error) {
        await this.releaseFailedClaim(intent, claim);
        throw error;
      }
      return this.settleInstalled(intent, claim, worker);
    }
  }

  async markTerminal(input: AgentRecoveryWorkerTerminal): Promise<void> {
    const terminal = decodeAgentRecoveryWorkerTerminal(input, this.now);
    await this.withIntentLock(terminal.launchId, async () => {
      const current = this.readProjection(terminal.launchId);
      if (!current) {
        throw new Error(`Agent recovery launch ${terminal.launchId} has no durable intent`);
      }
      if (current.state === "prepared") {
        throw new Error(
          `Agent recovery launch ${terminal.launchId} cannot become terminal from ${current.state}`,
        );
      }
      const requestedTerminal = {
        status: terminal.status,
        ...(terminal.terminalEventId ? { terminalEventId: terminal.terminalEventId } : {}),
        at: terminal.at,
      } as const;
      if (current.state === "terminal") {
        if (current.worker.workerId !== terminal.workerId) {
          throw new Error(`Agent recovery launch ${terminal.launchId} worker identity changed`);
        }
        if (!isDeepStrictEqual(current.terminal, requestedTerminal)) {
          throw new Error(
            `Agent recovery launch ${terminal.launchId} is already bound to another terminal result`,
          );
        }
        return;
      }
      const worker: AgentRecoveryWorkerReceipt =
        current.state === "installing"
          ? {
              schemaVersion: AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION,
              launchId: terminal.launchId,
              workerId: terminal.workerId,
            }
          : current.worker;
      if (worker.workerId !== terminal.workerId) {
        throw new Error(`Agent recovery launch ${terminal.launchId} worker identity changed`);
      }
      if (current.state === "installing") {
        this.writeProjection({
          type: "agent-recovery-launch-intent",
          schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
          intent: current.intent,
          preparedAt: current.preparedAt,
          claimEpoch: current.claimEpoch,
          state: "terminal",
          worker,
          installedAt: terminal.at,
          terminal: requestedTerminal,
        });
        return;
      }
      this.writeProjection({
        ...current,
        state: "terminal",
        terminal: requestedTerminal,
      });
    });
  }

  async inspect(launchId: string): Promise<AgentRecoveryLaunchIntentProjection | undefined> {
    assertIdentifier(launchId, "launchId");
    return this.withIntentLock(launchId, async () => {
      const projection = this.readProjection(launchId);
      return projection ? structuredClone(projection) : undefined;
    });
  }

  private async claimInstall(intent: AgentRecoveryLaunchIntent): Promise<
    | {
        readonly status: "claimed";
        readonly claimId: string;
        readonly claimEpoch: number;
      }
    | { readonly status: "waiting" }
    | { readonly status: "settled"; readonly worker: AgentRecoveryWorkerReceipt }
  > {
    return this.withIntentLock(intent.launchId, async () => {
      const atDate = this.now();
      const at = canonicalTimestamp(atDate, "claim time");
      let current = this.readProjection(intent.launchId);
      if (!current) {
        current = {
          type: "agent-recovery-launch-intent",
          schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
          intent,
          preparedAt: intent.runStartedAt,
          claimEpoch: 0,
          state: "prepared",
        };
        this.writeProjection(current);
      } else if (!isDeepStrictEqual(current.intent, intent)) {
        throw new Error(
          `Agent recovery launchId ${intent.launchId} is already bound to conflicting immutable input`,
        );
      }

      if (current.state === "installed" || current.state === "terminal") {
        return { status: "settled", worker: current.worker };
      }
      if (current.state === "installing" && current.claimExpiresAt > at) {
        return { status: "waiting" };
      }

      const claimEpoch = current.claimEpoch + 1;
      const claimId = `agent-recovery-install:${intent.launchId}:${claimEpoch}:${randomUUID()}`;
      const installing: AgentRecoveryInstallingIntent = {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt: current.preparedAt,
        claimEpoch,
        state: "installing",
        claimId,
        ownerId: this.ownerId,
        claimedAt: at,
        claimExpiresAt: new Date(atDate.getTime() + this.claimTtlMs).toISOString(),
      };
      this.writeProjection(installing);
      return { status: "claimed", claimId, claimEpoch };
    });
  }

  private async releaseFailedClaim(
    intent: AgentRecoveryLaunchIntent,
    claim: { readonly claimId: string; readonly claimEpoch: number },
  ): Promise<void> {
    await this.withIntentLock(intent.launchId, async () => {
      const current = this.readProjection(intent.launchId);
      if (
        current?.state !== "installing" ||
        current.claimId !== claim.claimId ||
        current.claimEpoch !== claim.claimEpoch
      ) {
        return;
      }
      this.writeProjection({
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt: current.preparedAt,
        claimEpoch: current.claimEpoch,
        state: "prepared",
      });
    });
  }

  private async settleInstalled(
    intent: AgentRecoveryLaunchIntent,
    claim: { readonly claimId: string; readonly claimEpoch: number },
    worker: AgentRecoveryWorkerReceipt,
  ): Promise<AgentRecoveryWorkerReceipt> {
    return this.withIntentLock(intent.launchId, async () => {
      const current = this.readProjection(intent.launchId);
      if (current?.state === "installed" || current?.state === "terminal") {
        if (!isDeepStrictEqual(current.worker, worker)) {
          throw new Error(
            `Agent recovery launch ${intent.launchId} was installed with another worker`,
          );
        }
        return current.worker;
      }
      if (!current) {
        throw new Error(
          `Agent recovery launch ${intent.launchId} install claim was lost before settlement`,
        );
      }
      const ownsCurrentClaim =
        current.state === "installing" &&
        current.claimId === claim.claimId &&
        current.claimEpoch === claim.claimEpoch;
      // The claim fences admission to the external installer, not settlement of
      // the durable receipt it returned. A newer epoch may adopt that proof.
      if (!ownsCurrentClaim && current.claimEpoch <= claim.claimEpoch) {
        throw new Error(
          `Agent recovery launch ${intent.launchId} install claim was lost before settlement`,
        );
      }
      const installed: AgentRecoveryInstalledIntent = {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt: current.preparedAt,
        claimEpoch: current.claimEpoch,
        state: "installed",
        worker,
        installedAt: canonicalTimestamp(this.now(), "installedAt"),
      };
      this.writeProjection(installed);
      return installed.worker;
    });
  }

  private async withIntentLock<Result>(
    launchId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const digest = launchIntentDigest(launchId);
    this.assertStorageBoundary(digest);
    return withFileLock(
      join(this.intentDirectory(digest), "lock"),
      `${this.ownerId}:${digest}`,
      async () => {
        this.assertStorageBoundary(digest);
        return operation();
      },
    );
  }

  private readProjection(launchId: string): AgentRecoveryLaunchIntentProjection | undefined {
    const path = this.intentFilePath(launchIntentDigest(launchId));
    return existsSync(path)
      ? decodeAgentRecoveryLaunchIntentProjection(readJsonFileSync(path), path)
      : undefined;
  }

  private writeProjection(projection: AgentRecoveryLaunchIntentProjection): void {
    const canonical = decodeAgentRecoveryLaunchIntentProjection(
      projection,
      `launch intent ${projection.intent.launchId}`,
    );
    writeJsonAtomicSync(
      this.intentFilePath(launchIntentDigest(canonical.intent.launchId)),
      canonical,
    );
  }

  private assertStorageBoundary(digest: string): void {
    if (!INTENT_DIRECTORY_PATTERN.test(digest)) {
      throw new Error(`Agent recovery launch-intent digest is invalid: ${digest}`);
    }
    assertWorkspaceSqliteStorageRootIdentitySync(
      this.storageRoot,
      this.rootIdentity,
      ALL_WORKSPACE_SQLITE_SCOPES,
    );
    ensurePrivateIntentDirectorySync(this.intentsRoot);
    ensurePrivateIntentDirectorySync(this.intentDirectory(digest));
  }

  private intentDirectory(digest: string): string {
    return join(this.intentsRoot, digest);
  }

  private intentFilePath(digest: string): string {
    return join(this.intentDirectory(digest), INTENT_FILE_NAME);
  }
}

export interface CreateAgentRecoverableTaskAdapterOptions {
  readonly workspacePath: string;
  readonly storageRootId: string;
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly runtimeWriteGuard: EngineRuntimeWriteGuard;
  readonly launchIntents: AgentRecoveryLaunchIntentPort;
}

export function createAgentRecoverableTaskInput(
  options: CreateAgentRecoverableTaskInputOptions,
): AgentRecoverableTaskInput {
  return decodeAgentRecoverableTaskInput({
    schemaVersion: AGENT_RECOVERABLE_TASK_INPUT_SCHEMA_VERSION,
    taskRunId: options.taskRunId,
    executionId: options.executionId,
    workspacePath: canonicalizeWorkspacePath(options.workspacePath),
    storageRootId: options.storageRootId,
    sessionId: options.sessionId,
  });
}

/** Production-registerable core Agent adapter. */
export function createAgentRecoverableTaskAdapter(
  options: CreateAgentRecoverableTaskAdapterOptions,
): RecoverableTaskAdapter {
  const workspacePath = canonicalizeWorkspacePath(options.workspacePath);
  assertIdentifier(options.storageRootId, "storageRootId");
  const storageIdentity = readWorkspaceSqliteStorageRootIdentitySync(
    options.runtimeEventStore.storageRoot,
    ALL_WORKSPACE_SQLITE_SCOPES,
  );
  if (!storageIdentity) {
    throw new Error(
      `Agent recoverable adapter storage root is not initialized: ${options.runtimeEventStore.storageRoot}`,
    );
  }
  if (storageIdentity.storageRootId !== options.storageRootId) {
    throw new Error(
      `Agent recoverable adapter storage root mismatch: expected ${options.storageRootId}, got ${storageIdentity.storageRootId}`,
    );
  }
  const validateBoundInput = (
    raw: Readonly<Record<string, unknown>>,
  ): AgentRecoverableTaskInput => {
    const input = decodeAgentRecoverableTaskInput(raw);
    if (input.workspacePath !== workspacePath || input.storageRootId !== options.storageRootId) {
      throw new Error("Agent recoverable task input belongs to another workspace");
    }
    return input;
  };

  const adapter: RecoverableTaskAdapter = {
    adapterId: AGENT_RECOVERABLE_TASK_ADAPTER_ID,
    version: AGENT_RECOVERABLE_TASK_ADAPTER_VERSION,
    launchMode: "idempotent",
    validateInput(input) {
      validateBoundInput(input);
    },
    async resume(raw, context) {
      const input = validateBoundInput(raw);
      assertResumeContext(input, context, workspacePath);
      const admission = await admitSuccessorRuntimeRun(
        options.runtimeEventStore,
        options.runtimeWriteGuard,
        input,
        context,
      );
      const intent: AgentRecoveryLaunchIntent = Object.freeze({
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        launchId: context.launchId,
        taskRunId: context.taskRunId,
        executionId: input.executionId,
        sourceAttemptId: context.sourceAttemptId,
        attemptId: context.attemptId,
        attemptNumber: context.attemptNumber,
        workspacePath,
        storageRootId: input.storageRootId,
        sessionId: input.sessionId,
        sourceRunId: context.boundary.runtime!.runId,
        sourceEventHighWater: context.expectedSessionHighWater,
        checkpointRef: context.checkpointRef,
        runId: context.expectedRuntimeRunId,
        invocationId: admission.invocationId,
        runStartedEventId: context.expectedRunStartedEventId,
        runStartedSequence: admission.sequence,
        runStartedAt: admission.at,
        resumeExistingSession: true,
      });
      await options.launchIntents.installOrConfirm(intent);
      return Object.freeze({
        schemaVersion: RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
        launchId: context.launchId,
        sessionId: input.sessionId,
        runId: context.expectedRuntimeRunId,
        runStartedEventId: context.expectedRunStartedEventId,
        runStartedSequence: admission.sequence,
      });
    },
  };
  return Object.freeze(adapter);
}

/** Maps a durable intent onto RuntimeRunExecutor's prestarted-run input. */
export function runtimeRunAdmissionFromAgentRecoveryIntent(
  intent: AgentRecoveryLaunchIntent,
): Readonly<{
  runId: string;
  invocationId: string;
  runStartedEventId: string;
  runStartedAt: string;
  parentRunId: string;
}> {
  return Object.freeze({
    runId: intent.runId,
    invocationId: intent.invocationId,
    runStartedEventId: intent.runStartedEventId,
    runStartedAt: intent.runStartedAt,
    parentRunId: intent.sourceRunId,
  });
}

function decodeAgentRecoverableTaskInput(value: unknown): AgentRecoverableTaskInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "executionId",
      "schemaVersion",
      "sessionId",
      "storageRootId",
      "taskRunId",
      "workspacePath",
    ]) ||
    value["schemaVersion"] !== AGENT_RECOVERABLE_TASK_INPUT_SCHEMA_VERSION
  ) {
    throw new Error("Agent recoverable task input has an unsupported shape");
  }
  const taskRunId = requiredIdentifier(value["taskRunId"], "taskRunId");
  const executionId = requiredIdentifier(value["executionId"], "executionId");
  const workspacePath = requiredIdentifier(value["workspacePath"], "workspacePath");
  const storageRootId = requiredIdentifier(value["storageRootId"], "storageRootId");
  const sessionId = requiredIdentifier(value["sessionId"], "sessionId");
  if (canonicalizeWorkspacePath(workspacePath) !== workspacePath) {
    throw new Error("Agent recoverable task workspacePath must be canonical");
  }
  return Object.freeze({
    schemaVersion: AGENT_RECOVERABLE_TASK_INPUT_SCHEMA_VERSION,
    taskRunId,
    executionId,
    workspacePath,
    storageRootId,
    sessionId,
  });
}

function assertResumeContext(
  input: AgentRecoverableTaskInput,
  context: RecoverableTaskResumeContext,
  workspacePath: string,
): void {
  const runtimeIdentity = deriveRecoverableTaskRuntimeLaunchIdentity(context.launchId);
  const runtime = context.boundary.runtime;
  if (input.taskRunId !== context.taskRunId) {
    throw new Error("Agent recoverable taskRunId changed before resume");
  }
  if (!runtime || runtime.sessionId !== input.sessionId) {
    throw new Error("Agent recoverable Runtime session identity changed before resume");
  }
  if (
    context.runtimeSessionId !== input.sessionId ||
    runtime.eventHighWater !== context.expectedSessionHighWater ||
    runtimeIdentity.runId !== context.expectedRuntimeRunId ||
    runtimeIdentity.runStartedEventId !== context.expectedRunStartedEventId
  ) {
    throw new Error("Agent recoverable Runtime launch identity is inconsistent");
  }
  if (
    context.boundary.storageRootId !== input.storageRootId ||
    canonicalizeWorkspacePath(context.boundary.workspacePath) !== workspacePath
  ) {
    throw new Error("Agent recoverable safe boundary belongs to another workspace");
  }
  if (!context.boundary.checkpointRef || context.boundary.checkpointRef !== context.checkpointRef) {
    throw new Error("Agent recoverable checkpoint identity changed before resume");
  }
}

async function admitSuccessorRuntimeRun(
  store: SqliteRuntimeEventStore,
  writeGuard: EngineRuntimeWriteGuard,
  input: AgentRecoverableTaskInput,
  context: RecoverableTaskResumeContext,
): Promise<{ readonly sequence: number; readonly invocationId: string; readonly at: string }> {
  const manifest = await store.readSessionManifest(input.sessionId);
  if (!manifest) {
    throw new Error(`Agent recovery Runtime session ${input.sessionId} is missing`);
  }
  if (canonicalizeWorkspacePath(manifest.workDir) !== input.workspacePath) {
    throw new Error(`Agent recovery Runtime session ${input.sessionId} changed workspace`);
  }
  const entries = await store.readSessionEntries(input.sessionId);
  const source = entries[context.expectedSessionHighWater - 1];
  const sourceRuntime = context.boundary.runtime!;
  if (
    !source ||
    source.sequence !== context.expectedSessionHighWater ||
    source.event.kind !== "run.terminal" ||
    source.event.runId !== sourceRuntime.runId ||
    source.event.data.status !== "interrupted"
  ) {
    throw new Error(
      `Agent recovery source run ${sourceRuntime.runId} is not durably interrupted at its high-water`,
    );
  }

  const invocationId = `invocation:${context.expectedRuntimeRunId}`;
  const started: RuntimeRunStartedEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: context.expectedRunStartedEventId,
    sessionId: input.sessionId,
    invocationId,
    runId: context.expectedRuntimeRunId,
    turnId: `turn:${context.expectedRuntimeRunId}:input`,
    at: source.event.at,
    partial: false,
    visibility: "internal",
    refs: { parentRunId: sourceRuntime.runId },
    kind: "run.started",
    data: { workDir: input.workspacePath },
  };
  const ownerFence = await writeGuard.assertRuntimeEventWriteAllowed();
  const [result] = await store.appendBatch([started], {
    expectedSessionHighWater: {
      [input.sessionId]: context.expectedSessionHighWater,
    },
    ownerFence,
  });
  const confirmedFence = await writeGuard.assertRuntimeEventWriteAllowed();
  if (confirmedFence.epoch !== ownerFence.epoch) {
    throw new Error(
      `Agent recovery owner fence changed during Session ${input.sessionId} admission`,
    );
  }
  if (!result || result.cursor.seq !== context.expectedSessionHighWater + 1) {
    throw new Error(
      `Agent recovery run.started did not occupy source high-water + 1 for ${context.launchId}`,
    );
  }
  return {
    sequence: result.cursor.seq,
    invocationId,
    at: started.at,
  };
}

function decodeAgentRecoveryLaunchIntent(value: unknown): AgentRecoveryLaunchIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "attemptId",
      "attemptNumber",
      "checkpointRef",
      "executionId",
      "invocationId",
      "launchId",
      "resumeExistingSession",
      "runId",
      "runStartedAt",
      "runStartedEventId",
      "runStartedSequence",
      "schemaVersion",
      "sessionId",
      "sourceAttemptId",
      "sourceEventHighWater",
      "sourceRunId",
      "storageRootId",
      "taskRunId",
      "workspacePath",
    ]) ||
    value["schemaVersion"] !== AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION ||
    value["resumeExistingSession"] !== true ||
    !isPositiveSafeInteger(value["attemptNumber"]) ||
    !isPositiveSafeInteger(value["sourceEventHighWater"]) ||
    !isPositiveSafeInteger(value["runStartedSequence"]) ||
    value["runStartedSequence"] !== (value["sourceEventHighWater"] as number) + 1
  ) {
    throw new Error("Agent recovery launch intent has an unsupported shape");
  }
  const workspacePath = requiredIdentifier(value["workspacePath"], "workspacePath");
  if (canonicalizeWorkspacePath(workspacePath) !== workspacePath) {
    throw new Error("Agent recovery launch intent workspacePath must be canonical");
  }
  return Object.freeze({
    schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
    launchId: requiredIdentifier(value["launchId"], "launchId"),
    taskRunId: requiredIdentifier(value["taskRunId"], "taskRunId"),
    executionId: requiredIdentifier(value["executionId"], "executionId"),
    sourceAttemptId: requiredIdentifier(value["sourceAttemptId"], "sourceAttemptId"),
    attemptId: requiredIdentifier(value["attemptId"], "attemptId"),
    attemptNumber: value["attemptNumber"] as number,
    workspacePath,
    storageRootId: requiredIdentifier(value["storageRootId"], "storageRootId"),
    sessionId: requiredIdentifier(value["sessionId"], "sessionId"),
    sourceRunId: requiredIdentifier(value["sourceRunId"], "sourceRunId"),
    sourceEventHighWater: value["sourceEventHighWater"] as number,
    checkpointRef: requiredIdentifier(value["checkpointRef"], "checkpointRef"),
    runId: requiredIdentifier(value["runId"], "runId"),
    invocationId: requiredIdentifier(value["invocationId"], "invocationId"),
    runStartedEventId: requiredIdentifier(value["runStartedEventId"], "runStartedEventId"),
    runStartedSequence: value["runStartedSequence"] as number,
    runStartedAt: requiredTimestamp(value["runStartedAt"], "runStartedAt"),
    resumeExistingSession: true,
  });
}

function decodeAgentRecoveryWorkerReceipt(value: unknown): AgentRecoveryWorkerReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["launchId", "schemaVersion", "workerId"]) ||
    value["schemaVersion"] !== AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION
  ) {
    throw new Error("Agent recovery worker returned an invalid receipt");
  }
  return Object.freeze({
    schemaVersion: AGENT_RECOVERY_WORKER_RECEIPT_SCHEMA_VERSION,
    launchId: requiredIdentifier(value["launchId"], "worker receipt launchId"),
    workerId: requiredIdentifier(value["workerId"], "workerId"),
  });
}

function decodeAgentRecoveryWorkerTerminal(
  value: AgentRecoveryWorkerTerminal,
  now: () => Date,
): Required<Omit<AgentRecoveryWorkerTerminal, "terminalEventId">> & {
  readonly terminalEventId?: string;
} {
  if (!isRecord(value)) throw new Error("Agent recovery worker terminal is invalid");
  const expectedKeys = [
    "launchId",
    "status",
    "workerId",
    ...(value["terminalEventId"] === undefined ? [] : ["terminalEventId"]),
    ...(value["at"] === undefined ? [] : ["at"]),
  ];
  if (!hasExactKeys(value, expectedKeys)) {
    throw new Error("Agent recovery worker terminal has extra or missing fields");
  }
  const status = value["status"];
  if (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  ) {
    throw new Error("Agent recovery worker terminal status is invalid");
  }
  const terminalEventId =
    value["terminalEventId"] === undefined
      ? undefined
      : requiredIdentifier(value["terminalEventId"], "terminalEventId");
  return {
    launchId: requiredIdentifier(value["launchId"], "launchId"),
    workerId: requiredIdentifier(value["workerId"], "workerId"),
    status,
    ...(terminalEventId ? { terminalEventId } : {}),
    at:
      value["at"] === undefined
        ? canonicalTimestamp(now(), "terminal at")
        : requiredTimestamp(value["at"], "terminal at"),
  };
}

function decodeAgentRecoveryLaunchIntentProjection(
  value: unknown,
  path: string,
): AgentRecoveryLaunchIntentProjection {
  if (
    !isRecord(value) ||
    value["type"] !== "agent-recovery-launch-intent" ||
    value["schemaVersion"] !== AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION ||
    !isNonNegativeSafeInteger(value["claimEpoch"])
  ) {
    throw new Error(`Agent recovery launch-intent record is invalid in ${path}`);
  }
  const intent = decodeAgentRecoveryLaunchIntent(value["intent"]);
  const preparedAt = requiredTimestamp(value["preparedAt"], "preparedAt");
  const claimEpoch = value["claimEpoch"] as number;
  switch (value["state"]) {
    case "prepared":
      assertExactProjectionKeys(
        value,
        ["claimEpoch", "intent", "preparedAt", "schemaVersion", "state", "type"],
        path,
      );
      return {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt,
        claimEpoch,
        state: "prepared",
      };
    case "installing":
      assertExactProjectionKeys(
        value,
        [
          "claimEpoch",
          "claimExpiresAt",
          "claimId",
          "claimedAt",
          "intent",
          "ownerId",
          "preparedAt",
          "schemaVersion",
          "state",
          "type",
        ],
        path,
      );
      return {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt,
        claimEpoch,
        state: "installing",
        claimId: requiredIdentifier(value["claimId"], "claimId"),
        ownerId: requiredIdentifier(value["ownerId"], "ownerId"),
        claimedAt: requiredTimestamp(value["claimedAt"], "claimedAt"),
        claimExpiresAt: requiredTimestamp(value["claimExpiresAt"], "claimExpiresAt"),
      };
    case "installed": {
      assertExactProjectionKeys(
        value,
        [
          "claimEpoch",
          "installedAt",
          "intent",
          "preparedAt",
          "schemaVersion",
          "state",
          "type",
          "worker",
        ],
        path,
      );
      const worker = decodeAgentRecoveryWorkerReceipt(value["worker"]);
      assertWorkerMatchesIntent(worker, intent);
      return {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt,
        claimEpoch,
        state: "installed",
        worker,
        installedAt: requiredTimestamp(value["installedAt"], "installedAt"),
      };
    }
    case "terminal": {
      assertExactProjectionKeys(
        value,
        [
          "claimEpoch",
          "installedAt",
          "intent",
          "preparedAt",
          "schemaVersion",
          "state",
          "terminal",
          "type",
          "worker",
        ],
        path,
      );
      const worker = decodeAgentRecoveryWorkerReceipt(value["worker"]);
      assertWorkerMatchesIntent(worker, intent);
      if (!isRecord(value["terminal"])) {
        throw new Error(`Agent recovery terminal record is invalid in ${path}`);
      }
      const terminalValue = value["terminal"];
      const terminalKeys =
        terminalValue["terminalEventId"] === undefined
          ? ["at", "status"]
          : ["at", "status", "terminalEventId"];
      if (!hasExactKeys(terminalValue, terminalKeys)) {
        throw new Error(`Agent recovery terminal record is invalid in ${path}`);
      }
      const terminal = decodeAgentRecoveryWorkerTerminal(
        {
          launchId: intent.launchId,
          workerId: worker.workerId,
          status: terminalValue["status"] as AgentRecoveryWorkerTerminalStatus,
          ...(terminalValue["terminalEventId"] !== undefined
            ? { terminalEventId: terminalValue["terminalEventId"] as string }
            : {}),
          at: terminalValue["at"] as string,
        },
        () => new Date(0),
      );
      return {
        type: "agent-recovery-launch-intent",
        schemaVersion: AGENT_RECOVERY_LAUNCH_INTENT_SCHEMA_VERSION,
        intent,
        preparedAt,
        claimEpoch,
        state: "terminal",
        worker,
        installedAt: requiredTimestamp(value["installedAt"], "installedAt"),
        terminal: {
          status: terminal.status,
          ...(terminal.terminalEventId ? { terminalEventId: terminal.terminalEventId } : {}),
          at: terminal.at,
        },
      };
    }
    default:
      throw new Error(`Agent recovery launch-intent state is invalid in ${path}`);
  }
}

function assertWorkerMatchesIntent(
  worker: AgentRecoveryWorkerReceipt,
  intent: AgentRecoveryLaunchIntent,
): void {
  if (worker.launchId !== intent.launchId) {
    throw new Error("Agent recovery worker receipt does not match its launch intent");
  }
}

function assertExactProjectionKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  path: string,
): void {
  if (!hasExactKeys(value, keys)) {
    throw new Error(`Agent recovery launch-intent record has extra or missing fields in ${path}`);
  }
}

function launchIntentDigest(launchId: string): string {
  assertIdentifier(launchId, "launchId");
  return createHash("sha256").update(launchId).digest("hex");
}

function requiredIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 1_024 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`Agent recovery ${field} is invalid`);
  }
  return value;
}

function assertIdentifier(value: string, field: string): void {
  requiredIdentifier(value, field);
}

function requiredTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Agent recovery ${field} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Agent recovery ${field} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: Date, field: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`Agent recovery ${field} is invalid`);
  return value.toISOString();
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent recovery ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Agent recovery ${field} must be a non-negative safe integer`);
  }
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function ensurePrivateIntentDirectorySync(path: string): void {
  const metadata = existsSync(path) ? lstatSync(path) : undefined;
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new FileStorageIntegrityError(
      `Agent recovery intent directory must be a real directory: ${path}`,
    );
  }
  mkdirPrivateSync(path);
}
