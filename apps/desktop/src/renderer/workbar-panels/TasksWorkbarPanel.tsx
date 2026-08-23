import { CircleAlert, ListChecks, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";

export const WORKBAR_TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkbarTaskStatus = (typeof WORKBAR_TASK_STATUSES)[number];

export interface WorkbarTaskItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: WorkbarTaskStatus;
  readonly revision: number;
  readonly parentId?: string;
  readonly blockedReason?: string;
  readonly updatedAt?: string;
}

export interface WorkbarTaskLedger {
  readonly revision: number;
  readonly tasks: readonly WorkbarTaskItem[];
}

export interface WorkbarTaskCreateRequest {
  readonly title: string;
  readonly expectedLedgerRevision: number;
}

export interface WorkbarTaskUpdateRequest {
  readonly taskId: string;
  readonly status: WorkbarTaskStatus;
  readonly expectedTaskRevision: number;
  readonly expectedLedgerRevision: number;
}

export interface TasksWorkbarPanelProps {
  readonly ledger?: WorkbarTaskLedger;
  readonly loading: boolean;
  readonly error?: string | null;
  readonly readOnly?: boolean;
  readonly creating?: boolean;
  readonly updatingTaskIds?: ReadonlySet<string>;
  readonly onRefresh: () => void;
  readonly onCreate: (request: WorkbarTaskCreateRequest) => void;
  readonly onUpdate: (request: WorkbarTaskUpdateRequest) => void;
}

export function createTaskUpdateRequest(
  task: WorkbarTaskItem,
  status: WorkbarTaskStatus,
  ledgerRevision: number,
): WorkbarTaskUpdateRequest {
  return {
    taskId: task.id,
    status,
    expectedTaskRevision: task.revision,
    expectedLedgerRevision: ledgerRevision,
  };
}

export function TasksWorkbarPanel({
  ledger,
  loading,
  error,
  readOnly = false,
  creating = false,
  updatingTaskIds = new Set(),
  onRefresh,
  onCreate,
  onUpdate,
}: TasksWorkbarPanelProps) {
  const [title, setTitle] = useState("");
  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || !ledger || readOnly || creating) return;
    onCreate({ title: nextTitle, expectedLedgerRevision: ledger.revision });
    setTitle("");
  };

  return (
    <section className="tool-panel tool-panel--tasks" aria-label="待办">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">Session Ledger</span>
          <strong>待办</strong>
        </div>
        <div className="tool-panel__header-meta">
          <code>rev {ledger?.revision ?? "—"}</code>
          <button
            type="button"
            className="tool-panel__icon-button"
            aria-label="刷新待办"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}
      {readOnly && <p className="tool-panel__notice">当前任务只读，待办状态不能修改。</p>}

      <form className="tool-panel__create" onSubmit={submitCreate}>
        <label>
          <span className="sr-only">新待办标题</span>
          <input
            name="workbar-task-title"
            autoComplete="off"
            value={title}
            placeholder="添加待办…"
            disabled={readOnly || creating || !ledger}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button
          type="submit"
          aria-label="添加待办"
          disabled={readOnly || creating || !ledger || title.trim().length === 0}
        >
          <Plus aria-hidden="true" size={15} />
        </button>
      </form>

      <div className="tool-panel__scroll" aria-busy={loading}>
        {loading && !ledger ? (
          <p className="tool-panel__state" role="status">
            正在加载待办账本…
          </p>
        ) : !ledger || ledger.tasks.length === 0 ? (
          <div className="tool-panel__state">
            <ListChecks aria-hidden="true" size={21} />
            <strong>没有待办</strong>
            <span>Agent 或用户创建的待办会显示在这里。</span>
          </div>
        ) : (
          <ul className="tool-panel__task-list">
            {ledger.tasks.map((task) => {
              const updating = updatingTaskIds.has(task.id);
              return (
                <li
                  key={task.id}
                  data-status={task.status}
                  data-child={Boolean(task.parentId) || undefined}
                >
                  <span className="tool-panel__task-marker" aria-hidden="true" />
                  <div className="tool-panel__task-copy">
                    <strong>{task.title}</strong>
                    {task.description && <p>{task.description}</p>}
                    {task.blockedReason && (
                      <p className="tool-panel__task-blocked">阻塞：{task.blockedReason}</p>
                    )}
                    <small>
                      task rev {task.revision}
                      {task.updatedAt ? ` · ${formatTaskTimestamp(task.updatedAt)}` : ""}
                    </small>
                  </div>
                  <label className="tool-panel__task-status">
                    <span className="sr-only">更新“{task.title}”状态</span>
                    <select
                      name={`workbar-task-status-${task.id}`}
                      value={task.status}
                      disabled={readOnly || updating}
                      onChange={(event) => {
                        if (!ledger) return;
                        const status = event.target.value as WorkbarTaskStatus;
                        onUpdate(createTaskUpdateRequest(task, status, ledger.revision));
                      }}
                    >
                      {WORKBAR_TASK_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {taskStatusLabel(status)}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function taskStatusLabel(status: WorkbarTaskStatus): string {
  const labels: Record<WorkbarTaskStatus, string> = {
    pending: "待处理",
    in_progress: "进行中",
    blocked: "已阻塞",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status];
}

function formatTaskTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
