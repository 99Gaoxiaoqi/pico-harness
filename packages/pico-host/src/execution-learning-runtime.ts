import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import {
  isForegroundProcessFacts,
  type ExecutionAcceptanceClaim,
  type ExecutionCondition,
  type ExecutionLearningAdmission,
  type ExecutionLearningCandidate,
  type ExecutionLearningStore,
  type ExecutionLearningTarget,
  type ExecutionPreparation,
  type ExecutionTestReport,
  type ExecutionVerificationResult,
  type ExecutionVerificationTicket,
  type MemoryItemSource,
  type RuntimeToolResultRecordedEvent,
  type RuntimeToolStartedEvent,
  type ToolCall,
  type ToolResultEnvelope,
} from "@pico/core";
import { memoryTextContainsSecret } from "@pico/runtime/atomic-memory/extraction-evidence";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";
import { raceWithDeadlineReject } from "@pico/runtime/deadline";
import type { RuntimeToolOperation } from "@pico/storage/runtime-event-store-contracts";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import {
  conditionsFromFileCommit,
  instrumentCommand,
  observeExecutionConditions,
  readExecutionTestReport,
  resolveExecutionLearningTarget,
  type ExecutionEvidenceIO,
} from "./execution-learning-evidence.js";
import type { NativeFileCommit, NativeLearningObserver } from "./native-file-learning.js";
import type { Session } from "./session.js";
import type { ToolExecutionContext } from "./tool-registry-contract.js";
import { isSensitiveCredentialPath } from "./session-permissions.js";
import {
  cwdPreparation,
  dependencyPreparation,
  observeInstalledDependency,
  type NativeDependencyInstallation,
} from "./execution-learning-dependency.js";

type NativeFact = {
  readonly toolCallId: string;
  readonly preparedEventId: string;
  readonly kind: string;
  readonly fact: unknown;
};
export interface ExecutionLearningNativeStore extends ExecutionLearningStore {
  listAdmissions(): Promise<readonly ExecutionLearningAdmission[]>;
  listPendingVerifications(): Promise<readonly { readonly ticket: ExecutionVerificationTicket }[]>;
  recordNativeFact(
    admissionId: string,
    toolCallId: string,
    preparedEventId: string,
    kind: "file" | "command",
    fact: unknown,
  ): Promise<void>;
  listNativeFacts(admissionId: string): Promise<readonly NativeFact[]>;
}
export interface ExecutionNativeCommandFact {
  readonly version: 1;
  readonly argumentsJson: string;
  readonly preparedSequence: number;
  readonly target?: ExecutionLearningTarget;
  readonly reportPath?: string;
  readonly dependency?: {
    readonly command: string;
    readonly cwd: string;
    readonly packageName: string;
  };
  readonly installedDependency?: NativeDependencyInstallation;
  readonly cwdPreparation?: string;
  readonly result?: {
    readonly source: MemoryItemSource;
    readonly resultSequence: number;
    readonly settledAt: number;
    readonly complete: boolean;
    readonly exitCode: number | null;
    readonly report?: ExecutionTestReport;
  };
}
export interface ExecutionNativeFileFact {
  readonly version: 1;
  readonly commits: readonly NativeFileCommit[];
  readonly source?: MemoryItemSource;
  readonly resultSequence?: number;
}
export interface CanonicalExecutionSource {
  readonly start: RuntimeToolStartedEvent;
  readonly result: RuntimeToolResultRecordedEvent;
  readonly operation: RuntimeToolOperation;
  readonly preparedSequence: number;
  readonly resultSequence: number;
}

type CanonicalReader = Pick<
  SqliteRuntimeEventStore,
  "readToolOperation" | "readSessionEvent" | "readRun"
>;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const argumentHash = (value: string): string => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function argumentsOf(call: ToolCall): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(call.arguments));
  } catch {
    return undefined;
  }
}
function sourceOf(event: RuntimeToolResultRecordedEvent): MemoryItemSource {
  return {
    sessionId: event.sessionId,
    runId: event.runId,
    turnId: event.turnId,
    eventId: event.eventId,
  };
}
function completeProcess(event: RuntimeToolResultRecordedEvent): boolean {
  const facts = event.data.executionFacts;
  return (
    isForegroundProcessFacts(facts) &&
    facts.exitCode !== null &&
    facts.terminationSignal === null &&
    !facts.timedOut &&
    !facts.outputIncomplete &&
    !facts.spawnFailed
  );
}

/** Point reads bind a source to the canonical T1/T2 journal, rather than trusting callback text. */
export async function validateCanonicalExecutionSource(
  events: CanonicalReader,
  ref: MemoryItemSource,
  options: { readonly workDir?: string; readonly toolName?: string } = {},
): Promise<CanonicalExecutionSource | undefined> {
  if (ref.runId.startsWith("fork-bootstrap:")) return undefined;
  const outcome = await events.readSessionEvent(ref.sessionId, ref.eventId);
  if (outcome?.event.kind !== "tool.result.recorded") return undefined;
  const result = outcome.event;
  const operation = await events.readToolOperation(
    ref.sessionId,
    ref.runId,
    result.refs.toolCallId,
  );
  if (!operation || operation.state !== "settled" || operation.outcomeEventId !== result.eventId)
    return undefined;
  const prepared = await events.readSessionEvent(ref.sessionId, operation.preparedEventId);
  if (prepared?.event.kind !== "tool.started") return undefined;
  const start = prepared.event;
  if (
    start.sessionId !== ref.sessionId ||
    result.sessionId !== ref.sessionId ||
    start.runId !== ref.runId ||
    result.runId !== ref.runId ||
    result.turnId !== ref.turnId ||
    start.turnId !== result.turnId ||
    start.invocationId !== result.invocationId ||
    start.refs?.toolCallId !== operation.toolCallId ||
    start.data.toolName !== result.data.toolName ||
    operation.toolName !== start.data.toolName ||
    (options.toolName && start.data.toolName !== options.toolName) ||
    operation.argumentsHash !== start.data.argumentsHash ||
    argumentHash(start.data.argumentsJson) !== operation.argumentsHash ||
    start.data.argumentsRedacted ||
    start.partial ||
    result.partial ||
    result.data.recovery ||
    !["succeeded", "failed"].includes(result.data.status) ||
    prepared.sequence >= outcome.sequence ||
    memoryTextContainsSecret(start.data.argumentsJson) ||
    memoryTextContainsSecret(
      result.data.body.storage === "inline"
        ? result.data.body.content
        : result.data.projection.text,
    )
  )
    return undefined;
  const run = await events.readRun(ref.sessionId, ref.runId);
  const starts = run.filter((event) => event.kind === "run.started");
  if (
    starts.length !== 1 ||
    starts[0]?.kind !== "run.started" ||
    starts[0].data.continuationOf ||
    (options.workDir && resolve(starts[0].data.workDir) !== resolve(options.workDir)) ||
    run.some((event) => event.kind === "run.terminal" && event.data.recovered)
  )
    return undefined;
  if (start.data.toolName === "bash") {
    let args: Record<string, unknown> | undefined;
    try {
      args = object(JSON.parse(start.data.argumentsJson));
    } catch {
      return undefined;
    }
    if (!completeProcess(result) || typeof args?.command !== "string" || args.background === true)
      return undefined;
  }
  return {
    start,
    result,
    operation,
    preparedSequence: prepared.sequence,
    resultSequence: outcome.sequence,
  };
}

export interface ExecutionLearningRuntimeOptions {
  readonly session: Pick<Session, "id" | "workDir" | "runtimeEventStore">;
  readonly workspaceKey: string;
  readonly picoHome: string;
  readonly workDir: string;
  readonly store: Pick<SqliteMemoryItemStore, "readSettings" | "readDeletionRevision"> & {
    readonly executionLearning: ExecutionLearningNativeStore;
  };
  readonly io: ExecutionEvidenceIO;
  readonly gate: () => Promise<{ readonly allowed: boolean }>;
  readonly worker: { wake(): void };
  readonly modelRoute?: ExecutionLearningAdmission["modelRoute"];
  readonly onDiagnostic?: (error: unknown) => void;
  readonly onChanged?: () => void;
}
interface PreparedCommand {
  readonly argumentsJson: string;
  readonly command: string;
  readonly target?: ExecutionLearningTarget;
  readonly reportPath?: string;
}

/** Optional bounded evidence collection for a single admitted foreground Run. */
export class ExecutionLearningRuntime implements NativeLearningObserver {
  private admission: ExecutionLearningAdmission | undefined;
  private readonly prepared = new Map<string, PreparedCommand>();
  private readonly commands = new Map<string, ExecutionNativeCommandFact>();
  private readonly files = new Map<string, ExecutionNativeFileFact>();
  private readonly tickets = new Map<string, ExecutionVerificationTicket>();
  constructor(private readonly options: ExecutionLearningRuntimeOptions) {}
  private get store(): ExecutionLearningNativeStore {
    return this.options.store.executionLearning;
  }

  private async bounded<T>(fallback: T, work: (check: () => void) => Promise<T>): Promise<T> {
    let active = true;
    const deadline = performance.now() + 100;
    const check = () => {
      if (!active || performance.now() > deadline) throw new Error("Learning collection deadline");
    };
    try {
      const task = work(check).catch((error: unknown) => {
        this.options.onDiagnostic?.(error);
        return fallback;
      });
      return await raceWithDeadlineReject(
        task,
        100,
        () => new Error("Learning collection deadline"),
      ).catch((error: unknown) => {
        this.options.onDiagnostic?.(error);
        return fallback;
      });
    } finally {
      active = false;
    }
  }
  private async allowed(check: () => void): Promise<boolean> {
    const gate = await this.options.gate();
    check();
    return gate.allowed;
  }
  private changed(): void {
    try {
      this.options.onChanged?.();
    } catch {
      /* optional UI */
    }
  }
  private wake(): void {
    try {
      this.options.worker.wake();
    } catch {
      /* optional worker */
    }
  }

  async admit(runId: string): Promise<void> {
    await this.bounded(undefined, async (check) => {
      if (
        this.admission ||
        !runId ||
        runId.startsWith("fork-bootstrap:") ||
        !this.options.session.runtimeEventStore ||
        !(await this.allowed(check))
      )
        return;
      const settings = await this.options.store.readSettings(this.options.workspaceKey);
      const deletionRevision = await this.options.store.readDeletionRevision();
      check();
      if (!settings.enabled || !settings.autoExtract) return;
      const generation = await this.store.advanceExecutionLearningInput(this.options.workspaceKey);
      check();
      const admission: ExecutionLearningAdmission = {
        admissionId: `execution-admission:${randomUUID()}`,
        workspaceKey: this.options.workspaceKey,
        sessionId: this.options.session.id,
        runId,
        workDir: resolve(this.options.workDir),
        settingsVersion: settings.version,
        deletionRevision,
        managementRevision: generation.managementRevision,
        inputEpoch: generation.inputEpoch,
        ...(this.options.modelRoute ? { modelRoute: this.options.modelRoute } : {}),
        createdAt: Date.now(),
      };
      await this.store.admitExecutionLearning(admission);
      check();
      this.admission = admission;
    });
  }

  async prepare(call: ToolCall): Promise<ToolCall> {
    return this.bounded(call, async (check) => {
      if (
        !this.admission ||
        call.name !== "bash" ||
        !(await this.allowed(check)) ||
        memoryTextContainsSecret(call.arguments)
      )
        return call;
      const args = argumentsOf(call);
      if (typeof args?.command !== "string" || args.background === true) return call;
      if (this.prepared.get(call.id)?.argumentsJson === call.arguments) return call;
      const target = await resolveExecutionLearningTarget(
        args.command,
        this.options.workDir,
        this.options.io,
      );
      check();
      let finalCall = call,
        reportPath: string | undefined;
      if (target?.kind === "node-test") {
        const reportDirectory = join(
          this.options.picoHome,
          "sandboxes",
          this.options.session.id,
          "execution-learning",
        );
        await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
        check();
        const instrumented = await instrumentCommand(target, { reportDirectory });
        check();
        if (!instrumented) return call;
        reportPath = instrumented.reportPath;
        finalCall = {
          ...call,
          arguments: JSON.stringify({ ...args, command: instrumented.command }),
        };
      }
      this.prepared.set(call.id, {
        argumentsJson: finalCall.arguments,
        command: String(argumentsOf(finalCall)?.command),
        ...(target ? { target } : {}),
        ...(reportPath ? { reportPath } : {}),
      });
      return finalCall;
    });
  }

  /** Current-run instrumentation can be shared with feedback without borrowing its admission. */
  preparedNativeCommand(
    call: ToolCall,
  ): { readonly target: ExecutionLearningTarget; readonly reportPath?: string } | undefined {
    const prepared = this.prepared.get(call.id);
    return prepared?.argumentsJson === call.arguments && prepared.target
      ? {
          target: prepared.target,
          ...(prepared.reportPath ? { reportPath: prepared.reportPath } : {}),
        }
      : undefined;
  }

  async beforeDispatch(call: ToolCall, context: ToolExecutionContext): Promise<void> {
    await this.bounded(undefined, async (check) => {
      const admission = this.admission,
        events = this.options.session.runtimeEventStore;
      if (
        !admission ||
        !events ||
        context.signal?.aborted ||
        !(await this.allowed(check)) ||
        memoryTextContainsSecret(call.arguments)
      )
        return;
      const operation = await events.readToolOperation(
        admission.sessionId,
        admission.runId,
        call.id,
      );
      check();
      if (
        !operation ||
        operation.state !== "prepared" ||
        operation.toolName !== call.name ||
        operation.argumentsHash !== argumentHash(call.arguments)
      )
        return;
      const entry = await events.readSessionEvent(admission.sessionId, operation.preparedEventId);
      check();
      if (
        entry?.event.kind !== "tool.started" ||
        entry.event.data.argumentsRedacted ||
        entry.event.partial ||
        entry.event.runId !== admission.runId ||
        entry.event.data.argumentsHash !== operation.argumentsHash ||
        entry.event.refs?.toolCallId !== call.id
      )
        return;
      if (call.name !== "bash") return;
      const prepared = this.prepared.get(call.id);
      const args = argumentsOf(call);
      let matching =
        prepared?.argumentsJson === call.arguments &&
        prepared.command === args?.command &&
        args.background !== true
          ? prepared
          : undefined;
      if (matching?.target) {
        const current = await resolveExecutionLearningTarget(
          matching.target.command,
          matching.target.cwd,
          this.options.io,
        );
        check();
        if (current?.scopeHash !== matching.target.scopeHash) matching = undefined;
      }
      const dependency =
        typeof args?.command === "string"
          ? await dependencyPreparation(args.command, this.options.workDir)
          : undefined;
      const dependencyCwd = dependency ? await this.options.io.realpath(dependency.cwd) : undefined;
      const preparedCwd =
        typeof args?.command === "string"
          ? await cwdPreparation(args.command, this.options.workDir, this.options.io)
          : undefined;
      check();
      const fact: ExecutionNativeCommandFact = {
        version: 1,
        argumentsJson: call.arguments,
        preparedSequence: entry.sequence,
        ...(matching?.target ? { target: matching.target } : {}),
        ...(matching?.reportPath ? { reportPath: matching.reportPath } : {}),
        ...(dependency && dependencyCwd
          ? { dependency: { ...dependency, cwd: dependencyCwd } }
          : {}),
        ...(preparedCwd ? { cwdPreparation: preparedCwd } : {}),
      };
      await this.store.recordNativeFact(
        admission.admissionId,
        call.id,
        operation.preparedEventId,
        "command",
        fact,
      );
      check();
      this.commands.set(call.id, fact);
      if (!fact.target) return;
      const candidates = await this.store.listExecutionLearningCandidates(
        this.options.workspaceKey,
      );
      check();
      for (const candidate of candidates) {
        if (
          !["waiting", "insufficient"].includes(candidate.state) ||
          !sameSourceTarget(candidate.claim.target, fact.target)
        )
          continue;
        const claim = await this.freezePreparation(candidate, fact.target, entry.sequence, check);
        check();
        if (
          !claim ||
          !claim.recipe.length ||
          !claim.conditions.length ||
          (claim.predicateId === "test-target-pass.v1" && !claim.failedTestIds.length)
        )
          continue;
        const before = await observeExecutionConditions(claim.conditions, this.options.io);
        check();
        if (!before.complete || !before.matches) continue;
        const ticket: ExecutionVerificationTicket = {
          ticketId: `execution-ticket:${digest([claim.candidateId, claim.revision, operation.preparedEventId])}`,
          candidateId: claim.candidateId,
          claimRevision: claim.revision,
          claimHash: claim.claimHash,
          admissionId: admission.admissionId,
          sessionId: admission.sessionId,
          runId: admission.runId,
          toolCallId: call.id,
          preparedEventId: operation.preparedEventId,
          argumentsHash: operation.argumentsHash,
          inputEpoch: admission.inputEpoch,
          before,
          createdAt: Date.now(),
        };
        await this.store.registerExecutionVerification(ticket);
        check();
        this.tickets.set(call.id, ticket);
        break;
      }
    });
  }

  async fileCommitted(call: ToolCall, fact: NativeFileCommit): Promise<void> {
    await this.bounded(undefined, async (check) => {
      const admission = this.admission,
        events = this.options.session.runtimeEventStore;
      if (
        !admission ||
        !events ||
        !isAbsolute(fact.path) ||
        isSensitiveCredentialPath(fact.path) ||
        !(await this.allowed(check))
      )
        return;
      const operation = await events.readToolOperation(
        admission.sessionId,
        admission.runId,
        call.id,
      );
      check();
      if (
        !operation ||
        operation.state !== "prepared" ||
        operation.toolName !== call.name ||
        operation.argumentsHash !== argumentHash(call.arguments)
      )
        return;
      const content = safeFileContent(fact.content);
      const commit: NativeFileCommit = {
        path: fact.path,
        afterHash: fact.afterHash,
        ...(fact.beforeHash !== undefined ? { beforeHash: fact.beforeHash } : {}),
        ...(content !== undefined ? { content } : {}),
      };
      const previous = this.files.get(call.id);
      const record: ExecutionNativeFileFact = {
        version: 1,
        commits: [...(previous?.commits ?? []), commit].slice(-8),
      };
      await this.store.recordNativeFact(
        admission.admissionId,
        call.id,
        operation.preparedEventId,
        "file",
        record,
      );
      check();
      this.files.set(call.id, record);
    });
  }

  async committed(call: ToolCall, envelope: ToolResultEnvelope): Promise<void> {
    await this.bounded(undefined, (check) => this.settle(call, envelope, check));
  }

  private async settle(
    call: ToolCall,
    envelope: ToolResultEnvelope | undefined,
    check: () => void,
  ): Promise<void> {
    const admission = this.admission,
      events = this.options.session.runtimeEventStore;
    if (!admission || !events || !(await this.allowed(check))) return;
    const operation = await events.readToolOperation(admission.sessionId, admission.runId, call.id);
    check();
    if (!operation?.outcomeEventId) return;
    const entry = await events.readSessionEvent(admission.sessionId, operation.outcomeEventId);
    check();
    if (entry?.event.kind !== "tool.result.recorded") return;
    const canonical = await validateCanonicalExecutionSource(events, sourceOf(entry.event), {
      workDir: this.options.workDir,
      toolName: call.name,
    });
    check();
    if (
      !canonical ||
      canonical.start.data.argumentsJson !==
        (this.commands.get(call.id)?.argumentsJson ?? call.arguments) ||
      (envelope &&
        (envelope.toolCallId !== call.id ||
          envelope.toolName !== call.name ||
          envelope.status !== canonical.result.data.status ||
          envelope.sha256 !== canonical.result.data.body.sha256))
    )
      return;
    const source = sourceOf(canonical.result);
    const file = this.files.get(call.id);
    if (file && canonical.result.data.status === "succeeded") {
      const record: ExecutionNativeFileFact = {
        ...file,
        source,
        resultSequence: canonical.resultSequence,
      };
      await this.store.recordNativeFact(
        admission.admissionId,
        call.id,
        operation.preparedEventId,
        "file",
        record,
      );
      check();
      this.files.set(call.id, record);
    }
    const previous = this.commands.get(call.id);
    if (!previous || call.name !== "bash" || !completeProcess(canonical.result)) return;
    const report = previous.reportPath
      ? await readExecutionTestReport(previous.reportPath, this.options.io)
      : undefined;
    check();
    const exitCode = canonical.result.data.executionFacts!.exitCode;
    const settledAt = Date.parse(operation.settledAt ?? canonical.result.at);
    if (!Number.isFinite(settledAt)) return;
    const installedDependency =
      previous.dependency && exitCode === 0
        ? await observeInstalledDependency(previous.dependency, this.options.io)
        : undefined;
    check();
    const record: ExecutionNativeCommandFact = {
      ...previous,
      ...(installedDependency ? { installedDependency } : {}),
      result: {
        source,
        resultSequence: canonical.resultSequence,
        settledAt,
        complete: true,
        exitCode,
        ...(report ? { report } : {}),
      },
    };
    await this.store.recordNativeFact(
      admission.admissionId,
      call.id,
      operation.preparedEventId,
      "command",
      record,
    );
    check();
    this.commands.set(call.id, record);
    const ticket = this.tickets.get(call.id);
    if (ticket) {
      if (
        ticket.preparedEventId !== operation.preparedEventId ||
        ticket.argumentsHash !== operation.argumentsHash
      )
        return;
      const candidate = await this.store.readExecutionLearningCandidate(ticket.candidateId);
      check();
      if (
        !candidate ||
        candidate.claim.claimHash !== ticket.claimHash ||
        candidate.claim.revision !== ticket.claimRevision
      )
        return;
      const after = await observeExecutionConditions(candidate.claim.conditions, this.options.io);
      check();
      const result: ExecutionVerificationResult = {
        ticketId: ticket.ticketId,
        source,
        after,
        complete: true,
        exitCode,
        ...(report ? { report } : {}),
        settledAt,
      };
      await this.store.settleExecutionVerification(result);
      check();
      await this.enqueue(candidate, "verify", ticket, check);
      this.wake();
    }
    if (exitCode !== null && exitCode !== 0 && record.target) await this.saveFailure(record, check);
  }

  private async saveFailure(fact: ExecutionNativeCommandFact, check: () => void): Promise<void> {
    const admission = this.admission,
      target = fact.target,
      result = fact.result;
    if (!admission || !target || !result) return;
    const predicateId =
      target.kind === "node-test"
        ? ("test-target-pass.v1" as const)
        : ("command-conditions.v1" as const);
    const identity = digest([
      admission.workspaceKey,
      result.source.eventId,
      predicateId,
      target.scopeHash,
    ]);
    const base = {
      candidateId: `execution-candidate:${identity}`,
      revision: 1,
      failureKey: digest([admission.workspaceKey, result.source.eventId]),
      predicateId,
      admission,
      target,
      conditions: [],
      recipe: [],
      failedTestIds: result.report?.complete ? result.report.failed : [],
      failure: result.source,
      ...(result.report?.runner ? { runner: result.report.runner } : {}),
      createdAt: result.settledAt,
    };
    const existing = await this.store.readExecutionLearningCandidate(base.candidateId);
    check();
    if (existing) return;
    check();
    await this.store.saveExecutionLearningClaim({ ...base, claimHash: digest(base) });
    check();
    this.changed();
  }

  private async freezePreparation(
    candidate: ExecutionLearningCandidate,
    target: ExecutionLearningTarget,
    dispatchSequence: number,
    check: () => void,
  ): Promise<ExecutionAcceptanceClaim | undefined> {
    const admission = this.admission;
    if (!admission) return undefined;
    const original = candidate.claim;
    const currentFacts = await this.store.listNativeFacts(admission.admissionId);
    const originalFacts =
      original.admission.admissionId === admission.admissionId
        ? currentFacts
        : await this.store.listNativeFacts(original.admission.admissionId);
    check();
    const sameRun =
      original.failure.sessionId === admission.sessionId &&
      original.failure.runId === admission.runId;
    const failureCommand = originalFacts
      .filter((record) => record.kind === "command")
      .map((record) => record.fact as ExecutionNativeCommandFact)
      .find((fact) => fact.result?.source.eventId === original.failure.eventId);
    const failureSequence = failureCommand?.result?.resultSequence;
    const recipes = new Map<string, ExecutionPreparation>();
    const dependencies = new Map<string, readonly ExecutionCondition[]>();
    const ordered = (facts: readonly NativeFact[]) =>
      [...facts].sort((a, b) => nativeResultSequence(a) - nativeResultSequence(b));
    for (const record of originalFacts === currentFacts
      ? ordered(currentFacts)
      : [...ordered(originalFacts), ...ordered(currentFacts)]) {
      if (record.kind === "command") {
        const command = record.fact as ExecutionNativeCommandFact;
        const installed = command.installedDependency;
        const result = command.result;
        if (
          installed &&
          result?.exitCode === 0 &&
          installed.cwd === target.cwd &&
          ((result.source.runId === admission.runId &&
            result.source.sessionId === admission.sessionId &&
            result.resultSequence < dispatchSequence &&
            (!sameRun ||
              (failureSequence !== undefined && result.resultSequence > failureSequence))) ||
            (!sameRun &&
              result.source.runId === original.failure.runId &&
              result.source.sessionId === original.failure.sessionId &&
              failureSequence !== undefined &&
              result.resultSequence > failureSequence))
        ) {
          recipes.set(`dependency:${installed.packageName}`, {
            kind: "dependency",
            command: installed.command,
            manifestHash: installed.manifestHash,
            source: result.source,
          });
          dependencies.set(installed.packageName, [
            installed.condition,
            { kind: "file", path: installed.condition.path, hash: installed.manifestHash },
          ]);
        }
        if (
          command.cwdPreparation === target.cwd &&
          target.cwd !== original.target.cwd &&
          result?.exitCode === 0 &&
          result.source.sessionId === admission.sessionId &&
          result.source.runId === admission.runId &&
          result.resultSequence < dispatchSequence &&
          (!sameRun || (failureSequence !== undefined && result.resultSequence > failureSequence))
        )
          recipes.set(`cwd:${target.cwd}`, {
            kind: "cwd",
            path: target.cwd,
            source: result.source,
          });
        continue;
      }
      if (record.kind !== "file") continue;
      const fact = object(record.fact) as unknown as ExecutionNativeFileFact | undefined;
      if (
        fact?.version !== 1 ||
        !fact.source ||
        !Array.isArray(fact.commits) ||
        !fact.resultSequence
      )
        continue;
      const belongsToFailureRun =
        fact.source.sessionId === original.failure.sessionId &&
        fact.source.runId === original.failure.runId;
      const belongsToCurrentRun =
        fact.source.sessionId === admission.sessionId && fact.source.runId === admission.runId;
      if (
        (!belongsToFailureRun && !belongsToCurrentRun) ||
        (belongsToCurrentRun && fact.resultSequence >= dispatchSequence) ||
        (belongsToFailureRun &&
          (failureSequence === undefined || fact.resultSequence <= failureSequence))
      )
        continue;
      for (const commit of fact.commits) {
        if (
          !commit.content ||
          ![".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".txt"].includes(
            extname(commit.path).toLowerCase(),
          ) ||
          commit.beforeHash === commit.afterHash ||
          target.entryFiles.some((file) => file.path === commit.path) ||
          !conditionsFromFileCommit({ ...commit, source: fact.source }).length
        )
          continue;
        recipes.set(commit.path, { kind: "file", ...commit, source: fact.source });
      }
    }
    if (target.cwd !== original.target.cwd && !recipes.has(`cwd:${target.cwd}`)) {
      const cwd = [...this.commands.values()].find(
        (fact) =>
          fact.target?.cwd === target.cwd &&
          fact.result?.exitCode === 0 &&
          fact.result.resultSequence < dispatchSequence &&
          (!sameRun ||
            (failureSequence !== undefined && fact.result.resultSequence > failureSequence)),
      );
      if (!cwd?.result) return undefined;
      recipes.set(`cwd:${target.cwd}`, {
        kind: "cwd",
        path: target.cwd,
        source: cwd.result.source,
      });
    }
    if (!recipes.size)
      return original.target.scopeHash === target.scopeHash && original.recipe.length
        ? original
        : undefined;
    const recipe = [...recipes.values()];
    const conditions: ExecutionCondition[] = [...dependencies.values()]
      .flat()
      .concat(
        recipe.flatMap<ExecutionCondition>((preparation) =>
          preparation.kind === "file"
            ? conditionsFromFileCommit(preparation)
            : preparation.kind === "cwd"
              ? [{ kind: "cwd", path: preparation.path }]
              : [],
        ),
      );
    const paths = new Set([
      target.cwd,
      ...target.entryFiles.map((file) => file.path),
      ...conditions.map((condition) => condition.path),
    ]);
    if (paths.size > 8) return undefined;
    const comparison = { target, recipe, conditions };
    if (
      digest(comparison) ===
      digest({ target: original.target, recipe: original.recipe, conditions: original.conditions })
    )
      return original;
    const base = {
      ...original,
      revision: original.revision + 1,
      target,
      recipe,
      conditions,
      createdAt: Date.now(),
    };
    const { claimHash: _oldHash, ...hashable } = base;
    const next = { ...base, claimHash: digest(hashable) };
    check();
    const saved = await this.store.saveExecutionLearningClaim(next);
    check();
    this.changed();
    return saved.claim;
  }

  private async enqueue(
    candidate: ExecutionLearningCandidate,
    kind: "verify" | "reflect",
    ticket: ExecutionVerificationTicket | undefined,
    check: () => void,
  ): Promise<void> {
    const admission = this.admission;
    if (!admission) return;
    const now = Date.now();
    check();
    await this.store.enqueueExecutionLearningJob({
      jobId: `execution-job:${digest([candidate.claim.candidateId, candidate.claim.revision, kind, ticket?.ticketId ?? admission.runId])}`,
      workspaceKey: this.options.workspaceKey,
      sessionId: ticket?.sessionId ?? admission.sessionId,
      runId: ticket?.runId ?? admission.runId,
      candidateId: candidate.claim.candidateId,
      ...(ticket ? { ticketId: ticket.ticketId } : {}),
      kind,
      state: "ready",
      inputEpoch: admission.inputEpoch,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
      fencingToken: 0,
    });
    check();
    this.changed();
  }

  async completed(runId: string): Promise<void> {
    await this.bounded(undefined, async (check) => {
      const admission = this.admission,
        events = this.options.session.runtimeEventStore;
      if (!admission || admission.runId !== runId || !events || !(await this.allowed(check)))
        return;
      const run = await events.readRun(admission.sessionId, runId);
      check();
      const terminal = run.findLast((event) => event.kind === "run.terminal");
      if (
        terminal?.kind !== "run.terminal" ||
        terminal.data.status !== "completed" ||
        terminal.data.recovered
      )
        return;
      const facts = await this.store.listNativeFacts(admission.admissionId);
      check();
      for (const record of facts) {
        const operation = await events.readToolOperation(
          admission.sessionId,
          runId,
          record.toolCallId,
        );
        check();
        if (!operation?.outcomeEventId || operation.preparedEventId !== record.preparedEventId)
          continue;
        const start = await events.readSessionEvent(admission.sessionId, operation.preparedEventId);
        check();
        if (start?.event.kind !== "tool.started") continue;
        if (record.kind === "command" && object(record.fact)?.version === 1)
          this.commands.set(record.toolCallId, record.fact as ExecutionNativeCommandFact);
        if (record.kind === "file" && object(record.fact)?.version === 1)
          this.files.set(record.toolCallId, record.fact as ExecutionNativeFileFact);
        const pending = (await this.store.listPendingVerifications()).find(
          ({ ticket }) =>
            ticket.admissionId === admission.admissionId &&
            ticket.toolCallId === record.toolCallId &&
            ticket.preparedEventId === record.preparedEventId,
        );
        check();
        if (pending) this.tickets.set(record.toolCallId, pending.ticket);
        await this.settle(
          {
            id: record.toolCallId,
            name: operation.toolName,
            arguments: start.event.data.argumentsJson,
          },
          undefined,
          check,
        );
        check();
      }
      const candidates = await this.store.listExecutionLearningCandidates(
        this.options.workspaceKey,
      );
      check();
      for (const candidate of candidates) {
        if (
          candidate.claim.admission.admissionId === admission.admissionId &&
          candidate.state === "waiting"
        )
          await this.enqueue(candidate, "reflect", undefined, check);
      }
      this.wake();
    });
  }
}

function sameSourceTarget(a: ExecutionLearningTarget, b: ExecutionLearningTarget): boolean {
  return (
    a.kind === b.kind &&
    JSON.stringify(a.argv) === JSON.stringify(b.argv) &&
    JSON.stringify(a.entryFiles) === JSON.stringify(b.entryFiles)
  );
}
function nativeResultSequence(record: NativeFact): number {
  const fact = record.fact as ExecutionNativeCommandFact & ExecutionNativeFileFact;
  return fact.resultSequence ?? fact.result?.resultSequence ?? 0;
}
function safeFileContent(content: string | undefined): string | undefined {
  if (content === undefined || [...content].length > 800) return undefined;
  const safety = sanitizeMemoryContent({ title: "配置内容", content, reason: "原生文件提交" });
  return safety.disposition === "allow" ? content : undefined;
}
