import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceReview, TaskExperienceCandidate } from "@pico/core";
import type { RuntimeParams, RuntimeResult } from "@pico/protocol";
import type { RuntimeStore } from "./runtime.js";

export type ExperienceReviewRequest = Omit<
  RuntimeParams<"memory.learning.review">,
  "workspacePath"
>;
export type ExperienceFeedbackRequest = Omit<
  RuntimeParams<"memory.learning.feedback">,
  "workspacePath"
>;
export type ExperienceDetail = RuntimeResult<"memory.learning.detail">;

export interface TaskExperienceState {
  readonly supported: boolean;
  readonly learningVersion: 2 | 3;
  readonly receipts: NonNullable<RuntimeResult<"memory.learning.query">["receipts"]>;
  readonly items: RuntimeResult<"memory.learning.query">["items"];
  readonly reuse: RuntimeResult<"memory.learning.query">["reuse"];
  readonly workspaceKey: string;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly onDetail: (candidateId: string) => Promise<ExperienceDetail>;
  readonly onReview: (request: ExperienceReviewRequest) => Promise<TaskExperienceCandidate>;
  readonly onFeedback: (request: ExperienceFeedbackRequest) => Promise<TaskExperienceCandidate>;
}

/** Management remains available when automatic learning or recall is switched off. */
export function useTaskExperience(
  runtime: RuntimeStore,
  input: {
    readonly workspacePath?: string;
    readonly sessionId?: string;
    readonly review?: ExperienceReview;
    readonly refreshKey?: string;
    readonly enabled?: boolean;
  },
): TaskExperienceState {
  const { workspacePath, sessionId, review, refreshKey } = input;
  const { actions, data, connection, preview, executionLearningRevision } = runtime;
  const enabled = Boolean(
    input.enabled !== false &&
    runtime.taskExperienceSupported &&
    !preview &&
    connection.kind === "ready" &&
    workspacePath &&
    data.workspacePath === workspacePath &&
    data.trusted,
  );
  const scope = JSON.stringify([
    workspacePath,
    sessionId,
    review,
    enabled,
    runtime.memoryLearningVersion,
  ]);
  const scopeRef = useRef({ scope, generation: 0 });
  if (scopeRef.current.scope !== scope)
    scopeRef.current = { scope, generation: scopeRef.current.generation + 1 };
  const generation = scopeRef.current.generation;
  const sequence = useRef(0);
  const mounted = useRef(true);
  const [projection, setProjection] = useState<{
    scope: string;
    generation: number;
    result: RuntimeResult<"memory.learning.query">;
  }>();
  const [error, setError] = useState<{ scope: string; generation: number; message: string }>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const results =
        runtime.memoryLearningVersion === 3
          ? await Promise.all(
              ["method", "case"].map((representation) =>
                actions.queryTaskExperiences(workspacePath, {
                  sessionId,
                  review,
                  representation: representation as "method" | "case",
                }),
              ),
            )
          : [await actions.queryTaskExperiences(workspacePath, { sessionId, review })];
      const result = {
        ...results[0]!,
        revision: Math.max(...results.map((page) => page.revision)),
        items: [
          ...new Map(
            results.flatMap((page) => page.items).map((item) => [item.candidateId, item]),
          ).values(),
        ],
        reuse: [
          ...new Map(
            results.flatMap((page) => page.reuse).map((item) => [item.reuseId, item]),
          ).values(),
        ],
        receipts: [
          ...new Map(
            results
              .flatMap((page) => page.receipts ?? [])
              .map((receipt) => [receipt.operationId, receipt]),
          ).values(),
        ],
      };
      if (
        !mounted.current ||
        scopeRef.current.scope !== scope ||
        scopeRef.current.generation !== generation ||
        request !== sequence.current
      )
        return;
      setProjection((current) =>
        current?.scope === scope &&
        current.generation === generation &&
        current.result.revision > result.revision
          ? current
          : {
              scope,
              generation,
              result: {
                ...result,
                items: result.items
                  .filter((item) => item.kind === "task-lesson")
                  .map((item) => {
                    const previous =
                      current?.scope === scope && current.generation === generation
                        ? current.result.items.find(
                            (value) => value.candidateId === item.candidateId,
                          )
                        : undefined;
                    return previous && previous.recordRevision > item.recordRevision
                      ? previous
                      : item;
                  }),
              },
            },
      );
      setError(undefined);
    } catch {
      if (
        mounted.current &&
        scopeRef.current.scope === scope &&
        scopeRef.current.generation === generation &&
        request === sequence.current
      )
        setError({ scope, generation, message: "无法读取任务经验。已加载的内容仍保留，请重试。" });
    } finally {
      if (
        mounted.current &&
        scopeRef.current.scope === scope &&
        scopeRef.current.generation === generation &&
        request === sequence.current
      )
        setLoading(false);
    }
  }, [
    actions,
    enabled,
    workspacePath,
    scope,
    generation,
    sessionId,
    review,
    runtime.memoryLearningVersion,
  ]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh, refreshKey, executionLearningRevision]);
  const guard = useCallback(() => {
    if (
      !enabled ||
      !workspacePath ||
      !mounted.current ||
      scopeRef.current.scope !== scope ||
      scopeRef.current.generation !== generation
    )
      throw new Error("当前工作区已切换。");
    return workspacePath;
  }, [enabled, scope, generation, workspacePath]);
  const update = useCallback(
    (candidate: TaskExperienceCandidate) => {
      if (
        !mounted.current ||
        scopeRef.current.scope !== scope ||
        scopeRef.current.generation !== generation
      )
        return;
      setProjection((current) =>
        current?.scope === scope && current.generation === generation
          ? {
              ...current,
              result: {
                ...current.result,
                items: current.result.items.map((item) =>
                  item.candidateId === candidate.candidateId &&
                  item.recordRevision <= candidate.recordRevision
                    ? candidate
                    : item,
                ),
              },
            }
          : current,
      );
    },
    [scope, generation],
  );
  const onDetail = useCallback(
    async (candidateId: string) => {
      const result = await actions.detailTaskExperience(guard(), candidateId);
      if (
        !mounted.current ||
        scopeRef.current.scope !== scope ||
        scopeRef.current.generation !== generation
      )
        throw new Error("当前工作区已切换。");
      update(result.candidate);
      return result;
    },
    [actions, guard, scope, generation, update],
  );
  const onReview = useCallback(
    async (request: ExperienceReviewRequest) => {
      const candidate = await actions.reviewTaskExperience(guard(), request);
      if (
        !mounted.current ||
        scopeRef.current.scope !== scope ||
        scopeRef.current.generation !== generation
      )
        throw new Error("当前工作区已切换。");
      update(candidate);
      void refresh();
      return candidate;
    },
    [actions, guard, scope, generation, update, refresh],
  );
  const onFeedback = useCallback(
    async (request: ExperienceFeedbackRequest) => {
      const candidate = await actions.feedbackTaskExperience(guard(), request);
      if (
        !mounted.current ||
        scopeRef.current.scope !== scope ||
        scopeRef.current.generation !== generation
      )
        throw new Error("当前工作区已切换。");
      update(candidate);
      void refresh();
      return candidate;
    },
    [actions, guard, scope, generation, update, refresh],
  );
  const result =
    enabled && projection?.scope === scope && projection.generation === generation
      ? projection.result
      : undefined;
  return {
    supported: Boolean(runtime.taskExperienceSupported),
    learningVersion: runtime.memoryLearningVersion ?? 2,
    receipts: result?.receipts ?? [],
    items: result?.items ?? [],
    reuse: result?.reuse ?? [],
    workspaceKey: result?.workspaceKey ?? "",
    error:
      enabled && error?.scope === scope && error.generation === generation
        ? error.message
        : undefined,
    loading: enabled && loading,
    refresh,
    onDetail,
    onReview,
    onFeedback,
  };
}
