import { Button as AstryxButton } from "@astryxdesign/core/Button";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FileDiff,
  ListChecks,
  LoaderCircle,
  ShieldQuestion,
  Sparkles,
  WandSparkles,
  SearchCode,
  GitBranch,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { sanitizeMarkdownText } from "@pico/protocol";
import type {
  ConversationItemView,
  ConversationProgressState,
  RunBoundaryItemView,
  SubagentItemView,
  ToolItemView,
  ThinkingItemView,
} from "./types.js";
import { conversationItemKey, mergeConversationItemGroups } from "./items.js";
import { MarkdownText, referencedMediaIds } from "./MarkdownText.js";
import { MediaProvider, MediaPreview, type MediaScope } from "./MediaPreview.js";
import { loadedAgentTools } from "./agent-capability.js";
import { WebSearchRecord } from "./WebSearchRecord.js";
import {
  foldConversationProcess,
  type ConversationProcessView,
  type TranscriptActiveRun,
} from "./process-fold.js";

export interface ConversationTranscriptProps {
  readonly mediaScope?: MediaScope | undefined;
  readonly activeRun?: TranscriptActiveRun | undefined;
  readonly assistantLabel?: string | undefined;
  readonly items: readonly ConversationItemView[];
  readonly label?: string | undefined;
  readonly emptyState?: ReactNode | undefined;
  readonly onOpenItem?: ((item: ConversationItemView) => void) | undefined;
  readonly renderText?: ((text: string, item: ConversationItemView) => ReactNode) | undefined;
  readonly renderItem?:
    | ((item: ConversationItemView, fallback: ReactNode) => ReactNode)
    | undefined;
}

interface ConversationTurnView {
  readonly key: string;
  readonly items: readonly (ConversationItemView | ConversationProcessView)[];
}

/**
 * The transport still exposes a mixed transcript stream. A user message is the one stable
 * boundary shared by persisted and live projections, so the renderer keeps everything until
 * the next user message in the same visual turn without inventing event identities.
 */
export function groupConversationItemsIntoTurns(
  items: readonly (ConversationItemView | ConversationProcessView)[],
): readonly ConversationTurnView[] {
  const turns: { key: string; items: (ConversationItemView | ConversationProcessView)[] }[] = [];
  for (const item of items) {
    if (item.kind === "userMessage" || turns.length === 0) {
      turns.push({
        key:
          item.kind === "userMessage"
            ? `turn:${conversationItemKey(item)}`
            : `context:${item.kind === "process" ? item.key : conversationItemKey(item)}`,
        items: [item],
      });
      continue;
    }
    turns.at(-1)?.items.push(item);
  }
  return turns;
}

const stateLabels: Readonly<Record<ConversationProgressState, string>> = {
  waiting: "等待中",
  active: "进行中",
  done: "已完成",
  failed: "失败",
};

function StateIcon({ state }: { readonly state: ConversationProgressState }) {
  if (state === "done") return <CheckCircle2 aria-hidden="true" />;
  if (state === "active") return <LoaderCircle aria-hidden="true" />;
  if (state === "failed") return <AlertCircle aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

function RunBoundary({ item }: { readonly item: RunBoundaryItemView }) {
  const labels: Readonly<Record<RunBoundaryItemView["status"], string>> = {
    started: "",
    completed: "运行完成",
    interrupted: "运行已停止",
    failed: "运行失败",
  };
  const Icon =
    item.status === "failed" ? AlertCircle : item.status === "completed" ? Check : Circle;
  return (
    <div className="conversation-run-boundary" data-status={item.status}>
      <span className="conversation-run-boundary__summary">
        <Icon aria-hidden="true" />
        {labels[item.status]}
      </span>
      {item.duration && (
        <span className="conversation-run-boundary__duration">{item.duration}</span>
      )}
      {item.detail && <span className="conversation-run-boundary__detail">{item.detail}</span>}
    </div>
  );
}

function DetailButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <AstryxButton
      label={label}
      variant="ghost"
      type="button"
      className="pico-page-control conversation-detail-button"
      onClick={onClick}
    >
      <span>{label}</span>
      <ChevronRight aria-hidden="true" size={15} />
    </AstryxButton>
  );
}

function SubagentRow({
  item,
  onOpenItem,
}: {
  readonly item: SubagentItemView;
  readonly onOpenItem?: ((item: ConversationItemView) => void) | undefined;
}) {
  const canOpen = Boolean(item.childSessionId && onOpenItem);
  const summary = item.detail ?? item.title;
  const duration =
    item.durationMs !== undefined && Number.isFinite(item.durationMs) && item.durationMs >= 0
      ? `${(item.durationMs / 1000).toFixed(1)}s`
      : undefined;
  const metadata = [
    item.state === "active" ? "运行中" : stateLabels[item.state],
    item.readOnly ? "只读" : undefined,
    duration,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <AstryxButton
      label={canOpen ? `查看${item.name}的会话` : `${item.name} · ${metadata}`}
      variant="ghost"
      type="button"
      className="pico-page-control conversation-subagent-row"
      data-state={item.state}
      isDisabled={!canOpen}
      aria-label={canOpen ? `查看${item.name}的会话` : `${item.name} · ${metadata}`}
      tooltip={summary}
      onClick={canOpen ? () => onOpenItem?.(item) : undefined}
    >
      <span className="conversation-subagent-row__identity">
        <GitBranch className="conversation-subagent-row__icon" aria-hidden="true" />
        <span className="conversation-agent-role" data-child="true">
          子智能体
        </span>
        <strong className="conversation-subagent-row__name">{item.name}</strong>
      </span>
      <span className="conversation-subagent-row__meta">
        <span className="conversation-subagent-row__dot" aria-hidden="true" />
        {metadata}
      </span>
      <span className="conversation-subagent-row__summary">{summary}</span>
      {canOpen && (
        <span className="conversation-subagent-row__action">
          查看运行
          <ChevronRight className="conversation-subagent-row__chevron" aria-hidden="true" />
        </span>
      )}
    </AstryxButton>
  );
}

function visibleTurnItems(items: readonly ConversationItemView[]): readonly ConversationItemView[] {
  const representedCalls = new Set(
    items.flatMap((item) => (item.kind === "subagent" && item.toolCallId ? [item.toolCallId] : [])),
  );
  return items.filter((item) => {
    if (item.kind !== "tool" || item.toolName !== "agent_spawn") return true;
    const toolCallId =
      item.result?.toolCallId ??
      item.toolCallId ??
      (item.id.startsWith("tool:") ? item.id.slice(5) : undefined);
    return !toolCallId || !representedCalls.has(toolCallId);
  });
}

interface ToolGroupView {
  readonly kind: "toolGroup";
  readonly key: string;
  readonly items: readonly ToolItemView[];
}

type TranscriptDisplayItem = ConversationItemView | ToolGroupView;

// A Run owns the assistant's response to a user input. Runtime turnId changes on
// each model iteration, so it must not split otherwise adjacent tool activity.
function groupConsecutiveRunTools(
  items: readonly ConversationItemView[],
): readonly TranscriptDisplayItem[] {
  const visibleItems = visibleTurnItems(items);
  const grouped: TranscriptDisplayItem[] = [];
  for (let index = 0; index < visibleItems.length; ) {
    const item = visibleItems[index]!;
    if (item.kind !== "tool" || !item.runId) {
      grouped.push(item);
      index++;
      continue;
    }

    const siblings: ToolItemView[] = [item];
    let nextIndex = index + 1;
    while (nextIndex < visibleItems.length) {
      const candidate = visibleItems[nextIndex]!;
      if (candidate.kind !== "tool" || candidate.runId !== item.runId) {
        break;
      }
      siblings.push(candidate);
      nextIndex++;
    }

    if (siblings.length > 1) {
      grouped.push({
        kind: "toolGroup",
        key: `tool-group:${siblings[0]!.id}`,
        items: siblings,
      });
    } else {
      grouped.push(item);
    }
    index = nextIndex;
  }
  return grouped;
}

function toolGroupSummary(items: readonly ToolItemView[]) {
  const completed = items.filter((item) => item.state === "done").length;
  const active = items.filter((item) => item.state === "active").length;
  const waiting = items.filter((item) => item.state === "waiting").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const state: ConversationProgressState =
    failed > 0 ? "failed" : active > 0 ? "active" : waiting > 0 ? "waiting" : "done";
  const statuses = [
    completed > 0 ? `${completed} 完成` : undefined,
    active > 0 ? `${active} 运行中` : undefined,
    waiting > 0 ? `${waiting} 等待中` : undefined,
    failed > 0 ? `${failed} 失败` : undefined,
  ].filter((value): value is string => value !== undefined);
  const firstFailure = items.find((item) => item.state === "failed");
  const failureOutput = firstFailure?.output
    ?.split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  const failurePreview = failureOutput
    ? failureOutput.length > 96
      ? `${failureOutput.slice(0, 95)}…`
      : failureOutput
    : firstFailure
      ? "工具执行失败"
      : undefined;

  return {
    state,
    active,
    waiting,
    failed,
    statuses: statuses.join(" · "),
    failure: firstFailure
      ? { toolName: firstFailure.toolName, preview: failurePreview ?? "工具执行失败" }
      : undefined,
  };
}

const goalToolLabels: Readonly<Record<string, string>> = {
  create_goal: "设置 Goal",
  get_goal: "查看 Goal",
  pause_goal: "暂停 Goal",
  resume_goal: "继续 Goal",
  clear_goal: "清除 Goal",
};
function toolLabel(name: string): string {
  return goalToolLabels[name] ?? name;
}

// Keep the full invocation in the disclosure. The row only needs a readable
// destination, command, or query, including while wire arguments are streaming.
function toolTargetPreview(item: ToolItemView): string | undefined {
  let target = item.title !== item.toolName ? item.title : undefined;
  if (!target && item.detail) {
    try {
      const args: unknown = JSON.parse(item.detail);
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const values = args as Record<string, unknown>;
        for (const key of [
          "command",
          "cmd",
          "pattern",
          "query",
          "path",
          "file_path",
          "filePath",
          "objective",
          "condition",
          "code",
        ]) {
          if (typeof values[key] === "string" && values[key].trim()) {
            target = values[key];
            break;
          }
        }
      }
    } catch {
      if (!item.detail.trimStart().startsWith("{")) target ??= item.detail;
    }
  }
  const line = target
    ?.split(/\r?\n/u)
    .find((part) => part.trim())
    ?.trim();
  return line && line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function ToolSignal({ state }: { readonly state: ConversationProgressState }) {
  return (
    <span className="conversation-tool-signal" data-state={state} title={stateLabels[state]}>
      <StateIcon state={state} />
      <span className="conversation-sr-only">{stateLabels[state]}</span>
    </span>
  );
}

function ThinkingDisclosure({
  item,
  renderText,
}: {
  readonly item: ThinkingItemView;
  readonly renderText: NonNullable<ConversationTranscriptProps["renderText"]>;
}) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const preview = sanitizeMarkdownText(item.text)
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[*_~`]+/gu, "");
  return (
    <details className="conversation-thinking" aria-label="模型思考" open={open}>
      <summary
        className="conversation-thinking__label"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setHasOpened(true);
          setOpen(!open);
        }}
      >
        <Sparkles aria-hidden="true" />
        <span className="conversation-thinking__title" data-streaming={item.streaming || undefined}>
          模型思考{item.truncated ? " · 已截断" : ""}
        </span>
        {!open && !item.streaming && preview && (
          <span className="conversation-thinking__preview">{preview}</span>
        )}
        <ChevronRight className="conversation-disclosure-chevron" aria-hidden="true" />
      </summary>
      <div className="conversation-thinking__body">
        {hasOpened ? renderText(item.text, item) : null}
      </div>
    </details>
  );
}

function ProcessDisclosure({
  item,
  children,
}: {
  readonly item: ConversationProcessView;
  readonly children: ReactNode;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const active = item.activeStatus !== undefined;
  const open = active || manualOpen;
  const tools = item.items.filter((entry): entry is ToolItemView => entry.kind === "tool");
  const summary = toolGroupSummary(tools);
  const activeLabels: Readonly<Record<string, string>> = {
    queued: "等待执行",
    running: "进行中",
    pause_requested: "等待暂停",
    paused: "已暂停",
    cancelling: "正在停止",
  };
  const label = active
    ? `执行过程 · ${activeLabels[item.activeStatus!] ?? "进行中"}`
    : item.boundary?.status === "completed"
      ? "已完成"
      : "执行过程";
  const pending = active && item.activeStatus !== "running";
  return (
    <details
      className="conversation-process"
      data-run-id={item.runId}
      data-active={active || undefined}
      open={open}
    >
      <summary
        className="conversation-process__summary"
        aria-expanded={open}
        aria-disabled={active || undefined}
        tabIndex={active ? -1 : 0}
        onClick={(event) => {
          event.preventDefault();
          if (!active) setManualOpen(!open);
        }}
      >
        <span className="conversation-process__heading">
          {active ? (
            pending ? (
              <Clock3 aria-hidden="true" />
            ) : (
              <LoaderCircle aria-hidden="true" className="conversation-process__spinner" />
            )
          ) : item.boundary?.status === "completed" ? (
            <Check aria-hidden="true" />
          ) : (
            <ListChecks aria-hidden="true" />
          )}
          <span>{label}</span>
          {item.boundary?.duration && <span>· {item.boundary.duration}</span>}
          {tools.length > 0 && (
            <span className="conversation-process__count">· {tools.length} 次工具调用</span>
          )}
          {summary.failed > 0 && (
            <span className="conversation-process__failure-count">{summary.failed} 次工具失败</span>
          )}
          {!active && (
            <ChevronRight className="conversation-disclosure-chevron" aria-hidden="true" />
          )}
        </span>
        {summary.failure && (
          <span className="conversation-process__failure">
            {summary.failure.toolName}：{summary.failure.preview}
          </span>
        )}
      </summary>
      <ol className="conversation-process__items">{children}</ol>
    </details>
  );
}

function renderDefaultItem(
  item: ConversationItemView,
  renderText: NonNullable<ConversationTranscriptProps["renderText"]>,
  onOpenItem?: (item: ConversationItemView) => void,
  assistantLabel?: string,
): ReactNode {
  switch (item.kind) {
    case "userMessage":
      return (
        <article className="conversation-message conversation-message--user">
          <h3 className="conversation-sr-only">你</h3>
          <div className="conversation-message__bubble">
            {item.skills?.length ? (
              <div aria-label="使用的技能">
                {item.skills.map((skill) => (
                  <span
                    key={`${skill.sourceId}:${skill.name}`}
                    className="composer-reference"
                    title={skill.sourcePath}
                  >
                    Skill: {skill.name}
                  </span>
                ))}
              </div>
            ) : null}
            {renderText(item.text, item)}
            <StandaloneMedia item={item} />
          </div>
        </article>
      );
    case "assistantMessage":
      return (
        <article
          className="conversation-message conversation-message--assistant"
          data-streaming={item.streaming || undefined}
        >
          <h3 className={assistantLabel ? "conversation-message__author" : "conversation-sr-only"}>
            {assistantLabel ?? "Pico"}
          </h3>
          <div className="conversation-message__body">
            {renderText(item.text, item)}
            <StandaloneMedia item={item} />
          </div>
          {item.webSearch && <WebSearchRecord record={item.webSearch} />}
        </article>
      );
    case "thinking":
      return <ThinkingDisclosure item={item} renderText={renderText} />;
    case "skill":
      return (
        <section className="conversation-inline-card conversation-inline-card--skill conversation-execution-record">
          <header className="conversation-inline-card__header">
            <WandSparkles aria-hidden="true" />
            <div>
              <span className="conversation-kicker">Skill</span>
              <strong>{item.name}</strong>
            </div>
            <span className="conversation-item-state">
              {item.trigger === "model-tool" ? "模型调用" : "手动触发"}
            </span>
          </header>
          {item.args && <code className="conversation-skill-args">{item.args}</code>}
        </section>
      );
    case "runBoundary":
      return <RunBoundary item={item} />;
    case "plan":
      return (
        <section
          className="conversation-inline-card conversation-execution-record"
          aria-label={item.title ?? "执行计划"}
        >
          <header className="conversation-inline-card__header">
            <ListChecks aria-hidden="true" />
            <div>
              <span className="conversation-kicker">Plan</span>
              <strong>{item.title ?? "执行计划"}</strong>
            </div>
          </header>
          <ol className="conversation-plan">
            {item.steps.map((step) => (
              <li key={step.id} data-state={step.state}>
                <StateIcon state={step.state} />
                <span>{step.title}</span>
                <span className="conversation-item-state">{stateLabels[step.state]}</span>
              </li>
            ))}
          </ol>
        </section>
      );
    case "discovery":
      return (
        <section
          className="conversation-inline-card conversation-execution-record"
          data-state={item.status}
        >
          <header className="conversation-inline-card__header">
            <SearchCode aria-hidden="true" />
            <div>
              <span className="conversation-kicker">
                Explore · {item.depth} · {item.phase}
              </span>
              <strong>{item.objective}</strong>
            </div>
            <span className="conversation-item-state">{item.status}</span>
          </header>
          <p className="conversation-execution-meta">
            {item.inspectedFiles} 个文件 · {item.evidenceCount} 条证据 · {item.openQuestions}{" "}
            个待确认问题
          </p>
          {item.reason && <p className="conversation-execution-detail">{item.reason}</p>}
          {onOpenItem && <DetailButton label="查看探索详情" onClick={() => onOpenItem(item)} />}
        </section>
      );
    case "tool": {
      const loadedTools = loadedAgentTools(item);
      if (loadedTools) {
        return (
          <details className="conversation-agent-activation" open>
            <summary>
              <CheckCircle2 aria-hidden="true" />
              <strong>启用子智能体</strong>
              <span>加载协作能力</span>
              <ChevronRight className="conversation-agent-activation__chevron" aria-hidden="true" />
            </summary>
            <div className="conversation-agent-capability">
              <span className="conversation-agent-capability__icon">
                <GitBranch aria-hidden="true" />
              </span>
              <div className="conversation-agent-capability__content">
                <strong>子智能体协作已启用</strong>
                <p>可以分派子任务、查看执行进展并汇总结果。</p>
                <p className="conversation-agent-capability__count">
                  已加载 {loadedTools.length} 项协作工具
                </p>
                <p>启动子任务后，点击子 Agent 名称可查看运行记录。</p>
                <details className="conversation-agent-capability__details">
                  <summary>技术详情</summary>
                  <dl>
                    <dt>工具</dt>
                    <dd>
                      <ul>
                        {loadedTools.map((name) => (
                          <li key={name}>
                            <code>{name}</code>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </dl>
                  {onOpenItem && (
                    <DetailButton label="查看加载记录" onClick={() => onOpenItem(item)} />
                  )}
                </details>
              </div>
            </div>
          </details>
        );
      }
      const failure = item.state === "failed" ? toolGroupSummary([item]).failure : undefined;
      const target = toolTargetPreview(item);
      return (
        <details className="conversation-tool-record" data-state={item.state}>
          <summary className="conversation-tool-row">
            <ToolSignal state={item.state} />
            <span className="conversation-tool-row__name" title={item.toolName}>
              {toolLabel(item.toolName)}
            </span>
            {target && (
              <span className="conversation-tool-row__target" title={target}>
                {target}
              </span>
            )}
            <ChevronRight className="conversation-tool-record__chevron" aria-hidden="true" />
            {failure && (
              <span className="conversation-tool-row__failure" title={failure.preview}>
                {failure.preview}
              </span>
            )}
          </summary>
          <div className="conversation-tool-record__body">
            {item.result && (
              <p className="conversation-execution-meta">
                {item.result.rawSizeBytes} bytes · {item.result.status} ·
                <code>{item.result.sha256.slice(0, 12)}</code>
                {item.result.evidence ? " · 旧 Evidence 元数据" : ""}
              </p>
            )}
            {item.detail && <p className="conversation-execution-detail">{item.detail}</p>}
            {item.output && <pre className="conversation-tool-output">{item.output}</pre>}
            {onOpenItem && <DetailButton label="查看工具详情" onClick={() => onOpenItem(item)} />}
          </div>
        </details>
      );
    }
    case "subagent":
      return <SubagentRow item={item} onOpenItem={onOpenItem} />;
    case "status": {
      const Icon = item.tone === "error" ? AlertCircle : item.tone === "success" ? Check : Circle;
      return (
        <div className="conversation-status" data-tone={item.tone ?? "neutral"} role="status">
          <Icon aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </div>
        </div>
      );
    }
    case "approval":
      return (
        <section
          className="conversation-inline-card conversation-execution-record"
          data-state={item.state}
        >
          <header className="conversation-inline-card__header">
            <ShieldQuestion aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">
              {item.state === "pending"
                ? "等待审批"
                : item.state === "allowed"
                  ? "已批准"
                  : "已拒绝"}
            </span>
          </header>
          <p className="conversation-execution-detail">{item.detail}</p>
          {onOpenItem && item.state === "pending" && (
            <DetailButton label="处理审批" onClick={() => onOpenItem(item)} />
          )}
        </section>
      );
    case "prompt":
      return (
        <section
          className="conversation-inline-card conversation-execution-record"
          data-state={item.state}
        >
          <header className="conversation-inline-card__header">
            <ShieldQuestion aria-hidden="true" />
            <strong>{item.question}</strong>
            <span className="conversation-item-state">
              {item.state === "pending" ? "等待回答" : "已回答"}
            </span>
          </header>
          {item.detail && <p className="conversation-execution-detail">{item.detail}</p>}
          {onOpenItem && item.state === "pending" && (
            <DetailButton label="回答问题" onClick={() => onOpenItem(item)} />
          )}
        </section>
      );
    case "changes":
      return (
        <section
          className="conversation-inline-card conversation-execution-record"
          data-state={item.state}
        >
          <header className="conversation-inline-card__header">
            <FileDiff aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">{item.files.length} 个文件</span>
          </header>
          {item.detail && <p className="conversation-execution-detail">{item.detail}</p>}
          <ul className="conversation-file-list" aria-label="更改的文件">
            {item.files.slice(0, 3).map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          {onOpenItem && <DetailButton label="审阅更改" onClick={() => onOpenItem(item)} />}
        </section>
      );
    case "goal":
      return (
        <section
          className="conversation-inline-card conversation-inline-card--goal conversation-execution-record"
          data-state={item.state}
        >
          <header className="conversation-inline-card__header">
            <Sparkles aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">
              {item.statusLabel ?? stateLabels[item.state]}
            </span>
          </header>
          {item.detail && <p className="conversation-execution-detail">{item.detail}</p>}
          {onOpenItem && <DetailButton label="查看目标" onClick={() => onOpenItem(item)} />}
        </section>
      );
  }
}

export function ConversationTranscript({
  items,
  mediaScope,
  activeRun,
  assistantLabel,
  label = "会话记录",
  emptyState,
  onOpenItem,
  renderText = (text, item) => (
    <MarkdownText
      text={text}
      dim={item.kind === "thinking"}
      media={
        item.kind === "userMessage" || item.kind === "assistantMessage" ? item.media : undefined
      }
    />
  ),
  renderItem,
}: ConversationTranscriptProps) {
  const visibleItems = mergeConversationItemGroups(items).filter(
    (item) =>
      (item.kind !== "thinking" && item.kind !== "assistantMessage") || item.cleared !== true,
  );
  const turns = groupConversationItemsIntoTurns(
    foldConversationProcess(visibleTurnItems(visibleItems), activeRun),
  );
  const renderItemContent = (item: ConversationItemView): ReactNode => {
    const fallback = renderDefaultItem(item, renderText, onOpenItem, assistantLabel);
    return (
      <>
        {renderItem ? renderItem(item, fallback) : fallback}
        {item.truncated && (
          <p className="conversation-truncated-notice" role="note">
            这条记录超过桌面传输上限，已安全截断
            {item.originalBytes ? `（原始 ${item.originalBytes.toLocaleString()} 字节）` : ""}。
          </p>
        )}
      </>
    );
  };

  const renderDisplayItems = (entries: readonly ConversationItemView[]) =>
    groupConsecutiveRunTools(entries).map((item) => {
      if (item.kind === "toolGroup") {
        const summary = toolGroupSummary(item.items);
        const latest = item.items.at(-1)!;
        const target = toolTargetPreview(latest);
        return (
          <li className="conversation-transcript__item" data-kind="toolGroup" key={item.key}>
            <details
              className="conversation-tool-group"
              data-state={summary.state}
              data-tool-group="true"
            >
              <summary className="conversation-tool-row" title={summary.statuses}>
                <ToolSignal state={summary.active > 0 ? "active" : summary.state} />
                <span
                  className="conversation-tool-row__name conversation-tool-group__latest"
                  title={latest.toolName}
                >
                  {toolLabel(latest.toolName)}
                </span>
                {target && (
                  <span
                    className="conversation-tool-row__target conversation-tool-group__latest"
                    title={target}
                  >
                    {target}
                  </span>
                )}
                <span className="conversation-tool-group__expanded-title">
                  工具调用 · {item.items.length} 项
                </span>
                <span
                  className="conversation-tool-group__count"
                  aria-label={`${item.items.length} 次工具调用`}
                >
                  {item.items.length}
                </span>
                <span className="conversation-sr-only">{summary.statuses}</span>
                {(summary.active > 0 || summary.waiting > 0) && (
                  <span className="conversation-tool-group__progress">
                    {summary.active > 0 ? `${summary.active} 运行中` : `${summary.waiting} 等待中`}
                  </span>
                )}
                {summary.failed > 0 && (
                  <span className="conversation-tool-group__failed-count">
                    {summary.failed} 失败
                  </span>
                )}
                <ChevronRight className="conversation-tool-record__chevron" aria-hidden="true" />
                {summary.failure && (
                  <span
                    className="conversation-tool-row__failure"
                    title={`${summary.failure.toolName}：${summary.failure.preview}`}
                  >
                    {summary.failure.toolName}：{summary.failure.preview}
                  </span>
                )}
              </summary>
              <ol className="conversation-tool-group__items">
                {item.items.map((tool) => (
                  <li
                    className="conversation-tool-group__item"
                    data-kind="tool"
                    key={conversationItemKey(tool)}
                  >
                    {renderItemContent(tool)}
                  </li>
                ))}
              </ol>
            </details>
          </li>
        );
      }
      return (
        <li
          className="conversation-transcript__item"
          data-kind={item.kind}
          key={conversationItemKey(item)}
        >
          {renderItemContent(item)}
        </li>
      );
    });

  if (turns.length === 0) {
    return (
      <section
        className="conversation-transcript conversation-transcript--empty"
        aria-label={label}
      >
        {emptyState ?? (
          <div className="conversation-empty-state">
            <span className="conversation-wordmark" aria-label="Pico">
              pico
            </span>
            <h2>今天想做些什么？</h2>
          </div>
        )}
      </section>
    );
  }

  return (
    <MediaProvider key={JSON.stringify(mediaScope)} scope={mediaScope}>
      <ol
        className="conversation-transcript"
        aria-label={label}
        aria-live="polite"
        aria-relevant="additions text"
      >
        {turns.map((turn) => (
          <li className="conversation-turn" key={turn.key}>
            <ol className="conversation-turn__items">
              {turn.items.map((item) =>
                item.kind === "process" ? (
                  <li className="conversation-transcript__item" data-kind="process" key={item.key}>
                    <ProcessDisclosure item={item}>
                      {renderDisplayItems(item.items)}
                    </ProcessDisclosure>
                  </li>
                ) : (
                  renderDisplayItems([item])
                ),
              )}
            </ol>
          </li>
        ))}
      </ol>
    </MediaProvider>
  );
}

function StandaloneMedia({
  item,
}: {
  item: Extract<ConversationItemView, { kind: "userMessage" | "assistantMessage" }>;
}) {
  const referenced = referencedMediaIds(item.text, item.media ?? []);
  const seen = new Set<string>();
  return (
    <>
      {item.media
        ?.filter((reference) => {
          if (referenced.has(reference.artifactId) || seen.has(reference.artifactId)) return false;
          seen.add(reference.artifactId);
          return true;
        })
        .map((reference) => (
          <MediaPreview key={reference.artifactId} reference={reference} />
        ))}
    </>
  );
}
