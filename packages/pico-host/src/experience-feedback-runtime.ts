import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isForegroundProcessFacts,
  type ExecutionAcceptanceClaim,
  type ExecutionConditionObservation,
  type ExecutionLearningTarget,
  type ExperienceLedgerStore,
  type ExperienceSourceVersion,
  type ExperienceUse,
  type MemoryItemRecord,
  type MemoryItemSource,
  type RuntimeEvent,
  type RuntimeToolStartedEvent,
  type TaskExperienceCandidate,
  type TaskExperienceObservation,
  type TaskExperienceReuse,
  type TaskExperienceTask,
  type ToolCall,
  type ToolResultEnvelope,
} from "@pico/core";
import { raceWithDeadlineReject } from "@pico/runtime/deadline";
import type { PreparedMemoryRecallDiagnostic } from "@pico/runtime";
import type { AtomicMemoryContextResult } from "@pico/runtime/atomic-memory/context-builder";
import type { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import {
  canonicalTaskArguments,
  validateCanonicalTaskExperienceSource,
} from "./task-experience-runtime.js";
import {
  instrumentCommand,
  observeExecutionConditions,
  readExecutionTestReport,
  resolveExecutionLearningTarget,
  type ExecutionEvidenceIO,
} from "./execution-learning-evidence.js";
import { currentExecutionRunner } from "./execution-learning-runner.js";
import type { NativeFileCommit, NativeLearningObserver } from "./native-file-learning.js";
import type { ToolExecutionContext } from "./tool-registry-contract.js";
import { spreadsheetTargetFromGoal, taskInputArtifactIds } from "./task-experience-validation.js";

type Journal = Pick<
  SqliteRuntimeEventStore,
  "readRun" | "readSessionEvent" | "readToolOperation" | "readSessionEntriesPage"
>;
type Verdict = Pick<TaskExperienceReuse, "adoption" | "validation" | "sources">;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceOf = (event: RuntimeEvent): MemoryItemSource => ({
  sessionId: event.sessionId,
  runId: event.runId,
  turnId: event.turnId,
  eventId: event.eventId,
});
export interface ExperienceFeedbackRuntimeOptions {
  readonly session: { readonly id: string; readonly runtimeEventStore?: Journal | undefined };
  readonly workspaceKey: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly store: Pick<
    SqliteMemoryItemStore,
    "readSettings" | "readItem" | "readExecutionLesson" | "taskExperiences" | "executionLearning"
  > & {
    readonly experienceLedger: ExperienceLedgerStore;
  };
  readonly currentTask: () => TaskExperienceTask | undefined;
  readonly referenceGate: () => Promise<{ readonly allowed: boolean }>;
  readonly effectGate: () => Promise<{ readonly allowed: boolean }>;
  readonly nativeGate: () => Promise<{ readonly allowed: boolean }>;
  readonly io: ExecutionEvidenceIO;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly existingPreparedCommand?: (
    call: ToolCall,
  ) => { readonly target: ExecutionLearningTarget; readonly reportPath?: string } | undefined;
  readonly validateReviewed: (input: {
    readonly candidate: TaskExperienceCandidate;
    readonly task: TaskExperienceTask;
    readonly observation: TaskExperienceObservation;
    readonly event: RuntimeEvent;
    readonly start?: RuntimeToolStartedEvent;
  }) => Promise<Verdict>;
  readonly onDiagnostic?: (input: {
    readonly phase: string;
    readonly reason: string;
    readonly useId?: string;
  }) => void;
  readonly onChanged?: () => void;
}
interface NativePrepared {
  readonly argumentsJson: string;
  readonly target: ExecutionLearningTarget;
  readonly reportPath?: string;
}
interface NativeUsePreparation {
  readonly preparedEventId: string;
  readonly argumentsJson: string;
  readonly before: ExecutionConditionObservation;
}

/** Current uses and outcomes are independent of the proposal/model lifecycle. */
export class ExperienceFeedbackRuntime implements NativeLearningObserver {
  private runId = "";
  private readonly uses = new Map<string, ExperienceUse>();
  private readonly nativePrepared = new Map<string, NativePrepared>();
  private readonly nativeUses = new Map<string, NativeUsePreparation>();
  constructor(private readonly options: ExperienceFeedbackRuntimeOptions) {}

  admit(runId: string): void {
    this.runId = runId.startsWith("fork-bootstrap:") ? "" : runId;
    this.uses.clear();
    this.nativePrepared.clear();
    this.nativeUses.clear();
  }

  private async bounded<T>(
    phase: string,
    fallback: T,
    work: (check: () => void) => Promise<T>,
  ): Promise<T> {
    let active = true;
    const deadline = performance.now() + 100;
    const check = () => {
      if (!active || performance.now() > deadline) throw new Error("experience_feedback_deadline");
    };
    try {
      return await raceWithDeadlineReject(
        work(check),
        100,
        () => new Error("experience_feedback_deadline"),
      );
    } catch (error) {
      try {
        const reason =
          error instanceof Error &&
          [
            "experience_feedback_deadline",
            "experience_use_budget",
            "native_preparation_budget",
            "native_condition_budget",
          ].includes(error.message)
            ? error.message
            : "experience_feedback_unavailable";
        this.reportDiagnostic(phase, reason);
      } catch {
        /* diagnostics do not control the foreground */
      }
      return fallback;
    } finally {
      active = false;
    }
  }

  private reportDiagnostic(phase: string, reason: string, useId?: string): void {
    try {
      this.options.onDiagnostic?.({ phase, reason, ...(useId ? { useId } : {}) });
    } catch {
      /* diagnostics do not control the foreground */
    }
  }

  private async allowed(
    gate: ExperienceFeedbackRuntimeOptions["referenceGate"],
    check: () => void,
    requireRecall = true,
  ): Promise<boolean> {
    if (!this.runId || !this.options.session.runtimeEventStore || !(await gate()).allowed)
      return false;
    const settings = await this.options.store.readSettings(this.options.workspaceKey);
    check();
    return settings.enabled && (!requireRecall || settings.recallEnabled);
  }

  async recordReferences(
    result: AtomicMemoryContextResult,
    recallEventId: string | undefined,
  ): Promise<void> {
    await this.bounded("reference", undefined, async (check) => {
      const events = this.options.session.runtimeEventStore;
      const task = this.options.currentTask();
      if (
        !events ||
        !task ||
        !recallEventId ||
        !(await this.allowed(this.options.referenceGate, check))
      )
        return;
      const recall = await events.readSessionEvent(this.options.session.id, recallEventId);
      check();
      if (
        recall?.event.kind !== "memory.recall.recorded" ||
        recall.event.runId !== this.runId ||
        recall.event.data.workspaceKey !== this.options.workspaceKey
      )
        return;
      const fence = await this.options.store.experienceLedger.readExperienceFence(
        this.options.workspaceKey,
      );
      check();
      for (const selected of recall.event.data.selected) {
        if (this.uses.size >= 128) throw new Error("experience_use_budget");
        if (
          !["reviewed-reference", "execution-validated", "execution-evidence"].includes(
            selected.source,
          )
        )
          continue;
        const record = result.items.find((entry) => entry.item.itemId === selected.itemId);
        const reference = [...result.block.matchAll(/<memory\b[^>]*>[\s\S]*?<\/memory>/gu)]
          .map((match) => match[0])
          .find(
            (fragment) =>
              createHash("sha256").update(fragment).digest("hex") === selected.referenceHash,
          );
        if (
          !record ||
          !reference ||
          record.item.version !== selected.itemVersion ||
          record.item.contentHash !== selected.contentHash
        )
          continue;
        const source = await this.sourceVersion(record, check);
        if (
          !source ||
          source.kind !== selected.source ||
          (await this.options.store.experienceLedger.isExperienceExcluded({
            workspaceKey: this.options.workspaceKey,
            itemId: selected.itemId,
            taskId: task.taskId,
            taskVersion: task.taskVersion,
          }))
        )
          continue;
        check();
        const now = Date.now();
        const use: ExperienceUse = {
          useId: `experience-use:${hash([this.options.workspaceKey, this.options.session.id, this.runId, recallEventId, selected.itemId, selected.referenceHash])}`,
          workspaceKey: this.options.workspaceKey,
          source,
          itemId: selected.itemId,
          itemVersion: selected.itemVersion,
          contentHash: selected.contentHash,
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          sessionId: this.options.session.id,
          runId: this.runId,
          hostRunId: task.runId,
          referenceHash: selected.referenceHash,
          referenceContent: reference,
          recallEventId,
          recallSequence: recall.sequence,
          delivery: "pending",
          historical: false,
          ...fence,
          adoption: "unknown",
          validation: "unknown",
          validationScope: "unknown",
          excluded: false,
          deleted: false,
          sources: [],
          createdAt: now,
          updatedAt: now,
        };
        await this.options.store.experienceLedger.recordExperienceUse(use);
        check();
        this.uses.set(use.useId, use);
      }
      this.options.onChanged?.();
    });
  }

  private async sourceVersion(
    record: MemoryItemRecord,
    check: () => void,
  ): Promise<ExperienceSourceVersion | undefined> {
    if (record.taskExperience && record.sourceType === "reviewed-reference") {
      const summary = record.taskExperience;
      const candidate = await this.options.store.taskExperiences.readTaskExperienceCandidate(
        summary.candidateId,
      );
      check();
      return candidate?.review === "approved" &&
        candidate.enabled &&
        candidate.contentVersion === summary.contentVersion &&
        candidate.itemId === record.item.itemId
        ? {
            kind: "reviewed-reference",
            candidateId: candidate.candidateId,
            contentVersion: candidate.contentVersion,
          }
        : undefined;
    }
    if (record.taskAcceptance && record.sourceType === "execution-validated") {
      const acceptance = record.taskAcceptance;
      const candidate = await this.options.store.executionLearning.readExecutionLearningCandidate(
        acceptance.candidateId,
      );
      check();
      return candidate?.state === "saved" &&
        candidate.itemId === record.item.itemId &&
        candidate.claim.claimHash === acceptance.claimHash &&
        candidate.claim.target.scopeHash === acceptance.scopeHash
        ? {
            kind: "execution-validated",
            candidateId: acceptance.candidateId,
            claimRevision: candidate.claim.revision,
            claimHash: acceptance.claimHash,
            scopeHash: acceptance.scopeHash,
          }
        : undefined;
    }
    if (record.executionEvidence) {
      const candidate = await this.options.store.readExecutionLesson(
        record.executionEvidence.candidateId,
      );
      check();
      return candidate?.state === "confirmed" && candidate.itemId === record.item.itemId
        ? {
            kind: "execution-evidence",
            candidateId: candidate.candidateId,
            candidateVersion: candidate.version,
            contentHash: record.item.contentHash,
          }
        : undefined;
    }
    return undefined;
  }

  async dispatched(input: {
    readonly providerCallId: string;
    readonly physicalAttemptId: string;
    readonly runId: string;
    readonly diagnostic: PreparedMemoryRecallDiagnostic;
  }): Promise<void> {
    await this.bounded("delivery", undefined, async (check) => {
      const events = this.options.session.runtimeEventStore;
      if (
        !events ||
        input.runId !== this.runId ||
        !(await this.allowed(this.options.referenceGate, check))
      )
        return;
      const run = await events.readRun(this.options.session.id, this.runId);
      check();
      const started = run.filter(
        (event) =>
          event.kind === "model.call.started" && event.data.providerCallId === input.providerCallId,
      );
      if (started.length !== 1) return;
      const entry = await events.readSessionEvent(this.options.session.id, started[0]!.eventId);
      check();
      if (entry?.event.kind !== "model.call.started") return;
      const fence = await this.options.store.experienceLedger.readExperienceFence(
        this.options.workspaceKey,
      );
      check();
      for (const use of this.uses.values()) {
        if (
          use.settingsVersion !== fence.settingsVersion ||
          use.managementRevision !== fence.managementRevision ||
          use.deletionRevision !== fence.deletionRevision
        )
          continue;
        const recall = input.diagnostic.recalls.find(
          (entry) => entry.recallEventId === use.recallEventId,
        );
        if (
          !recall?.references.some(
            (entry) =>
              entry.itemId === use.itemId &&
              entry.referenceHash === use.referenceHash &&
              entry.present,
          ) ||
          !entry.event.data.recallEventIds?.includes(use.recallEventId!)
        )
          continue;
        await this.options.store.experienceLedger.deliverExperienceUse({
          useId: use.useId,
          providerCallId: input.providerCallId,
          physicalAttemptId: input.physicalAttemptId,
          deliverySequence: entry.sequence,
          now: Date.now(),
        });
        check();
      }
      this.options.onChanged?.();
    });
  }

  private guardedEvidenceIO(check: () => void): ExecutionEvidenceIO {
    return {
      realpath: async (path) =>
        (await this.allowed(this.options.nativeGate, check, false))
          ? this.options.io.realpath(path)
          : undefined,
      readFile: async (path, maxBytes) =>
        (await this.allowed(this.options.nativeGate, check, false))
          ? this.options.io.readFile(path, maxBytes)
          : undefined,
    };
  }

  async prepare(call: ToolCall): Promise<ToolCall> {
    return this.bounded("native_prepare", call, async (check) => {
      if (call.name !== "bash" || !(await this.allowed(this.options.nativeGate, check, false)))
        return call;
      const uses = await this.carriedUses(check);
      if (!uses.some((use) => use.source.kind === "execution-validated")) return call;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return call;
      }
      if (typeof args?.command !== "string" || args.background === true) return call;
      const existing = this.options.existingPreparedCommand?.(call);
      const target =
        existing?.target ??
        (await resolveExecutionLearningTarget(
          args.command,
          this.options.workDir,
          this.guardedEvidenceIO(check),
        ));
      check();
      if (!target) return call;
      let matches = false;
      for (const use of uses) {
        const claim = await this.currentClaim(use, check);
        if (claim && sameTarget(claim, target)) {
          matches = true;
          break;
        }
      }
      if (!matches) return call;
      let finalCall = call;
      let reportPath = existing?.reportPath;
      if (target.kind === "node-test" && !reportPath) {
        const reportDirectory = join(
          this.options.picoHome,
          "sandboxes",
          this.options.session.id,
          "experience-feedback",
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
      if (this.nativePrepared.size >= 128) throw new Error("native_preparation_budget");
      this.nativePrepared.set(call.id, {
        argumentsJson: finalCall.arguments,
        target,
        ...(reportPath ? { reportPath } : {}),
      });
      return finalCall;
    });
  }

  async beforeDispatch(call: ToolCall, context: ToolExecutionContext): Promise<void> {
    await this.bounded("native_conditions", undefined, async (check) => {
      const events = this.options.session.runtimeEventStore;
      const prepared = this.nativePrepared.get(call.id);
      if (
        !events ||
        !prepared ||
        call.arguments !== prepared.argumentsJson ||
        context.signal?.aborted ||
        !(await this.allowed(this.options.nativeGate, check, false))
      )
        return;
      const operation = await events.readToolOperation(
        this.options.session.id,
        this.runId,
        call.id,
      );
      const entry =
        operation &&
        (await events.readSessionEvent(this.options.session.id, operation.preparedEventId));
      check();
      if (
        operation?.state !== "prepared" ||
        entry?.event.kind !== "tool.started" ||
        entry.event.data.argumentsJson !== call.arguments ||
        entry.event.data.argumentsRedacted ||
        entry.event.partial
      )
        return;
      const current = await resolveExecutionLearningTarget(
        prepared.target.command,
        prepared.target.cwd,
        this.guardedEvidenceIO(check),
      );
      check();
      if (current?.scopeHash !== prepared.target.scopeHash) return;
      for (const use of await this.carriedUses(check)) {
        if (use.deliverySequence === undefined || entry.sequence <= use.deliverySequence) continue;
        const claim = await this.currentClaim(use, check);
        if (!claim || !sameTarget(claim, prepared.target)) continue;
        if (claim.predicateId === "test-target-pass.v1") {
          if (!(await this.allowed(this.options.nativeGate, check, false))) continue;
          const runner = await currentExecutionRunner(
            claim.target.argv[0]!,
            claim.target.cwd,
            this.options.env,
          );
          check();
          if (
            !claim.runner?.fingerprint ||
            runner?.execPath !== claim.runner.execPath ||
            runner.fingerprint !== claim.runner.fingerprint
          )
            continue;
        }
        const before = await observeExecutionConditions(
          claim.conditions,
          this.guardedEvidenceIO(check),
        );
        check();
        if (!before.complete || !before.matches) continue;
        if (this.nativeUses.size >= 512) throw new Error("native_condition_budget");
        this.nativeUses.set(`${call.id}:${use.useId}`, {
          preparedEventId: operation.preparedEventId,
          argumentsJson: call.arguments,
          before,
        });
      }
    });
  }

  async fileCommitted(_call: ToolCall, _fact: NativeFileCommit): Promise<void> {}

  private async currentClaim(
    use: ExperienceUse,
    check: () => void,
  ): Promise<ExecutionAcceptanceClaim | undefined> {
    if (use.source.kind !== "execution-validated") return undefined;
    const source = use.source;
    const candidate = await this.options.store.executionLearning.readExecutionLearningCandidate(
      source.candidateId,
    );
    check();
    return candidate?.state === "saved" &&
      candidate.itemId === use.itemId &&
      candidate.claim.revision === source.claimRevision &&
      candidate.claim.claimHash === source.claimHash &&
      candidate.claim.target.scopeHash === source.scopeHash
      ? candidate.claim
      : undefined;
  }

  private async carriedUses(check: () => void): Promise<ExperienceUse[]> {
    const task = this.options.currentTask();
    if (!task) return [];
    const result: ExperienceUse[] = [];
    for (const id of this.uses.keys()) {
      const use = await this.options.store.experienceLedger.readExperienceUse(id);
      check();
      if (
        use?.delivery === "carried" &&
        !use.historical &&
        !use.excluded &&
        !use.deleted &&
        use.runId === this.runId &&
        use.taskId === task.taskId &&
        use.taskVersion === task.taskVersion
      )
        result.push(use);
    }
    return result;
  }

  async committed(call: ToolCall, _result?: ToolResultEnvelope): Promise<void> {
    await this.bounded("effect", undefined, async (check) => {
      const events = this.options.session.runtimeEventStore;
      const task = this.options.currentTask();
      if (!events || !task || !(await this.allowed(this.options.effectGate, check, false))) return;
      const operation = await events.readToolOperation(
        this.options.session.id,
        this.runId,
        call.id,
      );
      const outcome =
        operation?.outcomeEventId &&
        (await events.readSessionEvent(this.options.session.id, operation.outcomeEventId));
      check();
      if (!outcome || outcome.event.kind !== "tool.result.recorded") return;
      const canonical = await validateCanonicalTaskExperienceSource(
        events,
        sourceOf(outcome.event),
        { workDir: this.options.workDir },
      );
      check();
      if (
        !canonical?.start ||
        canonical.event.kind !== "tool.result.recorded" ||
        canonical.event.partial ||
        canonical.event.data.recovery ||
        !canonicalTaskArguments(canonical.start)
      )
        return;
      const prepared = await events.readSessionEvent(
        this.options.session.id,
        canonical.start.eventId,
      );
      check();
      if (!prepared || prepared.sequence >= outcome.sequence) return;
      for (const use of await this.carriedUses(check)) {
        if (use.deliverySequence === undefined || prepared.sequence <= use.deliverySequence)
          continue;
        const item = await this.options.store.readItem(use.itemId);
        check();
        if (
          !item ||
          item.item.version !== use.itemVersion ||
          item.item.contentHash !== use.contentHash ||
          item.item.lifecycleState !== "active"
        )
          continue;
        let verdict: Verdict = {
          adoption: "unknown",
          validation: "unknown",
          sources: [sourceOf(outcome.event)],
        };
        let scope: ExperienceUse["validationScope"] = "unknown";
        let reason = "reference_only";
        let contradiction = false;
        if (use.source.kind === "reviewed-reference") {
          const args = canonicalTaskArguments(canonical.start);
          if (
            outcome.event.data.toolName !== "document" ||
            args?.action !== "analyze" ||
            args.operation !== "sum"
          )
            continue;
          const candidate = await this.options.store.taskExperiences.readTaskExperienceCandidate(
            use.source.candidateId,
          );
          check();
          if (
            !candidate ||
            !candidate.applicability.spreadsheet ||
            candidate.contentVersion !== use.source.contentVersion ||
            candidate.review !== "approved" ||
            !candidate.enabled
          )
            continue;
          const target = spreadsheetTargetFromGoal(task.goal);
          const normalizedRange =
            typeof args.range === "string"
              ? args.range.replaceAll("$", "").toUpperCase()
              : undefined;
          if (
            !target ||
            args.sheet !== target.sheet ||
            normalizedRange !== target.range ||
            typeof args.column !== "string" ||
            args.column.toUpperCase() !== target.column
          )
            continue;
          const input = await events.readSessionEvent(
            task.goalSource.sessionId,
            task.goalSource.eventId,
          );
          check();
          if (
            input?.event.kind !== "message.committed" ||
            input.event.data.message.role !== "user" ||
            typeof args.artifact_id !== "string"
          )
            continue;
          let artifactId = args.artifact_id;
          try {
            if (artifactId.startsWith("pico://artifact/"))
              artifactId = decodeURIComponent(artifactId.slice("pico://artifact/".length));
          } catch {
            continue;
          }
          const userArtifacts = taskInputArtifactIds(input.event.data.message);
          if (!userArtifacts.includes(artifactId)) continue;
          const observation: TaskExperienceObservation = {
            observationId: `experience-effect-observation:${hash([use.useId, outcome.event.eventId])}`,
            taskId: task.taskId,
            taskVersion: task.taskVersion,
            source: sourceOf(outcome.event),
            sequence: outcome.sequence,
            kind: "tool-result",
            summary: "",
            status: outcome.event.data.status,
            toolName: outcome.event.data.toolName,
            preparedEventId: prepared.event.eventId,
            coverage: "complete",
            createdAt: Date.parse(outcome.event.at),
          };
          reason = "spreadsheet_result_unproven";
          try {
            verdict = await this.options.validateReviewed({
              candidate,
              task,
              observation,
              event: outcome.event,
              start: canonical.start,
            });
          } catch {
            reason = "experience_validation_unavailable";
            this.reportDiagnostic("effect", reason, use.useId);
          }
          check();
          if (verdict.adoption === "observed") {
            scope = "spreadsheet-range";
            reason = "host_spreadsheet_verification";
            contradiction = verdict.validation === "fail";
          } else if (verdict.adoption === "not_applied") reason = "spreadsheet_method_not_applied";
        } else if (use.source.kind === "execution-validated") {
          if (!(await this.allowed(this.options.nativeGate, check, false))) continue;
          const preparedNative = this.nativePrepared.get(call.id);
          const claim = await this.currentClaim(use, check);
          if (!preparedNative || !claim || !sameTarget(claim, preparedNative.target)) continue;
          try {
            const native = await this.nativeVerdict(
              use,
              call,
              canonical.start,
              outcome.event,
              check,
            );
            verdict = native.verdict;
            contradiction = native.contradiction;
            scope = native.scope;
            reason = native.reason;
          } catch {
            reason = "experience_validation_unavailable";
            this.reportDiagnostic("effect", reason, use.useId);
          }
        } else continue;
        if (!verdict.sources.some((source) => source.eventId === outcome.event.eventId))
          verdict = { ...verdict, sources: [...verdict.sources, sourceOf(outcome.event)] };
        check();
        if (!(await this.allowed(this.options.effectGate, check, false))) continue;
        if (
          use.source.kind === "execution-validated" &&
          !(await this.allowed(this.options.nativeGate, check, false))
        )
          continue;
        check();
        await this.options.store.experienceLedger.appendExperienceEffect(
          {
            effectId: `experience-effect:${hash([use.useId, prepared.event.eventId, outcome.event.eventId])}`,
            useId: use.useId,
            preparedEventId: prepared.event.eventId,
            outcomeEventId: outcome.event.eventId,
            preparedSequence: prepared.sequence,
            outcomeSequence: outcome.sequence,
            ...verdict,
            validationScope: scope,
            reason,
            trustedContradiction: contradiction,
            createdAt: Date.now(),
          },
          { allowStateChange: verdict.adoption === "observed" },
        );
        check();
      }
      this.options.onChanged?.();
    });
  }

  private async nativeVerdict(
    use: ExperienceUse,
    call: ToolCall,
    start: RuntimeToolStartedEvent,
    event: RuntimeEvent,
    check: () => void,
  ): Promise<{
    verdict: Verdict;
    scope: ExperienceUse["validationScope"];
    reason: string;
    contradiction: boolean;
  }> {
    const unknown = {
      verdict: {
        adoption: "unknown",
        validation: "unknown",
        sources: [sourceOf(event)],
      } as Verdict,
      scope: "unknown" as const,
      reason: "native_scope_unproven",
      contradiction: false,
    };
    const native = this.nativePrepared.get(call.id);
    const ticket = this.nativeUses.get(`${call.id}:${use.useId}`);
    const claim = await this.currentClaim(use, check);
    if (
      !native ||
      !ticket ||
      !claim ||
      ticket.preparedEventId !== start.eventId ||
      ticket.argumentsJson !== start.data.argumentsJson ||
      !sameTarget(claim, native.target) ||
      event.kind !== "tool.result.recorded"
    )
      return unknown;
    const facts = event.data.executionFacts;
    if (
      !isForegroundProcessFacts(facts) ||
      facts.exitCode === null ||
      facts.terminationSignal !== null ||
      facts.timedOut ||
      facts.outputIncomplete ||
      facts.spawnFailed
    )
      return unknown;
    const current = await resolveExecutionLearningTarget(
      claim.target.command,
      claim.target.cwd,
      this.guardedEvidenceIO(check),
    );
    const after = await observeExecutionConditions(claim.conditions, this.guardedEvidenceIO(check));
    check();
    if (
      current?.scopeHash !== claim.target.scopeHash ||
      !after.complete ||
      !after.matches ||
      ticket.before.fingerprint !== after.fingerprint
    )
      return unknown;
    if (claim.predicateId !== "test-target-pass.v1") return unknown;
    if (!native.reportPath || !claim.runner?.fingerprint || !claim.failedTestIds.length)
      return unknown;
    const report = await readExecutionTestReport(native.reportPath, this.guardedEvidenceIO(check));
    if (!(await this.allowed(this.options.nativeGate, check, false))) return unknown;
    const runner = await currentExecutionRunner(
      claim.target.argv[0]!,
      claim.target.cwd,
      this.options.env,
    );
    check();
    if (
      !report.complete ||
      report.runner?.execPath !== claim.runner.execPath ||
      report.runner.version !== claim.runner.version ||
      report.runner.fingerprint !== claim.runner.fingerprint ||
      runner?.execPath !== claim.runner.execPath ||
      runner.fingerprint !== claim.runner.fingerprint
    )
      return unknown;
    const contradicted = claim.failedTestIds.some((id) => report.failed.includes(id));
    const accepted =
      facts.exitCode === 0 &&
      report.success &&
      !report.failed.length &&
      !report.skipped.length &&
      claim.failedTestIds.every((id) => report.passed.includes(id));
    if (!accepted && !contradicted) return unknown;
    return {
      verdict: {
        adoption: "observed",
        validation: accepted ? "pass" : "fail",
        sources: [sourceOf(event)],
      },
      scope: "native-claim",
      reason: accepted ? "original_tests_passed" : "original_tests_contradicted",
      contradiction: contradicted,
    };
  }
}
function sameTarget(claim: ExecutionAcceptanceClaim, target: ExecutionLearningTarget): boolean {
  return claim.target.targetId === target.targetId && claim.target.scopeHash === target.scopeHash;
}
