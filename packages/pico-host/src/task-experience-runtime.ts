import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  isMessageHiddenFromTranscript,
  isForegroundProcessFacts,
  type ExecutionLearningStore,
  type MemoryItemSource,
  type RuntimeEvent,
  type RuntimeToolStartedEvent,
  type TaskExperienceCandidate,
  type TaskExperienceObservation,
  type TaskExperienceReuse,
  type TaskExperienceStore,
  type TaskExperienceTask,
} from "@pico/core";
import type { AtomicMemoryStore } from "@pico/core/atomic-memory-runtime-contracts";
import { memoryTextContainsSecret } from "@pico/runtime/atomic-memory/extraction-evidence";
import { redactSensitiveText } from "@pico/runtime/sensitive-data-redaction";
import { raceWithDeadlineReject } from "@pico/runtime/deadline";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";

type Journal = Pick<
  SqliteRuntimeEventStore,
  "readSessionEntriesPage" | "readSessionEvent" | "readToolOperation" | "readRun"
>;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const sourceOf = (event: RuntimeEvent): MemoryItemSource => ({
  sessionId: event.sessionId,
  runId: event.runId,
  turnId: event.turnId,
  eventId: event.eventId,
});
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function canonicalTaskArguments(
  start: RuntimeToolStartedEvent | undefined,
): Record<string, unknown> | undefined {
  if (
    !start ||
    start.partial ||
    start.data.argumentsRedacted ||
    memoryTextContainsSecret(start.data.argumentsJson)
  )
    return undefined;
  try {
    return object(JSON.parse(start.data.argumentsJson));
  } catch {
    return undefined;
  }
}

/** Source authenticity is separate from business-method validation and accepts input evidence IDs. */
export async function validateCanonicalTaskExperienceSource(
  events: Journal,
  source: MemoryItemSource,
  options: { readonly workDir?: string } = {},
): Promise<
  | {
      readonly event: RuntimeEvent;
      readonly sequence: number;
      readonly start?: RuntimeToolStartedEvent;
    }
  | undefined
> {
  if (source.runId.startsWith("fork-bootstrap:")) return undefined;
  const entry = await events.readSessionEvent(source.sessionId, source.eventId);
  const event = entry?.event;
  if (
    !entry ||
    !event ||
    event.sessionId !== source.sessionId ||
    event.runId !== source.runId ||
    event.turnId !== source.turnId
  )
    return undefined;
  const run = await events.readRun(source.sessionId, source.runId);
  const starts = run.filter((item) => item.kind === "run.started");
  if (
    starts.length !== 1 ||
    starts[0]?.kind !== "run.started" ||
    (options.workDir && resolve(starts[0].data.workDir) !== resolve(options.workDir))
  )
    return undefined;
  if (event.kind === "message.committed") {
    if (
      event.partial ||
      event.data.message.role !== "user" ||
      event.data.message.toolCallId ||
      isMessageHiddenFromTranscript(event.data.message)
    )
      return undefined;
  } else if (event.kind === "tool.result.recorded") {
    const operation = await events.readToolOperation(
      source.sessionId,
      source.runId,
      event.refs.toolCallId,
    );
    if (!operation || operation.state !== "settled" || operation.outcomeEventId !== source.eventId)
      return undefined;
    const prepared = await events.readSessionEvent(source.sessionId, operation.preparedEventId);
    const start = prepared?.event;
    if (
      !prepared ||
      start?.kind !== "tool.started" ||
      start.sessionId !== event.sessionId ||
      start.runId !== event.runId ||
      start.turnId !== event.turnId ||
      start.invocationId !== event.invocationId ||
      start.refs?.toolCallId !== operation.toolCallId ||
      start.data.toolName !== event.data.toolName ||
      start.data.toolName !== operation.toolName ||
      start.data.argumentsHash !== operation.argumentsHash ||
      textHash(start.data.argumentsJson) !== operation.argumentsHash ||
      prepared.sequence >= entry.sequence
    )
      return undefined;
    return { event, sequence: entry.sequence, start };
  } else if (event.kind !== "run.terminal" || event.partial) return undefined;
  return { event, sequence: entry.sequence };
}

export interface TaskExperienceRuntimeOptions {
  readonly session: { readonly id: string; readonly runtimeEventStore?: Journal | undefined };
  readonly workspaceKey: string;
  readonly workDir: string;
  readonly hostRunId?: string;
  readonly store: Pick<AtomicMemoryStore, "readSettings" | "readDeletionRevision"> & {
    readonly taskExperiences: TaskExperienceStore;
    readonly executionLearning: Pick<
      ExecutionLearningStore,
      "readExecutionLearningInputEpoch" | "enqueueExecutionLearningJob"
    >;
  };
  /** Identity/reference gate is independent of generating new proposals. */
  readonly gate: () => Promise<{ readonly allowed: boolean }>;
  readonly proposalGate?: () => Promise<{ readonly allowed: boolean }>;
  readonly worker: { wake(): void };
  readonly modelRoute?: TaskExperienceCandidate["modelRoute"];
  readonly goalIdentity?: () =>
    | { readonly goalId: string; readonly goalRevision: number }
    | undefined;
  readonly onChanged?: () => void;
  readonly onDiagnostic?: (diagnostic: {
    readonly phase: string;
    readonly reason: string;
    readonly throughSequence: number;
  }) => void;
  readonly validateReuse?: (input: {
    readonly candidate: TaskExperienceCandidate;
    readonly task: TaskExperienceTask;
    readonly observation: TaskExperienceObservation;
    readonly event: RuntimeEvent;
    readonly start?: RuntimeToolStartedEvent;
  }) => Promise<Pick<TaskExperienceReuse, "adoption" | "validation" | "sources">>;
}

/** Canonical journal remains the foreground authority. This bounded projection is cursor-recoverable. */
export class TaskExperienceRuntime {
  private task: TaskExperienceTask | undefined;
  private cursor = 0;
  private runId = "";
  private currentInputEventId: string | undefined;
  private inputEpoch = 0;
  private settingsVersion = 0;
  private deletionRevision = 0;
  private inFlight: Promise<void> | undefined;
  constructor(private readonly options: TaskExperienceRuntimeOptions) {}

  async admit(runId: string): Promise<void> {
    this.runId = runId;
    await this.bounded("admit", async (check) => {
      if (!(await this.allowed(check)) || runId.startsWith("fork-bootstrap:")) return;
      if (this.options.hostRunId && this.options.session.runtimeEventStore) {
        const run = await this.options.session.runtimeEventStore.readRun(
          this.options.session.id,
          runId,
        );
        check();
        const starts = run.filter((event) => event.kind === "run.started");
        if (
          starts.length !== 1 ||
          starts[0]?.kind !== "run.started" ||
          starts[0].sessionId !== this.options.session.id ||
          resolve(starts[0].data.workDir) !== resolve(this.options.workDir)
        )
          throw new Error("canonical_run_binding_unavailable");
        const existing = await this.options.store.taskExperiences.readTaskExperienceRunBinding?.(
          this.options.workspaceKey,
          this.options.session.id,
          runId,
        );
        check();
        if (existing && existing.hostRunId !== this.options.hostRunId)
          throw new Error("host_run_binding_conflict");
        if (!existing) {
          await this.options.store.taskExperiences.saveTaskExperienceRunBinding?.({
            workspaceKey: this.options.workspaceKey,
            sessionId: this.options.session.id,
            executionRunId: runId,
            hostRunId: this.options.hostRunId,
            createdAt: Date.now(),
          });
          check();
        }
      }
      const settings = await this.options.store.readSettings(this.options.workspaceKey);
      const deletionRevision = await this.options.store.readDeletionRevision();
      check();
      if (!settings.enabled) return;
      const inputEpoch = await this.options.store.executionLearning.readExecutionLearningInputEpoch(
        this.options.workspaceKey,
      );
      check();
      this.inputEpoch = inputEpoch;
      this.settingsVersion = settings.version;
      this.deletionRevision = deletionRevision;
      this.task = await this.options.store.taskExperiences.latestTaskExperienceTask(
        this.options.workspaceKey,
        this.options.session.id,
      );
      check();
      this.cursor = this.task?.throughSequence ?? 0;
    });
  }

  async capture(currentInputEventId?: string): Promise<void> {
    if (currentInputEventId) this.currentInputEventId = currentInputEventId;
    if (this.inFlight) return this.inFlight;
    const task = this.bounded("capture", (check) => this.collect(check));
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) this.inFlight = undefined;
    }
  }

  async completed(runId: string): Promise<void> {
    if (runId !== this.runId) return;
    await this.capture();
    this.options.worker.wake();
  }

  /** Only the task bound to this admitted canonical execution can scope recall feedback. */
  currentTaskIdentity():
    | Pick<TaskExperienceTask, "taskId" | "taskVersion" | "sessionId" | "runId">
    | undefined {
    const task = this.task;
    return task && (task.executionRunId ?? task.runId) === this.runId
      ? {
          taskId: task.taskId,
          taskVersion: task.taskVersion,
          sessionId: task.sessionId,
          runId: task.runId,
        }
      : undefined;
  }

  private async allowed(check: () => void): Promise<boolean> {
    const gate = await this.options.gate();
    check();
    if (!gate.allowed || !this.options.session.runtimeEventStore) return false;
    const settings = await this.options.store.readSettings(this.options.workspaceKey);
    check();
    return settings.enabled;
  }

  currentTaskSnapshot(): TaskExperienceTask | undefined {
    return this.currentTaskIdentity() && this.task ? structuredClone(this.task) : undefined;
  }

  private async proposalAllowed(check: () => void): Promise<boolean> {
    if (this.options.proposalGate && !(await this.options.proposalGate()).allowed) return false;
    const settings = await this.options.store.readSettings(this.options.workspaceKey);
    const deletion = await this.options.store.readDeletionRevision();
    check();
    return (
      settings.enabled &&
      settings.autoExtract &&
      settings.version === this.settingsVersion &&
      deletion === this.deletionRevision
    );
  }

  private async bounded(phase: string, work: (check: () => void) => Promise<void>): Promise<void> {
    let active = true;
    const deadline = performance.now() + 100;
    const check = () => {
      if (!active || performance.now() > deadline) throw new Error("collection_deadline");
    };
    try {
      await raceWithDeadlineReject(work(check), 100, () => new Error("collection_deadline"));
    } catch (error) {
      try {
        this.options.onDiagnostic?.({
          phase,
          reason:
            error instanceof Error &&
            [
              "collection_deadline",
              "canonical_run_binding_unavailable",
              "host_run_binding_conflict",
            ].includes(error.message)
              ? error.message
              : "task_experience_collection_unavailable",
          throughSequence: this.cursor,
        });
      } catch {
        /* optional diagnostics */
      }
    } finally {
      active = false;
    }
  }

  private async collect(check: () => void): Promise<void> {
    const events = this.options.session.runtimeEventStore;
    if (!events || !this.runId || !(await this.allowed(check))) return;
    this.inputEpoch = await this.options.store.executionLearning.readExecutionLearningInputEpoch(
      this.options.workspaceKey,
    );
    check();
    // A failed/expired capture can retry from the last committed projection cursor.
    this.task = await this.options.store.taskExperiences.latestTaskExperienceTask(
      this.options.workspaceKey,
      this.options.session.id,
    );
    check();
    this.cursor = this.task?.throughSequence ?? 0;
    // Repair the loaded task before a new user message can replace its identity.
    await this.recoverTerminalCandidate(events, check);
    const inputEventId = await this.validInputIdentity(
      events,
      this.currentInputEventId,
      this.runId,
      check,
    );
    if (inputEventId) await this.bindTaskInput(events, inputEventId, this.runId, check);
    const entries = await events.readSessionEntriesPage(this.options.session.id, {
      afterSequence: this.cursor,
      limit: 250,
    });
    check();
    for (const { event, sequence } of entries) {
      check();
      // Automatic recall is a durable Host fact linking the exact user event to an engine Run.
      if (
        event.kind === "memory.recall.recorded" &&
        event.data.mode === "automatic" &&
        event.data.workspaceKey === this.options.workspaceKey &&
        event.data.queryRef?.eventId
      ) {
        await this.bindTaskInput(events, event.data.queryRef.eventId, event.runId, check);
        this.cursor = sequence;
        continue;
      }
      if (!["message.committed", "tool.result.recorded", "run.terminal"].includes(event.kind)) {
        this.cursor = sequence;
        continue;
      }
      const canonical = await validateCanonicalTaskExperienceSource(events, sourceOf(event), {
        workDir: this.options.workDir,
      });
      check();
      if (!canonical) {
        this.cursor = sequence;
        continue;
      }
      if (event.kind === "message.committed") {
        const content = userRequest(event.data.message.content);
        const sourceRunId = event.eventId === inputEventId ? this.runId : event.runId;
        const taskRunId =
          event.eventId === inputEventId ? (this.options.hostRunId ?? sourceRunId) : sourceRunId;
        const correctionIntent = correctionSignal(content);
        let correction = explicitCorrection(content) && !!this.task;
        if (correctionIntent && this.task && !correction && this.task.runId !== event.runId) {
          const previousObservations =
            await this.options.store.taskExperiences.listTaskExperienceObservations(
              this.task.taskId,
            );
          check();
          const precedingTerminal = previousObservations.findLast(
            (observation) =>
              observation.kind === "terminal" &&
              observation.taskVersion === this.task!.taskVersion &&
              observation.source.runId === (this.task!.executionRunId ?? this.task!.runId),
          );
          correction =
            !!precedingTerminal &&
            precedingTerminal.sequence < sequence &&
            sharedConcreteTarget(content, this.task.goal, previousObservations);
        }
        if (event.data.message.providerData?.["picoKind"] === "steer" && !correctionIntent) {
          this.cursor = sequence;
          continue;
        }
        const now = Date.now();
        const prior = this.task;
        const goalIdentity = this.options.goalIdentity?.();
        this.task =
          correction && prior
            ? {
                ...prior,
                taskVersion: prior.taskVersion + 1,
                runId: taskRunId,
                executionRunId: sourceRunId,
                throughSequence: sequence,
                updatedAt: now,
              }
            : {
                taskId: `task-experience-task:${hash([this.options.workspaceKey, event.sessionId, event.eventId])}`,
                taskVersion: 1,
                workspaceKey: this.options.workspaceKey,
                workDir: resolve(this.options.workDir),
                sessionId: event.sessionId,
                runId: taskRunId,
                executionRunId: sourceRunId,
                goal: boundedText(content, 1200),
                goalSource: sourceOf(event),
                ...(goalIdentity ? goalIdentity : {}),
                ...(prior ? { previousTaskId: prior.taskId } : {}),
                coverage: "complete",
                throughSequence: sequence,
                createdAt: now,
                updatedAt: now,
              };
        await this.append(
          event,
          sequence,
          {
            kind: "user-input",
            summary: boundedText(content),
            ...(correctionIntent ? { correction: true } : {}),
          },
          check,
        );
      } else if (
        this.task &&
        event.runId === (this.task.executionRunId ?? this.task.runId) &&
        (await this.proposalAllowed(check))
      ) {
        if (event.kind === "tool.result.recorded") {
          const start = canonical.start;
          const args = canonicalTaskArguments(start);
          const raw =
            event.data.body.storage === "inline"
              ? event.data.body.content
              : event.data.projection.text;
          const limited =
            event.partial || !!event.data.recovery || !args || event.data.body.storage !== "inline";
          const facts = event.data.executionFacts;
          const processFailed =
            event.data.toolName === "bash" &&
            isForegroundProcessFacts(facts) &&
            facts.exitCode !== null &&
            facts.exitCode !== 0 &&
            facts.terminationSignal === null &&
            !facts.timedOut &&
            !facts.outputIncomplete &&
            !facts.spawnFailed &&
            !limited;
          const status = processFailed ? "failed" : event.data.status;
          await this.append(
            event,
            sequence,
            {
              kind: "tool-result",
              summary: boundedText(`${event.data.toolName}: ${status}\n${raw}`),
              status,
              toolName: event.data.toolName,
              ...(start ? { preparedEventId: start.eventId } : {}),
              ...(args ? { arguments: safeArguments(args) } : {}),
              coverage: limited ? "limited" : "complete",
            },
            check,
          );
        } else if (event.kind === "run.terminal") {
          const run = await events.readRun(event.sessionId, event.runId);
          check();
          if (
            event.data.status === "completed" &&
            run.some(
              (entry) =>
                entry.kind === "message.committed" &&
                entry.data.message.providerData?.["picoKind"] === "desktop_user_input",
            ) &&
            !run.some(
              (entry) => entry.kind === "tool.started" || entry.kind === "model.call.started",
            )
          ) {
            this.cursor = sequence;
            continue;
          }
          await this.append(
            event,
            sequence,
            {
              kind: "terminal",
              summary: boundedText(`${event.data.status}: ${event.data.reason ?? ""}`),
              status: event.data.status === "completed" ? "succeeded" : event.data.status,
              coverage: event.data.recovered ? "limited" : "complete",
            },
            check,
          );
          await this.enqueue(check);
        }
      }
      this.cursor = sequence;
    }
    if (this.task && this.cursor > this.task.throughSequence) {
      const task = { ...this.task, throughSequence: this.cursor, updatedAt: Date.now() };
      await this.options.store.taskExperiences.saveTaskExperienceTask(task);
      check();
      this.task = task;
    }
    if (this.task) {
      const observations = await this.options.store.taskExperiences.listTaskExperienceObservations(
        this.task.taskId,
      );
      check();
      await this.recoverTerminalCandidate(events, check, observations);
    }
  }

  private async validInputIdentity(
    events: Journal,
    eventId: string | undefined,
    runId: string,
    check: () => void,
  ): Promise<string | undefined> {
    if (!eventId) return undefined;
    const entry = await events.readSessionEvent(this.options.session.id, eventId);
    check();
    if (entry?.event.kind !== "message.committed") return undefined;
    const canonical = await validateCanonicalTaskExperienceSource(events, sourceOf(entry.event), {
      workDir: this.options.workDir,
    });
    const run = await events.readRun(this.options.session.id, runId);
    check();
    const starts = run.filter((event) => event.kind === "run.started");
    return canonical?.event.kind === "message.committed" &&
      starts.length === 1 &&
      starts[0]?.kind === "run.started" &&
      resolve(starts[0].data.workDir) === resolve(this.options.workDir)
      ? eventId
      : undefined;
  }

  private async bindTaskInput(
    events: Journal,
    eventId: string,
    runId: string,
    check: () => void,
  ): Promise<void> {
    const task = this.task;
    const binding = await this.options.store.taskExperiences.readTaskExperienceRunBinding?.(
      this.options.workspaceKey,
      this.options.session.id,
      runId,
    );
    check();
    const hostRunId =
      binding?.hostRunId ?? (runId === this.runId ? this.options.hostRunId : undefined);
    if (
      !task ||
      ((task.executionRunId ?? task.runId) === runId && (!hostRunId || task.runId === hostRunId)) ||
      !(await this.validInputIdentity(events, eventId, runId, check))
    )
      return;
    const observations = await this.options.store.taskExperiences.listTaskExperienceObservations(
      task.taskId,
    );
    check();
    const input = observations.findLast(
      (observation) =>
        observation.kind === "user-input" && observation.taskVersion === task.taskVersion,
    );
    if (input?.source.eventId !== eventId) return;
    const bound = {
      ...task,
      runId:
        hostRunId ??
        (task.executionRunId && task.runId !== task.executionRunId ? task.runId : runId),
      executionRunId: runId,
      updatedAt: Date.now(),
    };
    await this.options.store.taskExperiences.saveTaskExperienceTask(bound);
    check();
    this.task = bound;
  }

  private async recoverTerminalCandidate(
    events: Journal,
    check: () => void,
    observations?: readonly TaskExperienceObservation[],
  ): Promise<void> {
    const task = this.task;
    if (!task) return;
    const persisted =
      observations ??
      (await this.options.store.taskExperiences.listTaskExperienceObservations(task.taskId));
    check();
    const terminal = persisted.findLast(
      (observation) =>
        observation.kind === "terminal" &&
        observation.taskVersion === task.taskVersion &&
        observation.source.runId === (task.executionRunId ?? task.runId) &&
        observation.sequence <= task.throughSequence,
    );
    if (!terminal) return;
    const canonical = await validateCanonicalTaskExperienceSource(events, terminal.source, {
      workDir: this.options.workDir,
    });
    check();
    if (canonical?.event.kind === "run.terminal") await this.enqueue(check);
  }

  private async append(
    event: RuntimeEvent,
    sequence: number,
    input: Pick<TaskExperienceObservation, "kind" | "summary"> &
      Partial<
        Pick<
          TaskExperienceObservation,
          "status" | "toolName" | "preparedEventId" | "correction" | "arguments" | "coverage"
        >
      >,
    check: () => void,
  ): Promise<TaskExperienceObservation> {
    const current = this.task!;
    const observation: TaskExperienceObservation = {
      observationId: `task-experience-observation:${hash([current.taskId, event.eventId])}`,
      taskId: current.taskId,
      taskVersion: current.taskVersion,
      source: sourceOf(event),
      sequence,
      coverage: "complete",
      ...input,
      createdAt: Date.parse(event.at),
    };
    const task: TaskExperienceTask = {
      ...current,
      throughSequence: sequence,
      coverage:
        current.coverage === "limited" || observation.coverage !== "complete"
          ? "limited"
          : "complete",
      updatedAt: Date.now(),
    };
    await this.options.store.taskExperiences.appendTaskExperienceObservations(task, [observation]);
    check();
    this.task = task;
    this.cursor = sequence;
    return observation;
  }

  private async enqueue(check: () => void): Promise<void> {
    const task = this.task;
    if (!task || explicitRemember(task.goal) || !(await this.proposalAllowed(check))) return;
    const observations = await this.options.store.taskExperiences.listTaskExperienceObservations(
      task.taskId,
    );
    check();
    const userInput = observations.findLast(
      (observation) =>
        observation.taskVersion === task.taskVersion && observation.kind === "user-input",
    );
    // Explicit long-term rules use the existing user-evidence path, including
    // corrections that retain the preceding task's original goal.
    if (userInput && explicitRemember(userInput.summary)) return;
    const trigger = observations.findLast(
      (observation) =>
        observation.taskVersion === task.taskVersion &&
        (observation.correction ||
          observation.status === "failed" ||
          observation.status === "rejected" ||
          observation.status === "interrupted"),
    );
    const recovery =
      observations.some(
        (observation) =>
          observation.taskVersion === task.taskVersion && observation.status === "succeeded",
      ) &&
      observations.some((observation) => observation.status === "failed" || observation.correction);
    if (!trigger && !recovery) return;
    const evidence = [
      ...new Map(
        [
          ...observations.filter(
            (observation) => observation.source.eventId === task.goalSource.eventId,
          ),
          ...(trigger ? [trigger] : []),
          ...observations.slice(-22),
        ].map((observation) => [observation.observationId, observation]),
      ).values(),
    ];
    const sources = evidence.map((observation) => observation.source);
    const now = Date.now();
    const failureKey = hash([
      this.options.workspaceKey,
      task.taskId,
      task.taskVersion,
      trigger?.source.eventId ?? "recovery",
    ]);
    const candidateId = `task-experience-candidate:${failureKey}`;
    const existing =
      await this.options.store.taskExperiences.readTaskExperienceCandidate(candidateId);
    check();
    if (existing && !["waiting", "insufficient"].includes(existing.state)) return;
    const candidate =
      existing ??
      (await this.options.store.taskExperiences.createTaskExperienceCandidate({
        candidateId,
        kind: "task-lesson",
        taskId: task.taskId,
        taskVersion: task.taskVersion,
        workspaceKey: this.options.workspaceKey,
        workDir: task.workDir,
        sessionId: task.sessionId,
        runId: task.runId,
        failureKey,
        inputEpoch: this.inputEpoch,
        settingsVersion: this.settingsVersion,
        deletionRevision: this.deletionRevision,
        state: "waiting",
        goal: task.goal,
        content: "",
        contentVersion: 1,
        recordRevision: 1,
        review: "unneeded",
        validation: "unknown",
        enabled: false,
        lifecycleState: "active",
        applicability: {
          taskFamily: observations.some((observation) => observation.toolName === "document")
            ? "spreadsheet"
            : observations.some((observation) => observation.toolName === "bash")
              ? "coding"
              : "general",
          toolNames: [
            ...new Set(
              observations.flatMap((observation) =>
                observation.toolName ? [observation.toolName] : [],
              ),
            ),
          ].slice(0, 8),
          conditions: [],
        },
        sources,
        observationIds: evidence.map((observation) => observation.observationId),
        ...(this.options.modelRoute ? { modelRoute: this.options.modelRoute } : {}),
        createdAt: now,
        updatedAt: now,
      }));
    check();
    await this.options.store.executionLearning.enqueueExecutionLearningJob({
      jobId: `task-experience-job:${hash([candidate.candidateId, candidate.contentVersion])}`,
      workspaceKey: this.options.workspaceKey,
      sessionId: task.sessionId,
      runId: task.runId,
      candidateId: candidate.candidateId,
      kind: "reflect",
      state: "ready",
      inputEpoch: this.inputEpoch,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
      fencingToken: 0,
    });
    check();
    this.options.onChanged?.();
    this.options.worker.wake();
  }
}

function explicitCorrection(text: string): boolean {
  return /(?:刚才|上(?:一个|次|面|个)?(?:任务|回答|结果|计算)?|前(?:一个|次|面)|previous|last)\s*[\s\S]{0,80}(?:不对|错|纠正|修正|应(?:该|当)|不是|wrong|incorrect|correct)/iu.test(
    text,
  );
}
function correctionSignal(text: string): boolean {
  return /(?:不对|错|纠正|修正|应该|不是|重算|重新计算|wrong|incorrect|correct)/iu.test(text);
}
function sharedConcreteTarget(
  text: string,
  goal: string,
  observations: readonly TaskExperienceObservation[],
): boolean {
  const cells = [...text.matchAll(/\b([A-Z]{1,3})([1-9]\d{0,6})\b/giu)];
  const column = (letters: string): number =>
    Array.from(letters.toUpperCase()).reduce(
      (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
      0,
    );
  for (const cell of cells) {
    if (new RegExp(`\\b${cell[0]}\\b`, "iu").test(goal)) return true;
    for (const observation of observations) {
      if (
        observation.toolName !== "document" ||
        observation.kind !== "tool-result" ||
        observation.coverage !== "complete"
      )
        continue;
      const range =
        typeof observation.arguments?.range === "string"
          ? /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/iu.exec(observation.arguments.range)
          : undefined;
      if (
        range &&
        column(cell[1]!) >= column(range[1]!) &&
        column(cell[1]!) <= column(range[3]!) &&
        Number(cell[2]) >= Number(range[2]) &&
        Number(cell[2]) <= Number(range[4])
      )
        return true;
    }
  }
  const targets = [
    ...text.matchAll(
      /(?:[\p{L}\p{N}_-]+\.(?:xlsx?|csv|ts|tsx|js|json|test|py)|["“'`][^"”'`\n]{3,80}["”'`])/giu,
    ),
  ].map((match) => match[0]);
  return targets.some((target) => goal.includes(target));
}
function explicitRemember(text: string): boolean {
  return /(?:记住|长期|以后都|始终|remember|always)/iu.test(text);
}
function userRequest(content: string): string {
  return content.split(/\n\n附件文件：|\n<uploaded-attachments>/u)[0]!.trim();
}
function boundedText(text: string, limit = 800): string {
  const redacted = redactSensitiveText(text).replace(
    /pico:\/\/artifact\/[^\s<>"']+/gu,
    "<current-input-artifact>",
  );
  if (memoryTextContainsSecret(redacted)) return "[内容因敏感信息省略]";
  return Array.from(redacted).slice(0, limit).join("");
}
function safeArguments(
  args: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const allowed = ["action", "operation", "sheet", "range", "column", "header", "offset", "limit"];
  const safe: Record<string, string | number | boolean | null> = {};
  for (const key of allowed) {
    const value = args[key];
    if (value === null || typeof value === "number" || typeof value === "boolean")
      safe[key] = value;
    else if (typeof value === "string" && !memoryTextContainsSecret(value))
      safe[key] = boundedText(value, 128);
  }
  return safe;
}
