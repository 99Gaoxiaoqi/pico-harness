import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceUse } from "@pico/core";
import type { RuntimeMemoryItem, RuntimeParams, RuntimeResult } from "@pico/protocol";
import type { RuntimeStore } from "./runtime.js";

export type ExperienceUseFeedbackRequest = Omit<
  RuntimeParams<"memory.experience.feedback">,
  "workspacePath"
>;
export type ExperienceUseDetail = RuntimeResult<"memory.experience.detail"> & {
  readonly currentItem?: RuntimeMemoryItem;
  readonly currentItemUnavailable?: boolean;
  readonly managementError?: string;
};

export function newerExperienceUse(
  previous: ExperienceUse | undefined,
  incoming: ExperienceUse,
): ExperienceUse {
  if (!previous) return incoming;
  if (
    previous.managementRevision > incoming.managementRevision ||
    previous.deletionRevision > incoming.deletionRevision ||
    (previous.managementRevision === incoming.managementRevision &&
      previous.updatedAt > incoming.updatedAt)
  )
    return previous;
  return incoming;
}

/** This ledger includes all three experience sources, with immutable version identities. */
export function useExperienceLedger(
  runtime: RuntimeStore,
  input: {
    readonly workspacePath?: string;
    readonly sessionId?: string;
    readonly refreshKey?: string;
    readonly enabled?: boolean;
  },
) {
  const { workspacePath, sessionId, refreshKey } = input;
  const { actions, data, connection, preview, executionLearningRevision } = runtime;
  const supported = Boolean(runtime.experienceFeedbackSupported);
  const enabled = Boolean(
    input.enabled !== false &&
    supported &&
    !preview &&
    connection.kind === "ready" &&
    workspacePath &&
    data.workspacePath === workspacePath &&
    data.trusted,
  );
  const scope = JSON.stringify([workspacePath, sessionId, enabled, runtime.memoryLearningVersion]);
  const scopeRef = useRef({ scope, generation: 0 });
  if (scopeRef.current.scope !== scope)
    scopeRef.current = { scope, generation: scopeRef.current.generation + 1 };
  const generation = scopeRef.current.generation;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const loadingRef = useRef(false);
  const [projection, setProjection] = useState<{
    scope: string;
    generation: number;
    result: RuntimeResult<"memory.experience.query">;
  }>();
  const [error, setError] = useState<{ scope: string; generation: number; message: string }>();
  const [loading, setLoading] = useState(false);
  const valid = useCallback(
    () =>
      mounted.current &&
      scopeRef.current.scope === scope &&
      scopeRef.current.generation === generation,
    [scope, generation],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);
  const update = useCallback(
    (use: ExperienceUse) => {
      if (!valid()) return;
      setProjection((current) =>
        current?.scope === scope && current.generation === generation
          ? {
              ...current,
              result: {
                ...current.result,
                uses: current.result.uses.map((value) =>
                  value.useId === use.useId ? newerExperienceUse(value, use) : value,
                ),
              },
            }
          : current,
      );
    },
    [scope, valid],
  );
  const read = useCallback(
    async (cursor?: string) => {
      if (!enabled || !workspacePath || !valid()) return;
      const request = ++sequence.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const result = await actions.queryExperienceUses(workspacePath, {
          ...(sessionId ? { sessionId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 50,
        });
        if (!valid() || request !== sequence.current) return;
        setProjection((current) => {
          const previous =
            current?.scope === scope && current.generation === generation
              ? current.result.uses
              : [];
          const uses = result.uses.map((use) =>
            newerExperienceUse(
              previous.find((value) => value.useId === use.useId),
              use,
            ),
          );
          return {
            scope,
            generation,
            result: {
              ...result,
              uses: cursor
                ? [
                    ...previous.filter((use) => !uses.some((value) => value.useId === use.useId)),
                    ...uses,
                  ]
                : uses,
            },
          };
        });
        setError(undefined);
      } catch {
        if (valid() && request === sequence.current)
          setError({
            scope,
            generation,
            message: "无法读取经验使用记录。已加载记录仍保留，请重试。",
          });
      } finally {
        if (valid() && request === sequence.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [actions, enabled, workspacePath, sessionId, valid, scope],
  );
  const refresh = useCallback(() => read(), [read]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
      loadingRef.current = false;
    };
  }, [refresh, refreshKey, executionLearningRevision]);
  const guard = useCallback(() => {
    if (!enabled || !workspacePath || !valid()) throw new Error("当前工作区已切换或连接不可用。");
    return workspacePath;
  }, [enabled, workspacePath, valid]);
  const onDetail = useCallback(
    async (useId: string) => {
      const detail = await actions.detailExperienceUse(guard(), useId);
      if (!valid()) throw new Error("当前工作区已切换。");
      let management: Pick<
        ExperienceUseDetail,
        "currentItem" | "currentItemUnavailable" | "managementError"
      > = {};
      if (typeof actions.getExperienceMemoryItem === "function") {
        try {
          const currentItem = await actions.getExperienceMemoryItem(guard(), detail.use.itemId);
          management = currentItem ? { currentItem } : { currentItemUnavailable: true };
        } catch {
          management = {
            managementError: "当前记忆管理状态读取失败，请重试。历史使用记录仍保留。",
          };
        }
      }
      if (!valid()) throw new Error("当前工作区已切换。");
      update(detail.use);
      return { ...detail, ...management };
    },
    [actions, guard, valid, update],
  );
  const onFeedback = useCallback(
    async (request: ExperienceUseFeedbackRequest) => {
      const result = await actions.feedbackExperienceUse(guard(), request);
      if (!valid()) throw new Error("当前工作区已切换。");
      update(result.use);
      void refresh();
      return result.use;
    },
    [actions, guard, valid, update, refresh],
  );
  const result =
    enabled && projection?.scope === scope && projection.generation === generation
      ? projection.result
      : undefined;
  const loadMore = useCallback(async () => {
    if (!loadingRef.current && result?.nextCursor) await read(result.nextCursor);
  }, [read, result?.nextCursor]);
  return {
    supported,
    learningVersion: runtime.memoryLearningVersion ?? 2,
    uses: result?.uses ?? [],
    diagnostics: result?.diagnostics ?? [],
    hasMore: Boolean(result?.nextCursor),
    loading: enabled && loading,
    error:
      enabled && error?.scope === scope && error.generation === generation
        ? error.message
        : undefined,
    refresh,
    loadMore,
    onDetail,
    onFeedback,
  };
}
