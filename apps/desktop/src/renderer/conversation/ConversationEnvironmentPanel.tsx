import { ChevronDown, FileDiff, GitBranch, Laptop } from "lucide-react";
import { useState } from "react";
import { Button } from "../components.js";
import type { ChangeView, ConversationView, WorkspaceMode } from "../model.js";
import { formatCompact } from "../view-format.js";
import { workspaceName } from "../workspace-session.js";

interface ConversationEnvironmentPanelProps {
  readonly view: "overview" | "review" | "context";
  readonly workspacePath: string;
  readonly workspaceLabel?: string | undefined;
  readonly mode: WorkspaceMode;
  readonly branch?: string | undefined;
  readonly changes: readonly ChangeView[];
  readonly active: boolean;
  readonly model?: string | undefined;
  readonly context?: ConversationView["context"];
  readonly collaborationMode?: "agent" | "plan" | undefined;
  readonly orchestrationMode?: "default" | "graph" | "swarm" | undefined;
  readonly permissionMode?: "default" | "auto" | "yolo" | undefined;
  readonly onReview: () => void;
}

export function ConversationEnvironmentPanel({
  view,
  workspacePath,
  workspaceLabel,
  mode,
  branch,
  changes,
  active,
  model,
  context,
  collaborationMode,
  orchestrationMode,
  permissionMode,
  onReview,
}: ConversationEnvironmentPanelProps) {
  const [worktreeExpanded, setWorktreeExpanded] = useState(false);
  const [branchExpanded, setBranchExpanded] = useState(false);
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const permissionLabels = {
    default: "默认权限",
    auto: "自动模式",
    yolo: "完全访问",
  } as const;

  return (
    <section className="conversation-environment-shell" aria-label="任务工作台">
      <section className="conversation-environment-panel">
        <div
          className="conversation-environment-panel__body"
          aria-label={view === "overview" ? "概览" : view === "review" ? "变更" : "上下文"}
        >
          {view === "overview" && (
            <div className="conversation-environment-panel__rows">
              <button
                type="button"
                className="conversation-environment-row conversation-environment-row--changes"
                disabled={changes.length === 0}
                onClick={onReview}
              >
                <FileDiff aria-hidden="true" />
                <span>文件变更</span>
                <span className="conversation-change-stats">
                  {active && changes.length === 0 ? (
                    <small>运行中</small>
                  ) : changes.length === 0 ? (
                    <small>暂无</small>
                  ) : (
                    <>
                      <b>+{additions.toLocaleString()}</b>
                      <em>-{deletions.toLocaleString()}</em>
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="conversation-environment-row"
                aria-expanded={worktreeExpanded}
                onClick={() => setWorktreeExpanded((expanded) => !expanded)}
              >
                <Laptop aria-hidden="true" />
                <span>{mode === "git" ? "本地工作树" : "本地文件夹"}</span>
                <ChevronDown
                  className={worktreeExpanded ? "is-expanded" : undefined}
                  aria-hidden="true"
                />
              </button>
              {worktreeExpanded && (
                <div className="conversation-environment-detail">
                  <p title={workspacePath}>{workspacePath}</p>
                </div>
              )}
              {mode === "git" && (
                <>
                  <button
                    type="button"
                    className="conversation-environment-row"
                    aria-expanded={branchExpanded}
                    onClick={() => setBranchExpanded((expanded) => !expanded)}
                  >
                    <GitBranch aria-hidden="true" />
                    <span>{branch ?? "Detached HEAD"}</span>
                    <ChevronDown
                      className={branchExpanded ? "is-expanded" : undefined}
                      aria-hidden="true"
                    />
                  </button>
                  {branchExpanded && (
                    <div className="conversation-environment-detail conversation-environment-detail--branch">
                      当前工作树分支；切换与合并仍由项目 Git 工具负责。
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {view === "review" && (
            <div className="conversation-workbench__changes">
              {changes.length === 0 ? (
                <div className="conversation-workbench__empty">
                  <FileDiff aria-hidden="true" />
                  <strong>{active ? "等待本次运行完成" : "没有可显示的变更检查点"}</strong>
                  <p>
                    {active
                      ? "运行结束后，这里会显示固化的变更检查点。"
                      : "这里仅展示已结束运行固化的变更，不代表当前工作区是干净的。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="conversation-workbench__change-summary">
                    <span>{changes.length} 个文件</span>
                    <span className="conversation-change-stats">
                      <b>+{additions.toLocaleString()}</b>
                      <em>-{deletions.toLocaleString()}</em>
                    </span>
                  </div>
                  <ol className="conversation-workbench__file-list">
                    {changes.map((change) => (
                      <li key={`${change.status}:${change.path}`}>
                        <span data-status={change.status}>
                          {change.status.slice(0, 1).toUpperCase()}
                        </span>
                        <code title={change.path}>{change.path}</code>
                        <small>
                          +{change.additions} −{change.deletions}
                        </small>
                      </li>
                    ))}
                  </ol>
                  <Button variant="quiet" onClick={onReview}>
                    打开完整审阅
                  </Button>
                </>
              )}
            </div>
          )}
          {view === "context" && (
            <div className="conversation-workbench__context">
              <dl>
                {context && (
                  <>
                    <div>
                      <dt>上下文</dt>
                      <dd>
                        {formatCompact(context.estimatedInputTokens)} /{" "}
                        {formatCompact(context.inputBudgetTokens)}
                      </dd>
                    </div>
                    <div>
                      <dt>已用</dt>
                      <dd>
                        {context.usedPercent.toFixed(1)}%（
                        {context.estimation === "estimated" ? "估算" : context.estimation}）
                      </dd>
                    </div>
                    <div>
                      <dt>剩余</dt>
                      <dd>约 {formatCompact(context.remainingTokens)} tokens</dd>
                    </div>
                    <div>
                      <dt>窗口</dt>
                      <dd>
                        {formatCompact(context.contextWindowTokens)}，预留输出{" "}
                        {formatCompact(context.reservedOutputTokens)}
                      </dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Runtime</dt>
                  <dd>
                    <i aria-hidden="true" />
                    已连接
                  </dd>
                </div>
                <div>
                  <dt>项目</dt>
                  <dd title={workspacePath}>{workspaceLabel ?? workspaceName(workspacePath)}</dd>
                </div>
                <div>
                  <dt>模式</dt>
                  <dd>{mode === "git" ? "Git 工作树" : "本地文件夹"}</dd>
                </div>
                {model && (
                  <div>
                    <dt>模型</dt>
                    <dd>{model}</dd>
                  </div>
                )}
                {permissionMode && (
                  <div>
                    <dt>权限</dt>
                    <dd>{permissionLabels[permissionMode]}</dd>
                  </div>
                )}
                {collaborationMode && (
                  <div>
                    <dt>协作</dt>
                    <dd>{collaborationMode === "plan" ? "计划模式" : "Agent 模式"}</dd>
                  </div>
                )}
                {orchestrationMode && (
                  <div>
                    <dt>编排</dt>
                    <dd>
                      {orchestrationMode === "swarm"
                        ? "Swarm 模式"
                        : orchestrationMode === "graph"
                          ? "Graph 模式"
                          : "线性"}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
