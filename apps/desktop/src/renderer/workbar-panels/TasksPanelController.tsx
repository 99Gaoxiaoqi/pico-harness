import type { RuntimeSessionTask } from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  TasksWorkbarPanel,
  type WorkbarTaskCreateRequest,
  type WorkbarTaskItem,
  type WorkbarTaskLedger,
  type WorkbarTaskUpdateRequest,
} from "./TasksWorkbarPanel.js";
import { useResourceFrame } from "./useResourceFrame.js";
import type { WorkbarPanelHostProps, WorkbarScope } from "./workbar-panel-contract.js";
import {
  invokeWorkbarRuntime,
  QUERY_PAGE_SIZE,
  workbarErrorMessage,
  workbarIdempotencyKey,
} from "./workbar-runtime.js";
import { timestampText } from "./workbar-values.js";

export function TasksPanelController({
  workspacePath,
  sessionId,
  instanceId,
  active,
  readOnly,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [ledger, setLedger] = useState<WorkbarTaskLedger>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [updatingTaskIds, setUpdatingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await queryAllWorkbarTasks(runtime, scope);
      if (request === requestRef.current) setLedger(next);
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, scope]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useResourceFrame(
    {
      active,
      sessionId,
      resource: "tasks",
      revision: ledger?.revision,
    },
    refresh,
  );

  const create = useCallback(
    async (request: WorkbarTaskCreateRequest) => {
      if (readOnly || creating) return;
      setCreating(true);
      setError(undefined);
      try {
        await invokeWorkbarRuntime(runtime, "session.tasks.command", {
          ...scope,
          action: "create",
          title: request.title,
          expectedRevision: request.expectedLedgerRevision,
          idempotencyKey: workbarIdempotencyKey(instanceId, "task-create"),
        });
        await refresh();
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      } finally {
        setCreating(false);
      }
    },
    [creating, instanceId, readOnly, refresh, runtime, scope],
  );

  const update = useCallback(
    async (request: WorkbarTaskUpdateRequest) => {
      if (readOnly || updatingTaskIds.has(request.taskId)) return;
      const current = ledger?.tasks.find((task) => task.id === request.taskId);
      if (!current || current.revision !== request.expectedTaskRevision) {
        setError("待办已被其他操作更新，请刷新后重试。");
        return;
      }
      setUpdatingTaskIds((ids) => new Set(ids).add(request.taskId));
      setError(undefined);
      try {
        await invokeWorkbarRuntime(runtime, "session.tasks.command", {
          ...scope,
          action: "update",
          taskId: request.taskId,
          status: request.status,
          expectedRevision: request.expectedLedgerRevision,
          idempotencyKey: workbarIdempotencyKey(instanceId, `task-update:${request.taskId}`),
        });
        await refresh();
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      } finally {
        setUpdatingTaskIds((ids) => {
          const next = new Set(ids);
          next.delete(request.taskId);
          return next;
        });
      }
    },
    [instanceId, ledger?.tasks, readOnly, refresh, runtime, scope, updatingTaskIds],
  );

  return (
    <TasksWorkbarPanel
      ledger={ledger}
      loading={loading}
      error={error}
      readOnly={readOnly}
      creating={creating}
      updatingTaskIds={updatingTaskIds}
      onRefresh={() => void refresh()}
      onCreate={(request) => void create(request)}
      onUpdate={(request) => void update(request)}
    />
  );
}

export async function queryAllWorkbarTasks(
  runtime: DesktopRuntimeApi,
  scope: WorkbarScope,
): Promise<WorkbarTaskLedger> {
  let cursor: string | undefined;
  let revision: number | undefined;
  const tasks: WorkbarTaskItem[] = [];
  do {
    const page = await invokeWorkbarRuntime(runtime, "session.tasks.query", {
      ...scope,
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(revision === undefined ? {} : { revision }),
    });
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error("待办分页版本发生变化，请重试。");
    tasks.push(...page.tasks.map(taskView));
    cursor = page.nextCursor;
  } while (cursor);
  return { revision: revision ?? 0, tasks };
}

function taskView(task: RuntimeSessionTask): WorkbarTaskItem {
  return {
    id: task.taskId,
    title: task.title,
    status: task.status,
    revision: task.version,
    ...(task.detail ? { description: task.detail } : {}),
    updatedAt: timestampText(task.updatedAt),
  };
}
