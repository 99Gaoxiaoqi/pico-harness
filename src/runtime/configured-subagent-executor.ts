import { resolveConfiguredSubagentContinuation } from "./configured-subagent-continuation.js";
import type { ConfiguredSubagentCatalogPort } from "../agents/subagent-profiles.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelRouter } from "../provider/model-router.js";
import {
  coordinateReasoningLevel,
  type ResolvedModelReasoningCapability,
} from "../provider/reasoning-capability.js";
import { SilentReporter, type Reporter } from "../engine/reporter.js";
import { ScopedSubagentActivityReporter } from "../tools/subagent-activity-reporter.js";
import type {
  ConfiguredSubagentExecutor,
  ConfiguredSubagentExecutionResult,
} from "../tools/configured-subagent-tools.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import type { AgentRuntime, RunAgentCliDependencies } from "./agent-runtime.js";
import { currentRuntimeRun, currentRuntimeToolCallId } from "./runtime-run.js";

/** Public off uses the route's native disabled token; omitted means model default. */
export function subagentThinkingLevel(
  profile: ResolvedModelReasoningCapability,
  requested?: string,
): string | undefined {
  const native =
    requested === "off"
      ? (["off", "none", "nothink"].find((level) => profile.levels.includes(level)) ?? requested)
      : requested;
  if (native !== undefined && !profile.levels.includes(native))
    throw new Error(`Subagent thinking level ${requested} is unavailable for this model`);
  return coordinateReasoningLevel(profile, native).level;
}
export interface CreateConfiguredSubagentExecutorOptions {
  readonly workDir: string;
  readonly modelRouter: ModelRouter;
  readonly parentModelRouteId: string;
  readonly worktreeSupervisor?: WorktreeSupervisor;
  readonly reporter?: Reporter;
  /** Only trusted runtime services, never parent Session, settings or thinking. */
  readonly childDependencies?: Pick<
    RunAgentCliDependencies,
    | "env"
    | "picoHome"
    | "providerFactory"
    | "providerDecorator"
    | "approvalNotifier"
    | "approvalManager"
    | "toolResultRedactionSecrets"
  >;
  /** The owning host supplies execution; this adapter does not construct its parent runtime. */
  readonly executeChild: AgentRuntime["execute"];
  readonly catalog?: ConfiguredSubagentCatalogPort;
}
const continuingChildren = new Set<string>();

/** Reuses durable Session + RuntimeRun and the existing worktree lifecycle, without another loop. */
export function createConfiguredSubagentExecutor(
  options: CreateConfiguredSubagentExecutorOptions,
): ConfiguredSubagentExecutor {
  const executeChild: ConfiguredSubagentExecutor = async (input) => {
    input.signal?.throwIfAborted();
    const parentRun = currentRuntimeRun();
    const parentToolCallId = currentRuntimeToolCallId();
    const sessionId = input.continuation?.childSessionId ?? `subagent-${randomUUID()}`;
    const reporter: Reporter = options.reporter ?? new SilentReporter();
    const startedAt = Date.now();
    const scope = {
      childSessionId: sessionId,
      childWorkspacePath: options.workDir,
      ...(parentToolCallId ? { toolCallId: parentToolCallId } : {}),
      // A continuation shares the session, but owns a separate transcript card and trace.
      activityId: input.continuation ? `subagent-activity-${randomUUID()}` : sessionId,
      task: input.task,
      agentName: input.continuation?.agentName ?? input.preset?.name ?? input.definition.name,
      mode: input.definition.workspace === "shared" ? ("explore" as const) : ("worker" as const),
      completionPolicy: "required" as const,
    };
    const childReporter = new ScopedSubagentActivityReporter(reporter, scope);
    let runId: string | undefined;
    let turnId: string | undefined;
    let childWorkDir = options.workDir;
    const childRecord = (status: string, result?: ConfiguredSubagentExecutionResult) => ({
      version: 1,
      parentSessionId: parentRun?.sessionId,
      parentWorkspacePath: parentRun?.workDir,
      parentRunId: parentRun?.runId,
      parentToolCallId,
      childSessionId: sessionId,
      workDir: childWorkDir,
      agentName: scope.agentName,
      profile: input.definition.profile,
      modelRouteId:
        input.continuation?.modelRouteId ??
        input.preset?.modelRouteId ??
        options.parentModelRouteId,
      ...(input.continuation ? { resumedFromRunId: input.continuation.sourceRunId } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      status,
      ...(runId ? { runId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(result
        ? {
            summary: result.summary,
            artifactIds: result.artifactIds ?? [],
            ...(result.patch ? { patch: result.patch } : {}),
          }
        : {}),
    });
    const recordParent = async (status: string, result?: ConfiguredSubagentExecutionResult) => {
      await parentRun?.recordTranscriptMessage({
        role: "assistant",
        content: `子任务 ${sessionId}: ${status}`,
        providerData: {
          picoHiddenFromTranscript: true,
          picoConfiguredChild: childRecord(status, result),
        },
      });
    };
    const execute = async (
      workDir: string,
      signal?: AbortSignal,
    ): Promise<ConfiguredSubagentExecutionResult> => {
      childWorkDir = workDir;
      scope.childWorkspacePath = workDir;
      if (!input.continuation) await recordParent("started");
      const routeId =
        input.continuation?.modelRouteId ??
        input.preset?.modelRouteId ??
        options.parentModelRouteId;
      const route = options.modelRouter.require(routeId);
      const thinking = subagentThinkingLevel(
        route.capabilities.reasoningProfile,
        input.continuation?.thinkingEffort ?? input.preset?.thinkingLevel,
      );
      const resolved = options.modelRouter.providerConfig(routeId, thinking);
      childReporter.onSubagentModelResolved({
        resolvedModelRoute: routeId,
        ...(thinking === undefined ? {} : { thinkingEffort: thinking }),
        source: input.preset ? "profile" : "parent",
      });
      const result = await options.executeChild(
        {
          prompt: input.task,
          dir: workDir,
          sessionSelection: { mode: input.continuation ? "resume" : "new", sessionId },
          provider: resolved.provider,
          baseURL: resolved.config.baseURL,
          apiKey: resolved.config.apiKey,
          ...(resolved.config.auth ? { auth: resolved.config.auth } : {}),
          model: route.model,
          modelRouteId: route.id,
          modelCapabilities: route.capabilities,
          ...(thinking === undefined ? {} : { thinkingEffort: thinking }),
          interactionMode: "default",
          orchestrationMode: "default",
          allowedTools: input.definition.tools,
        },
        {
          ...options.childDependencies,
          modelRouter: options.modelRouter,
          reporter: childReporter,
          ...(signal ? { signal } : {}),
          maxTurns: 20,
          hostKind: "desktop",
          configuredSubagentChild: {
            definition: input.definition,
            ...(input.preset ? { preset: input.preset } : {}),
          },
          onRunAdmission: async (run) => {
            if (input.continuation) {
              const starts = await run.store.readSessionEventsByKind(sessionId, "run.started", {
                order: "desc",
                limit: 2,
              });
              if (
                starts[0]?.event.runId !== run.runId ||
                starts[1]?.event.runId !== input.continuation.sourceRunId
              )
                throw new Error("Child session changed while admitting continuation");
            }
            runId = run.runId;
            turnId = run.currentTurnId;
            await run.recordTranscriptMessage({
              role: "assistant",
              content: `子任务身份: ${scope.agentName}`,
              providerData: {
                picoHiddenFromTranscript: true,
                picoConfiguredChild: childRecord("started"),
              },
            });
            if (input.continuation) await recordParent("started");
          },
        },
      );
      return {
        status: "completed",
        ...(input.continuation ? { resumedFromRunId: input.continuation.sourceRunId } : {}),
        sessionId: result.sessionId,
        childSessionId: result.sessionId,
        agentName: scope.agentName,
        permissionMode: "default",
        artifactIds: [],
        ...(turnId ? { turnId } : {}),
        ...(runId ? { runId } : {}),
        summary: result.finalMessage,
      };
    };
    reporter.onSubagentActivity?.({ ...scope, status: "running" });
    try {
      let result: ConfiguredSubagentExecutionResult;
      if (input.definition.workspace === "isolated-worktree") {
        const supervisor = options.worktreeSupervisor;
        if (!supervisor)
          throw new Error("implementation requires an available worktree child executor");
        let childResult: ConfiguredSubagentExecutionResult | undefined;
        let baseCommit = "";
        const task = supervisor.start(
          {
            description: input.task.slice(0, 240),
            branchSlug: "subagent",
            completionMode: "worktree_only",
            data: {
              subagentSessionId: sessionId,
              ...(input.preset ? { subagentPreset: input.preset } : {}),
            },
          },
          async (worktree) => {
            baseCommit = (
              await promisify(execFile)("git", ["rev-parse", "HEAD"], {
                cwd: worktree.worktreePath,
              })
            ).stdout.trim();
            const signal = input.signal
              ? AbortSignal.any([input.signal, worktree.signal])
              : worktree.signal;
            childResult = await execute(worktree.worktreePath, signal);
            return {
              summary: childResult.summary,
              data: { sessionId, ...(runId ? { runId } : {}) },
            };
          },
        );
        const abort = () => {
          void supervisor.stop(task.taskId);
        };
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        let settled;
        try {
          settled = await supervisor.wait(task.taskId);
        } finally {
          input.signal?.removeEventListener("abort", abort);
        }
        if (settled.status !== "completed" || !childResult)
          throw new Error(settled.error ?? `Worktree child ${settled.status}`);
        const patch = await promisify(execFile)(
          "git",
          ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, "HEAD", "--"],
          { cwd: settled.worktreePath, maxBuffer: 16 * 1024 * 1024 },
        );
        const outputDir = join(dirname(settled.worktreePath), ".pico-subagent-output");
        await mkdir(outputDir, { recursive: true });
        const patchPath = join(outputDir, `${sessionId}.patch`);
        await writeFile(patchPath, patch.stdout, "utf8");
        result = {
          ...childResult,
          artifactIds: [patchPath],
          patch: { path: patchPath, worktree: settled.worktreePath, branch: settled.branch },
        };
      } else result = await execute(options.workDir, input.signal);
      await recordParent("completed", result);
      reporter.onSubagentActivity?.({
        ...scope,
        durationMs: Date.now() - startedAt,
        status: "completed",
        summary: result.summary.slice(0, 2000),
      });
      return result;
    } catch (error) {
      if (!input.continuation || runId)
        await recordParent(input.signal?.aborted ? "cancelled" : "failed");
      reporter.onSubagentActivity?.({
        ...scope,
        durationMs: Date.now() - startedAt,
        status: input.signal?.aborted ? "cancelled" : "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Child task ${sessionId} failed: ${error instanceof Error ? error.message : String(error)} (childSessionId=${sessionId}; use agent_output to inspect)`,
        { cause: error },
      );
    }
  };
  executeChild.resume = async ({ childSessionId, task, signal }) => {
    const key = `${options.childDependencies?.picoHome ?? ""}:${options.workDir}:${childSessionId}`;
    if (continuingChildren.has(key))
      throw new Error("Child session continuation is already running");
    continuingChildren.add(key);
    try {
      signal?.throwIfAborted();
      const resolved = await resolveConfiguredSubagentContinuation(
        childSessionId,
        options.workDir,
        options.catalog,
      );
      return await executeChild({ ...resolved, task, ...(signal ? { signal } : {}) });
    } finally {
      continuingChildren.delete(key);
    }
  };
  return executeChild;
}
