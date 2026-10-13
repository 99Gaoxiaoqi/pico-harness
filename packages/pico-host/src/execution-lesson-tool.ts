import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  isForegroundProcessFacts,
  type RuntimeToolResultRecordedEvent,
  type RuntimeToolStartedEvent,
  type ToolDefinition,
} from "@pico/core";
import type {
  ExecutionLessonCandidate,
  MemoryItemSource,
} from "@pico/core/atomic-memory-contracts";
import { normalizeLongTermMemoryContent } from "@pico/core/atomic-memory-contracts";
import type { MemoryGateResult } from "@pico/core/atomic-memory-runtime-contracts";
import { currentRuntimeRun, isRuntimeRunLive } from "@pico/runtime/runtime-run";
import { ToolAccesses } from "@pico/runtime/tool-access";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";
import { memoryTextContainsSecret } from "@pico/runtime/atomic-memory/extraction-evidence";
import type { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import {
  NO_FILE_SIDE_EFFECTS,
  type BaseTool,
  type ToolExecutionContext,
} from "./tool-registry-contract.js";
import type { Session } from "./session.js";

interface EvidenceRef {
  toolCallId: string;
  runId?: string;
}
interface LearningInput {
  action: "propose" | "verify" | "inspect" | "discard";
  candidateId?: string;
  lesson?: string;
  taskFamily?: string;
  failure?: EvidenceRef;
  verifications?: EvidenceRef[];
}
interface Evidence {
  start: RuntimeToolStartedEvent;
  result: RuntimeToolResultRecordedEvent;
  sequence: number;
  dispatchSequence: number;
  hash: string;
  source: MemoryItemSource;
}

export class ExecutionLessonTool implements BaseTool {
  readonly readOnly = true;
  readonly permissionCategory = "read" as const;
  readonly nesting = "direct_only" as const;
  readonly executionSemantics = "exclusive_step" as const;
  readonly recoveryMode = "never_auto_retry" as const;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  constructor(
    private readonly options: {
      store: SqliteMemoryItemStore;
      session: Session;
      workspaceKey: string;
      gate: () => Promise<MemoryGateResult>;
      isDraining?: () => boolean;
      onChanged?: () => void;
    },
  ) {}
  name(): string {
    return "memory_learn";
  }
  accesses() {
    return ToolAccesses.resource(`execution-memory:${this.options.workspaceKey}`);
  }
  definition(): ToolDefinition {
    const reference = {
      type: "object",
      properties: {
        toolCallId: { type: "string", minLength: 1, maxLength: 512 },
        runId: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["toolCallId"],
      additionalProperties: false,
    };
    return {
      name: this.name(),
      description:
        "Retain a narrow lesson from an actual completed native Bash failure. Call alone. propose takes a declarative lesson, taskFamily and failure tool-call reference. Only three DISTINCT successful executions of the EXACT same command/policy AFTER proposing the candidate can confirm it. verify accepts explicit verification references or, when omitted, collects subsequent matching native executions from this Session. Pending candidates are not recalled. Never repeat commands solely to earn votes or claim general correctness from exit status. Use inspect to recover a candidate and discard to remove an unconfirmed lesson. Sources, workspace, policy and result facts are checked by the host; text claims are not evidence. Resubmit propose to revise a pending lesson; prior votes reset.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["propose", "verify", "inspect", "discard"] },
          candidateId: { type: "string", minLength: 1, maxLength: 512 },
          lesson: { type: "string", minLength: 1, maxLength: 2000 },
          taskFamily: { type: "string", minLength: 1, maxLength: 128 },
          failure: reference,
          verifications: { type: "array", items: reference, minItems: 1, maxItems: 32 },
        },
        required: ["action"],
        additionalProperties: false,
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseInput(args);
    const run = currentRuntimeRun();
    const session = this.options.session;
    if (
      !run ||
      !run.claimsSession(session) ||
      !isRuntimeRunLive(session.id, run.runId) ||
      !context?.toolCallId
    )
      throw new Error("memory_learn requires the current live Session and a direct tool call");
    const events = session.runtimeEventStore;
    if (!events) throw new Error("Execution evidence is unavailable");
    let ownerEpoch: number | undefined;
    const checkOwnership = async () => {
      const fence = await session.assertRuntimeEventWriteAllowed();
      if (ownerEpoch !== undefined && fence.epoch !== ownerEpoch)
        throw new Error("Execution learning Session owner changed");
      ownerEpoch ??= fence.epoch;
      if (
        context.signal?.aborted ||
        this.options.isDraining?.() ||
        !run.claimsSession(session) ||
        !isRuntimeRunLive(session.id, run.runId)
      )
        throw new Error("Execution learning is no longer admitted");
    };
    const checkAdmission = async () => {
      const gate = await this.options.gate();
      if (!gate.allowed) throw new Error(`Execution learning unavailable: ${gate.reason}`);
      const settings = await this.options.store.readSettings(this.options.workspaceKey);
      if (!settings.enabled || !settings.autoExtract)
        throw new Error("Execution learning is disabled");
      // Validate the original owner fence after all asynchronous policy reads,
      // immediately before entering the synchronous SQLite transaction.
      await checkOwnership();
      return settings;
    };
    const settings = await checkAdmission();
    const slice = await events.readSessionEntriesOfKinds(session.id, [
      "run.started",
      "tool.started",
      "tool.result.recorded",
    ]);
    const ownStarts = slice.entries.filter(
      ({ event }) =>
        event.kind === "tool.started" &&
        event.data.toolName === this.name() &&
        event.runId === run.runId &&
        event.invocationId === run.invocationId &&
        event.refs?.toolCallId === context.toolCallId,
    );
    if (ownStarts.length !== 1) throw new Error("Learning tool boundary is ambiguous");
    const entries = slice.entries.filter(({ sequence }) => sequence < ownStarts[0]!.sequence);
    const evidence = async (ref: EvidenceRef): Promise<Evidence> => {
      const results = entries.filter(
        ({ event }) =>
          event.kind === "tool.result.recorded" &&
          event.refs.toolCallId === ref.toolCallId &&
          (!ref.runId || event.runId === ref.runId),
      );
      if (results.length !== 1)
        throw new Error("Execution reference is missing or ambiguous; provide its runId");
      const resultEntry = results[0]!;
      const result = resultEntry.event as RuntimeToolResultRecordedEvent;
      const starts = entries.filter(
        ({ event, sequence }) =>
          event.kind === "tool.started" &&
          sequence < resultEntry.sequence &&
          event.runId === result.runId &&
          event.refs?.toolCallId === ref.toolCallId,
      );
      if (starts.length !== 1 || result.runId.startsWith("fork-bootstrap:"))
        throw new Error("Execution reference has no unique native dispatch");
      const start = starts[0]!.event as RuntimeToolStartedEvent;
      const operation = await events.readToolOperation(session.id, result.runId, ref.toolCallId);
      if (
        !operation ||
        operation.state !== "settled" ||
        operation.toolName !== start.data.toolName ||
        operation.argumentsHash !== start.data.argumentsHash ||
        operation.preparedEventId !== start.eventId ||
        operation.outcomeEventId !== result.eventId
      )
        throw new Error("Execution reference is not a settled tool operation");
      const runStart = entries.find(
        ({ event }) => event.kind === "run.started" && event.runId === result.runId,
      )?.event;
      if (
        runStart?.kind !== "run.started" ||
        resolve(runStart.data.workDir) !== resolve(session.workDir) ||
        start.sessionId !== result.sessionId ||
        start.invocationId !== result.invocationId ||
        start.turnId !== result.turnId ||
        start.data.toolName !== "bash" ||
        result.data.toolName !== "bash" ||
        start.data.argumentsRedacted ||
        result.partial ||
        result.data.recovery
      )
        throw new Error("Execution reference crosses an identity or recovery boundary");
      const facts = result.data.executionFacts;
      if (
        !isForegroundProcessFacts(facts) ||
        facts.exitCode === null ||
        facts.terminationSignal !== null ||
        facts.timedOut ||
        facts.outputIncomplete ||
        facts.spawnFailed ||
        !["succeeded", "failed"].includes(result.data.status)
      )
        throw new Error("Only complete native process outcomes are verification evidence");
      const parsed: unknown = JSON.parse(start.data.argumentsJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid native command arguments");
      const commandArgs = parsed as Record<string, unknown>;
      if (
        typeof commandArgs.command !== "string" ||
        commandArgs.background === true ||
        memoryTextContainsSecret(start.data.argumentsJson)
      )
        throw new Error("Background or sensitive commands cannot form a lesson");
      const hash = digest({
        version: 1,
        workDir: resolve(session.workDir),
        tool: "bash",
        command: commandArgs.command,
        background: false,
        boundary: commandArgs.boundary_intent ?? "current",
        requiredBoundary: commandArgs.required_boundary ?? null,
      });
      return {
        start,
        result,
        sequence: resultEntry.sequence,
        dispatchSequence: starts[0]!.sequence,
        hash,
        source: source(result),
      };
    };
    let candidate: ExecutionLessonCandidate;
    if (input.action === "propose") {
      const failed = await evidence(input.failure!);
      if (failed.result.data.executionFacts!.exitCode === 0)
        throw new Error("The referenced command did not fail");
      const deletionRevision = await this.options.store.readDeletionRevision();
      await checkAdmission();
      candidate = await this.options.store.createExecutionLesson({
        candidateId: `lesson-${digest([this.options.workspaceKey, session.id, failed.result.eventId])}`,
        workspaceKey: this.options.workspaceKey,
        sessionId: session.id,
        content: safeText(input.lesson!),
        taskFamily: safeText(input.taskFamily!),
        commandHash: failed.hash,
        evidenceBoundary: ownStarts[0]!.sequence,
        failure: failed.source,
        observedAt: Date.parse(failed.result.at),
        deletionRevision,
        settingsVersion: settings.version,
      });
      await checkOwnership();
    } else {
      const found = await this.options.store.readExecutionLesson(input.candidateId!);
      if (
        !found ||
        found.workspaceKey !== this.options.workspaceKey ||
        found.sessionId !== session.id
      )
        throw new Error("No execution lesson in the current Session/workspace");
      candidate = found;
    }
    if (input.action === "discard") {
      await checkAdmission();
      await this.options.store.rejectExecutionLesson(
        candidate.candidateId,
        this.options.workspaceKey,
        session.id,
      );
      await checkOwnership();
      return JSON.stringify({
        candidateId: candidate.candidateId,
        state: "rejected",
        saved: false,
      });
    }
    if (
      input.action !== "inspect" &&
      (input.verifications?.length || input.action === "verify") &&
      candidate.state === "candidate"
    ) {
      const original = entries.find(({ event }) => event.eventId === candidate.failure?.eventId);
      if (original?.event.kind !== "tool.result.recorded")
        throw new Error("Original failure is no longer available");
      // Revalidate every accumulated source before promotion, including post-restart votes.
      const prior = candidate.verifications.map((ref) => {
        const entry = entries.find(({ event }) => event.eventId === ref.eventId);
        if (entry?.event.kind !== "tool.result.recorded")
          throw new Error("Prior validation is no longer available");
        return { toolCallId: entry.event.refs.toolCallId, runId: entry.event.runId };
      });
      const validations: Evidence[] = [];
      const requested =
        input.verifications ??
        entries
          .filter(
            ({ event, sequence }) =>
              event.kind === "tool.result.recorded" &&
              event.data.toolName === "bash" &&
              sequence > candidate.evidenceBoundary,
          )
          .slice(-32)
          .flatMap(({ event }) =>
            event.kind === "tool.result.recorded"
              ? [{ toolCallId: event.refs.toolCallId, runId: event.runId }]
              : [],
          );
      const references = [
        ...prior.map((ref) => ({ ref, required: true })),
        ...requested.map((ref) => ({ ref, required: !!input.verifications })),
      ];
      for (const { ref, required } of references) {
        let verified: Evidence;
        try {
          verified = await evidence(ref);
        } catch (error) {
          if (!required) continue;
          throw error;
        }
        if (
          verified.sequence <= original.sequence ||
          verified.sequence <= candidate.evidenceBoundary ||
          verified.dispatchSequence <= candidate.evidenceBoundary ||
          verified.hash !== candidate.commandHash ||
          verified.result.data.status !== "succeeded" ||
          verified.result.data.executionFacts!.exitCode !== 0
        ) {
          if (!required) continue;
          throw new Error(
            "Validation must be a post-proposal successful execution of the same command/policy",
          );
        }
        validations.push(verified);
      }
      if (!validations.length)
        return JSON.stringify({
          candidateId: candidate.candidateId,
          state: candidate.state,
          saved: false,
          verificationCount: candidate.verifications.length,
          requiredVerifications: 3,
        });
      await checkAdmission();
      candidate = await this.options.store.verifyExecutionLesson({
        candidateId: candidate.candidateId,
        expectedVersion: candidate.version,
        workspaceKey: this.options.workspaceKey,
        sessionId: session.id,
        verifications: validations.map(({ source }) => source),
        observedAt: Math.max(...validations.map(({ result }) => Date.parse(result.at))),
      });
      await checkOwnership();
      if (candidate.state === "confirmed") this.options.onChanged?.();
    }
    return JSON.stringify({
      candidateId: candidate.candidateId,
      state: candidate.state,
      saved: candidate.state === "confirmed",
      verificationCount: candidate.verifications.length,
      requiredVerifications: 3,
      itemId: candidate.itemId,
      ...(input.action === "inspect"
        ? { lesson: candidate.content, taskFamily: candidate.taskFamily }
        : {}),
    });
  }
}

function source(event: RuntimeToolResultRecordedEvent): MemoryItemSource {
  return {
    sessionId: event.sessionId,
    runId: event.runId,
    turnId: event.turnId,
    eventId: event.eventId,
  };
}
function digest(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, stable(entry)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
function safeText(value: string): string {
  const normalized = normalizeLongTermMemoryContent(value);
  if (!normalized.ok) throw new Error(normalized.message);
  const safe = sanitizeMemoryContent({
    title: "执行经验",
    content: normalized.value,
    reason: "实际执行验证",
  });
  if (safe.disposition !== "allow") throw new Error("Lesson failed content safety checks");
  return safe.content;
}
function parseInput(args: string): LearningInput {
  const raw: unknown = JSON.parse(args);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid memory_learn arguments");
  const value = raw as Record<string, unknown>;
  const action = value.action;
  if (!["propose", "verify", "inspect", "discard"].includes(String(action)))
    throw new Error("Invalid learning action");
  const allowed =
    action === "propose"
      ? ["action", "lesson", "taskFamily", "failure", "verifications"]
      : action === "verify"
        ? ["action", "candidateId", "verifications"]
        : ["action", "candidateId"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected learning argument");
  const text = (key: string, max: number) => {
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > max)
      throw new Error(`Invalid ${key}`);
  };
  const ref = (v: unknown): EvidenceRef => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("Invalid execution reference");
    const r = v as Record<string, unknown>;
    if (
      Object.keys(r).some((key) => !["toolCallId", "runId"].includes(key)) ||
      typeof r.toolCallId !== "string" ||
      !r.toolCallId ||
      r.toolCallId.length > 512 ||
      (r.runId !== undefined && (typeof r.runId !== "string" || !r.runId || r.runId.length > 512))
    )
      throw new Error("Invalid execution reference");
    return { toolCallId: r.toolCallId, ...(r.runId ? { runId: r.runId as string } : {}) };
  };
  if (action === "propose") {
    text("lesson", 2000);
    text("taskFamily", 128);
    ref(value.failure);
  } else text("candidateId", 512);
  if (value.verifications !== undefined) {
    if (
      !Array.isArray(value.verifications) ||
      !value.verifications.length ||
      value.verifications.length > 32
    )
      throw new Error("Invalid verification references");
    value.verifications.forEach(ref);
  }
  return value as unknown as LearningInput;
}
