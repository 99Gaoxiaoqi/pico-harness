import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import type { Session } from "../engine/session.js";
import { loadImage } from "../input/prepare-prompt.js";
import type { HookOutput } from "../hooks/types.js";
import type { ImagePart, Message } from "../schema/message.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import type { CliSessionSelection } from "../cli/session-resolver.js";
import { logger } from "../observability/logger.js";
import { RuntimeRun } from "./runtime-run.js";
import type { RuntimeRunContinuationOf } from "../engine/session-runtime-event.js";
import type { MemoryReviewSchedulerPort } from "../memory/runtime-scheduler.js";
import type { PlanHandoffController } from "../engine/plan-handoff.js";
import type { PlanCoordinator } from "../plan/coordinator.js";
import type { MemoryTriggerSlot } from "../memory/memory-trigger-tools.js";
import { findPrecommittedDesktopMemoryEvidence } from "./memory-review-recovery.js";
import { findOrphanGraphWorks } from "../graph/graph-recover.js";
import { settleGraphWork, type SessionRuntime } from "./session-runtime.js";
import type {
  RunAgentCliResult,
  RuntimeRunOptions,
  RuntimeLifecycleEvent,
  RunAgentUsage,
} from "./runtime-contract.js";

/** 自动锚定的终态新鲜度窗口缺省(审查 F2):跨进程存活保护的等待期。 */
const DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS = 10 * 60_000;

/**
 * The narrow, already-assembled boundary for one foreground/background Agent turn.
 *
 * Resource ownership deliberately stays with AgentRuntime: this executor never
 * creates or closes SessionRuntime, MCP, plugin snapshots, stores, or providers.
 */
export interface RuntimeRunExecutorInput {
  readonly session: Session;
  readonly runtimeState: SessionRuntime;
  readonly engine: AgentEngine;
  readonly sessionSelection: CliSessionSelection;
  readonly workDir: string;
  readonly picoHome: string;
  readonly prompt: string;
  readonly resumeExistingSession: boolean;
  /**
   * Durable H+1 admission already published by a recoverable-task adapter.
   * RuntimeRun.start reuses this exact fact; it must not create another run.started.
   */
  readonly prestartedRun?: PrestartedRuntimeRun;
  /**
   * ADR 29 续跑声明(可选):声明本次 run 是某个 interrupted run 的续跑。
   * 调用方须先 store.claimContinuation 成功;三元组写入 run.started 的
   * data.continuationOf(与 prestartedRun 互斥:prestarted 事实已定形)。
   */
  readonly continuationOf?: RuntimeRunContinuationOf;
  /**
   * 自动锚定的终态新鲜度门(审查 F2,毫秒,缺省 10 分钟):interrupted 终态
   * 距今不足该窗口时不锚定不封口——防跨进程 reconcile 把存活 run 误判补终态
   * 后被立即 claim 封死(未 claim 的终态 run 保持开放语义,存活方可继续写)。
   * 测试可传 0 关闭窗口。
   */
  readonly continuationTerminalMinAgeMs?: number;
  readonly traceEnabled: boolean;
  readonly options: RuntimeRunOptions;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RuntimeLifecycleEvent) => void;
  readonly rewindPointSink?: (checkpointId: string) => void;
  /** Eligible foreground-only durable post-terminal memory scheduler. */
  readonly memoryReviewScheduler?: MemoryReviewSchedulerPort;
  /** Per-turn memory trigger slot: set by memory_remember/memory_extract tools. */
  readonly memoryTriggerSlot?: MemoryTriggerSlot;
  readonly planHandoff?: PlanHandoffController;
  readonly planCoordinator?: () => PlanCoordinator;
}

export interface PrestartedRuntimeRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly runStartedEventId: string;
  readonly runStartedAt: string;
  readonly parentRunId: string;
}

/**
 * Executes one already-assembled RuntimeRun and returns the public CLI result.
 * It owns no resources and is safe to use from TUI, daemon, or compatibility
 * callers as long as the caller keeps the supplied SessionRuntime alive.
 */
export class RuntimeRunExecutor {
  constructor(private readonly input: RuntimeRunExecutorInput) {}

  async execute(): Promise<RunAgentCliResult> {
    const {
      session,
      runtimeState,
      engine,
      sessionSelection,
      workDir,
      prompt: initialPrompt,
      resumeExistingSession,
      prestartedRun,
      options,
      signal,
      onEvent,
      rewindPointSink,
      memoryReviewScheduler,
      planHandoff,
      planCoordinator,
    } = this.input;
    if (prestartedRun) {
      assertPrestartedRuntimeRun(prestartedRun);
      if (!resumeExistingSession) {
        throw new Error("A prestarted RuntimeRun requires resumeExistingSession");
      }
    }
    let prompt = initialPrompt;

    const result = await session.serialize(async () => {
      const runtimeCapability = session.runtimeEventCapability;
      if (!runtimeCapability) {
        throw new Error(`RuntimeRunExecutor requires a durable Session: ${session.id}`);
      }
      await RuntimeRun.reconcileIncompleteRuns({
        capability: runtimeCapability,
        ...(prestartedRun ? { prestartedRunId: prestartedRun.runId } : {}),
      });
      await RuntimeRun.repairSessionProjection(session, {
        capability: runtimeCapability,
      });
      await this.recoverOrphanGraphWorks(session, runtimeState);
      // ADR 29 调度接入(2026-08-20):reconcile 把崩溃 run 定形为 interrupted 后,
      // 自动锚定最新未 claim 的 interrupted run——本次 run 以其续跑身份起跑
      // (goal/cron/前台统一生效;显式 continuationOf 与 prestartedRun 优先)。
      const autoContinuation = await this.claimAutomaticContinuation(session);
      const runtimeRun = await RuntimeRun.start({
        capability: runtimeCapability,
        ...(prestartedRun
          ? {
              runId: prestartedRun.runId,
              invocationId: prestartedRun.invocationId,
              runStartedEventId: prestartedRun.runStartedEventId,
              parentRunId: prestartedRun.parentRunId,
              now: prestartedRunClock(prestartedRun.runStartedAt),
            }
          : autoContinuation
            ? { runId: autoContinuation.runId, continuationOf: autoContinuation.continuationOf }
            : {}),
        ...(this.input.continuationOf && !prestartedRun
          ? { continuationOf: this.input.continuationOf }
          : {}),
      });
      let submittedUserMessage =
        memoryReviewScheduler && resumeExistingSession
          ? findPrecommittedDesktopMemoryEvidence(
              await runtimeRun.store.readSessionEntries(session.id),
              runtimeRun.runId,
              initialPrompt,
            )
          : undefined;
      emitRuntimeLifecycleEvent(onEvent, {
        type: "run.started",
        sessionId: session.id,
        workDir,
        at: Date.now(),
      });
      const runResult = await runtimeRun.run(async () => {
        signal?.throwIfAborted();
        if (!resumeExistingSession) {
          const submittedPrompt = prompt;
          const submitDecision = await runtimeState.dispatchHook(
            "UserPromptSubmit",
            { prompt: submittedPrompt },
            { signal },
          );
          if (submitDecision.decision === "deny") {
            throw new Error(
              `UserPromptSubmit hook 阻断了输入: ${submitDecision.reason ?? "(无原因)"}`,
            );
          }
          prompt = normalizePrompt(applyPromptHookDecision(submittedPrompt, submitDecision));
          const expansionDecision = await runtimeState.dispatchHook(
            "UserPromptExpansion",
            {
              prompt: options.rewindPrompt ?? submittedPrompt,
              expandedPrompt: prompt,
            },
            { signal },
          );
          if (expansionDecision.decision === "deny") {
            throw new Error(
              `UserPromptExpansion hook 阻断了输入: ${expansionDecision.reason ?? "(无原因)"}`,
            );
          }
          prompt = normalizePrompt(applyPromptHookDecision(prompt, expansionDecision));
          const images: ImagePart[] | undefined =
            options.images ??
            (options.imagePath ? [loadImage(options.imagePath, workDir)] : undefined);
          const rewindPointId = await session.beginRewindPoint({
            userPrompt: options.rewindPrompt ?? prompt,
            ...(options.rewindTranscriptIndex !== undefined
              ? { transcriptIndex: options.rewindTranscriptIndex }
              : {}),
            ...(options.rewindInteractionMode !== undefined
              ? { interactionMode: options.rewindInteractionMode }
              : {}),
            ...(options.rewindPrePlanMode !== undefined
              ? { prePlanMode: options.rewindPrePlanMode }
              : {}),
          });
          rewindPointSink?.(rewindPointId);
          const userReceipt = await session.commitMessageOnce(`user-message:${rewindPointId}`, {
            role: "user",
            content: prompt,
            ...(images ? { images } : {}),
          });
          submittedUserMessage = { eventId: userReceipt.eventId, content: prompt };
          await session.bindRewindPointSource(rewindPointId, userReceipt);
          // 设置 memory_remember 前台同步提取需要的上下文引用。
          if (this.input.memoryTriggerSlot) {
            this.input.memoryTriggerSlot.ref = {
              sessionId: session.id,
              runId: runtimeRun.runId,
              terminalEventId: userReceipt.eventId,
              userMessageEventId: userReceipt.eventId,
            };
          }
        }

        const messages = await engine.run(session, undefined, undefined, signal);
        return {
          sessionId: session.id,
          sessionSelection,
          workDir,
          finalMessage: findFinalMessage(messages),
          usage: snapshotUsage(session),
          messages,
          ...(this.input.traceEnabled
            ? { tracePath: await findTracePath(workDir, session.id, this.input.picoHome) }
            : {}),
        } satisfies RunAgentCliResult;
      }, signal);
      if (
        memoryReviewScheduler &&
        submittedUserMessage &&
        this.input.memoryTriggerSlot?.trigger
      ) {
        try {
          const terminalEntry = (await runtimeRun.store.readSessionEntries(session.id)).find(
            ({ event }) =>
              event.kind === "run.terminal" &&
              event.runId === runtimeRun.runId &&
              event.data.status === "completed" &&
              event.data.recovered !== true,
          );
          if (terminalEntry?.event.kind === "run.terminal") {
            const terminal = terminalEntry.event;
            scheduleMemoryReviewEnqueue(
              memoryReviewScheduler,
              {
                sessionId: session.id,
                runId: runtimeRun.runId,
                terminalEventId: terminal.eventId,
                userMessageEventId: submittedUserMessage.eventId,
                terminalSequence: terminalEntry.sequence,
              },
              { sessionId: session.id, runId: runtimeRun.runId },
            );
          }
        } catch (error) {
          // The completed terminal fact is canonical. Memory scheduling is degraded-only.
          logger.warn(
            {
              sessionId: session.id,
              runId: runtimeRun.runId,
              error: error instanceof Error ? error.message : String(error),
            },
            "[Memory] post-terminal enqueue failed",
          );
        }
      }
      const handoff = planHandoff?.result();
      if (handoff && planCoordinator) {
        const projection = await planCoordinator().project();
        const refreshed = planHandoff!.refreshProjection(projection);
        if (!refreshed)
          throw new Error("Submitted plan handoff disappeared before projection refresh");
        return {
          ...runResult,
          handoff: refreshed,
        };
      }
      return runResult;
    });

    emitRuntimeLifecycleEvent(onEvent, {
      type: "run.finished",
      sessionId: session.id,
      workDir,
      at: Date.now(),
    });
    return result;
  }

  /**
   * Settles graph works left dispatched by a previous process: after a restart
   * the prior delegations' heartbeats stop, so their `graph-work:${workId}`
   * leases elapse (≤ TTL). Any still-dispatched work whose lease is now dead
   * can never settle on its own. Each is marked failed (recovered); downstream
   * works then surface as deadlocked via the existing missingInputIds
   * continuation diagnostics.
   */
  /**
   * ADR 29 调度接入:最新 interrupted 终态且未被 claim 的 run → 为本次 run
   * 锚定续跑(返回 target runId + continuationOf 三元组)。claim 失败/无候选/
   * 调用方已显式声明 continuationOf 或使用 prestartedRun 时返回 undefined,
   * 本次 run 以普通身份起跑。claim 成功但 start 前崩溃的窗口由孤儿改绑兜底。
   *
   * 新鲜度门(审查 F2):终态事件 at 距今不足 continuationTerminalMinAgeMs
   * (缺省 10 分钟)时跳过锚定——跨进程 reconcile 可能误判存活 run 补了新鲜
   * interrupted 终态,立即 claim 会封死对方;未 claim 的终态 run 保持开放语义,
   * 对方可继续写。代价是真实崩溃后的锚定延迟到窗口期后的下一次 run 起跑。
   */
  private async claimAutomaticContinuation(
    session: Session,
  ): Promise<{ runId: string; continuationOf: RuntimeRunContinuationOf } | undefined> {
    if (this.input.continuationOf || this.input.prestartedRun) return undefined;
    const store = session.runtimeEventStore;
    if (!store) return undefined;
    const candidate = await store.findLatestInterruptedUnclaimedRun(session.id);
    if (!candidate) return undefined;
    const minAgeMs = this.input.continuationTerminalMinAgeMs ?? DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS;
    const terminalAgeMs = Date.now() - Date.parse(candidate.terminalAt);
    if (!Number.isFinite(terminalAgeMs) || terminalAgeMs < minAgeMs) {
      logger.info(
        { sessionId: session.id, sourceRunId: candidate.runId, terminalAgeMs, minAgeMs },
        "[Continuation] interrupted 终态过于新鲜,暂不锚定(跨进程存活保护),普通起跑",
      );
      return undefined;
    }
    const targetRunId = randomUUID();
    const outcome = await store.claimContinuation(session.id, candidate.runId, targetRunId);
    if (outcome.status !== "claimed") {
      logger.info(
        { sessionId: session.id, sourceRunId: candidate.runId, status: outcome.status },
        "[Continuation] interrupted run 未锚定自动续跑(已被续跑或状态变化),普通起跑",
      );
      return undefined;
    }
    return {
      runId: targetRunId,
      continuationOf: {
        runId: candidate.runId,
        highWater: outcome.claim.sourceHighWater,
        prefixDigest: outcome.claim.sourcePrefixDigest,
      },
    };
  }

  private async recoverOrphanGraphWorks(
    session: Session,
    runtimeState: SessionRuntime,
  ): Promise<void> {
    if (!session.runtimeEventStore || !runtimeState.graphContext) return;
    const { orphanWorkIds } = await findOrphanGraphWorks({
      runtimeStore: session.runtimeEventStore,
      sessionId: session.id,
      graphId: runtimeState.graphContext.graphId,
      isWorkLeaseLive: (workId) => runtimeState.delegationManager.isWorkLeaseLive(workId),
    });
    for (const workId of orphanWorkIds) {
      await settleGraphWork(
        session,
        runtimeState.graphContext,
        workId,
        "error",
        "orphan: backing delegation lost on process restart (recovered)",
        () => undefined,
      ).catch((error) =>
        logger.warn(
          { sessionId: session.id, workId, error: String(error) },
          "[graph] orphan recovery settle failed",
        ),
      );
    }
  }
}

function assertPrestartedRuntimeRun(value: PrestartedRuntimeRun): void {
  for (const [field, candidate] of Object.entries(value)) {
    if (field === "runStartedAt") continue;
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`Prestarted RuntimeRun ${field} must not be empty`);
    }
  }
  const startedAt = new Date(value.runStartedAt);
  if (!Number.isFinite(startedAt.getTime()) || startedAt.toISOString() !== value.runStartedAt) {
    throw new Error("Prestarted RuntimeRun runStartedAt must be a canonical timestamp");
  }
}

function prestartedRunClock(runStartedAt: string): () => Date {
  let startPending = true;
  return () => {
    if (startPending) {
      startPending = false;
      return new Date(runStartedAt);
    }
    return new Date();
  };
}

function scheduleMemoryReviewEnqueue(
  scheduler: MemoryReviewSchedulerPort,
  input: Parameters<MemoryReviewSchedulerPort["enqueue"]>[0],
  context: { readonly sessionId: string; readonly runId: string },
): void {
  // The terminal fact is already durable. Schedule the observer in a new host task so neither a
  // slow Promise nor synchronous storage lock contention can extend the foreground response path.
  setImmediate(() => {
    try {
      const pending = scheduler.enqueue(input);
      if (pending) {
        void pending.catch((error: unknown) => logMemoryEnqueueFailure(context, error));
      }
    } catch (error) {
      logMemoryEnqueueFailure(context, error);
    }
  });
}

function logMemoryEnqueueFailure(
  context: { readonly sessionId: string; readonly runId: string },
  error: unknown,
): void {
  logger.warn(
    {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    },
    "[Memory] post-terminal enqueue failed",
  );
}

export function emitRuntimeLifecycleEvent(
  sink: RuntimeRunExecutorInput["onEvent"],
  event: RuntimeLifecycleEvent,
): void {
  try {
    sink?.(event);
  } catch (error) {
    // Lifecycle events are observational. A UI/telemetry callback must not leave
    // the canonical RuntimeRun without a terminal fact or turn success into failure.
    logger.warn(
      { error: String(error), lifecycleEvent: event.type, sessionId: event.sessionId },
      "Runtime lifecycle observer failed",
    );
  }
}

function applyPromptHookDecision(prompt: string, decision: HookOutput): string {
  let next = prompt;
  if (typeof decision.modifiedInput === "string") {
    next = decision.modifiedInput;
  } else if (
    typeof decision.modifiedInput === "object" &&
    decision.modifiedInput !== null &&
    "prompt" in decision.modifiedInput &&
    typeof Reflect.get(decision.modifiedInput, "prompt") === "string"
  ) {
    next = String(Reflect.get(decision.modifiedInput, "prompt"));
  }
  return decision.additionalContext ? `${next}\n\n${decision.additionalContext}` : next;
}

function normalizePrompt(prompt: string): string {
  if (prompt.trim() === "") throw new Error("Prompt must not be empty.");
  return prompt;
}

function findFinalMessage(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) === 0) {
      return message.content;
    }
  }
  return "";
}

function snapshotUsage(session: Session): RunAgentUsage {
  return {
    promptTokens: session.totalPromptTokens,
    completionTokens: session.totalCompletionTokens,
    costCNY: session.totalCostCNY,
  };
}

async function findTracePath(
  workDir: string,
  sessionId: string,
  picoHome: string,
): Promise<string | undefined> {
  const traceDir = resolvePicoPaths(workDir, { picoHome }).workspace.traces;
  let files: string[];
  try {
    files = await readdir(traceDir);
  } catch {
    return undefined;
  }

  const prefix = `trace_${sanitizeTracePart(sessionId)}_`;
  const traceFile = files
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort()
    .at(-1);
  return traceFile ? join(traceDir, traceFile) : undefined;
}

function sanitizeTracePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}
