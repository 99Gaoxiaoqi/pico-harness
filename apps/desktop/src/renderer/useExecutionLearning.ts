import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeResult } from "@pico/protocol";
import type { ExecutionLearningInspection } from "./ExecutionLearningPanel.js";
import type { RuntimeStore } from "./runtime.js";

interface ExecutionLearningScope {
  readonly workspacePath?: string;
  readonly sessionId?: string;
  readonly refreshKey?: string;
  readonly enabled?: boolean;
}

export function useExecutionLearning(
  runtime: RuntimeStore,
  {
    workspacePath,
    sessionId,
    refreshKey,
    enabled: requestedEnabled = true,
  }: ExecutionLearningScope,
) {
  const { actions, data, preview, executionLearningRevision, connection } = runtime;
  const settings = data.memory.settings;
  const enabled = Boolean(
    requestedEnabled &&
    !preview &&
    connection?.kind === "ready" &&
    workspacePath &&
    data.workspacePath === workspacePath &&
    data.trusted &&
    settings?.enabled &&
    settings.autoExtract &&
    typeof actions.listExecutionLearning === "function",
  );
  const scope = JSON.stringify([workspacePath, sessionId, enabled, settings?.version]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const request = useRef(0);
  const mounted = useRef(true);
  const [projection, setProjection] = useState<{
    scope: string;
    result: RuntimeResult<"memory.learning.list">;
  }>();
  const [error, setError] = useState<{ scope: string; message: string }>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !workspacePath || !mounted.current) return;
    const sequence = ++request.current;
    try {
      const result = await actions.listExecutionLearning(workspacePath, sessionId);
      if (!mounted.current || scopeRef.current !== scope || sequence !== request.current) return;
      setProjection((current) =>
        current?.scope === scope && current.result.revision > result.revision
          ? current
          : { scope, result },
      );
      setError(undefined);
    } catch {
      if (mounted.current && scopeRef.current === scope && sequence === request.current)
        setError({ scope, message: "无法读取执行经验，请刷新后重试。" });
    }
  }, [actions, enabled, scope, sessionId, workspacePath]);

  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh, refreshKey, executionLearningRevision]);

  const onInspect = useCallback(
    async (candidateId: string): Promise<ExecutionLearningInspection | undefined> => {
      if (!enabled || !workspacePath || scopeRef.current !== scope) return undefined;
      const candidate = await actions.inspectExecutionLearning(workspacePath, candidateId);
      return mounted.current && scopeRef.current === scope ? candidate : undefined;
    },
    [actions, enabled, scope, workspacePath],
  );
  const onDiscard = useCallback(
    async (candidateId: string, revision: number) => {
      if (!enabled || !workspacePath || scopeRef.current !== scope)
        throw new Error("当前工作区已切换。");
      try {
        await actions.discardExecutionLearning(workspacePath, candidateId, revision);
      } finally {
        if (mounted.current && scopeRef.current === scope) await refresh();
      }
    },
    [actions, enabled, refresh, scope, workspacePath],
  );
  const result = enabled && projection?.scope === scope ? projection.result : undefined;
  return {
    statuses: result?.items ?? [],
    workspaceKey: result?.workspaceKey ?? "",
    error: enabled && error?.scope === scope ? error.message : undefined,
    onInspect,
    onDiscard,
  };
}
