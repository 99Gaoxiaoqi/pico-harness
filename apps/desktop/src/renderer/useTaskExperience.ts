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
) {
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
  const scope = JSON.stringify([workspacePath, sessionId, review, enabled]);
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
      const result = await actions.queryTaskExperiences(workspacePath, { sessionId, review });
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
                items: result.items.map((item) => {
                  const previous =
                    current?.scope === scope && current.generation === generation
                      ? current.result.items.find((value) => value.candidateId === item.candidateId)
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
  }, [actions, enabled, workspacePath, scope, generation, sessionId, review]);
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
