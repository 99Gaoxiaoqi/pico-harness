import {
  AlertCircle,
  Bot,
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
  TerminalSquare,
  WandSparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  ConversationItemView,
  ConversationProgressState,
  RunBoundaryItemView,
} from "./types.js";
import { conversationItemKey, mergeConversationItemGroups } from "./items.js";
import { MarkdownText } from "./MarkdownText.js";

export interface ConversationTranscriptProps {
  readonly items: readonly ConversationItemView[];
  readonly label?: string | undefined;
  readonly emptyState?: ReactNode | undefined;
  readonly onOpenItem?: ((item: ConversationItemView) => void) | undefined;
  readonly renderText?: ((text: string, item: ConversationItemView) => ReactNode) | undefined;
  readonly renderItem?:
    | ((item: ConversationItemView, fallback: ReactNode) => ReactNode)
    | undefined;
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
    <button type="button" className="conversation-detail-button" onClick={onClick}>
      <span>{label}</span>
      <ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}

function renderDefaultItem(
  item: ConversationItemView,
  renderText: NonNullable<ConversationTranscriptProps["renderText"]>,
  onOpenItem?: (item: ConversationItemView) => void,
): ReactNode {
  switch (item.kind) {
    case "userMessage":
      return (
        <article className="conversation-message conversation-message--user">
          <h3 className="conversation-sr-only">你</h3>
          <div className="conversation-message__bubble">{renderText(item.text, item)}</div>
        </article>
      );
    case "assistantMessage":
      return (
        <article
          className="conversation-message conversation-message--assistant"
          data-streaming={item.streaming || undefined}
        >
          <h3 className="conversation-sr-only">Pico</h3>
          <div className="conversation-message__body">{renderText(item.text, item)}</div>
          {item.streaming && (
            <span className="conversation-streaming-label" role="status">
              <LoaderCircle aria-hidden="true" /> 正在回复
            </span>
          )}
        </article>
      );
    case "thinking":
      return (
        <section className="conversation-thinking" aria-label="推理摘要">
          <div className="conversation-thinking__label">
            <Sparkles aria-hidden="true" /> 推理摘要
          </div>
          {renderText(item.text, item)}
        </section>
      );
    case "skill":
      return (
        <section className="conversation-inline-card conversation-inline-card--skill">
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
        <section className="conversation-inline-card" aria-label={item.title ?? "执行计划"}>
          <header className="conversation-inline-card__header">
            <ListChecks aria-hidden="true" />
            <strong>{item.title ?? "执行计划"}</strong>
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
    case "tool":
      return (
        <section className="conversation-inline-card" data-state={item.state}>
          <header className="conversation-inline-card__header">
            <TerminalSquare aria-hidden="true" />
            <div>
              <span className="conversation-kicker">{item.toolName}</span>
              <strong>{item.title}</strong>
            </div>
            <span className="conversation-item-state">
              <StateIcon state={item.state} /> {stateLabels[item.state]}
            </span>
          </header>
          {item.detail && <p>{item.detail}</p>}
          {item.output && <pre className="conversation-tool-output">{item.output}</pre>}
          {onOpenItem && <DetailButton label="查看工具详情" onClick={() => onOpenItem(item)} />}
        </section>
      );
    case "subagent":
      return (
        <section className="conversation-inline-card conversation-inline-card--agent">
          <header className="conversation-inline-card__header">
            <Bot aria-hidden="true" />
            <div>
              <span className="conversation-kicker">子代理 {item.name}</span>
              <strong>{item.title}</strong>
            </div>
            <span className="conversation-item-state">
              <StateIcon state={item.state} /> {stateLabels[item.state]}
            </span>
          </header>
          {item.detail && <p>{item.detail}</p>}
          {onOpenItem && (
            <DetailButton label={`查看 ${item.name} 的会话`} onClick={() => onOpenItem(item)} />
          )}
        </section>
      );
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
        <section className="conversation-inline-card" data-state={item.state}>
          <header className="conversation-inline-card__header">
            <ShieldQuestion aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">
              {item.state === "pending"
                ? "等待审批"
                : item.state === "allowed"
                  ? "已允许"
                  : "已拒绝"}
            </span>
          </header>
          <p>{item.detail}</p>
          {onOpenItem && item.state === "pending" && (
            <DetailButton label="处理审批" onClick={() => onOpenItem(item)} />
          )}
        </section>
      );
    case "prompt":
      return (
        <section className="conversation-inline-card" data-state={item.state}>
          <header className="conversation-inline-card__header">
            <ShieldQuestion aria-hidden="true" />
            <strong>{item.question}</strong>
            <span className="conversation-item-state">
              {item.state === "pending" ? "等待回答" : "已回答"}
            </span>
          </header>
          {item.detail && <p>{item.detail}</p>}
          {onOpenItem && item.state === "pending" && (
            <DetailButton label="回答问题" onClick={() => onOpenItem(item)} />
          )}
        </section>
      );
    case "changes":
      return (
        <section className="conversation-inline-card" data-state={item.state}>
          <header className="conversation-inline-card__header">
            <FileDiff aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">{item.files.length} 个文件</span>
          </header>
          {item.detail && <p>{item.detail}</p>}
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
          className="conversation-inline-card conversation-inline-card--goal"
          data-state={item.state}
        >
          <header className="conversation-inline-card__header">
            <Sparkles aria-hidden="true" />
            <strong>{item.title}</strong>
            <span className="conversation-item-state">{stateLabels[item.state]}</span>
          </header>
          {item.detail && <p>{item.detail}</p>}
          {onOpenItem && <DetailButton label="查看目标" onClick={() => onOpenItem(item)} />}
        </section>
      );
  }
}

export function ConversationTranscript({
  items,
  label = "会话记录",
  emptyState,
  onOpenItem,
  renderText = (text, item) => <MarkdownText text={text} dim={item.kind === "thinking"} />,
  renderItem,
}: ConversationTranscriptProps) {
  const visibleItems = mergeConversationItemGroups(items).filter(
    (item) =>
      (item.kind !== "runBoundary" || item.status !== "started") &&
      (item.kind !== "thinking" || item.cleared !== true),
  );

  if (visibleItems.length === 0) {
    return (
      <section
        className="conversation-transcript conversation-transcript--empty"
        aria-label={label}
      >
        {emptyState ?? (
          <div className="conversation-empty-state">
            <Sparkles aria-hidden="true" />
            <h2>从一段对话开始</h2>
            <p>描述你想推进的事情，Pico 会在这里展示思考、工具和结果。</p>
          </div>
        )}
      </section>
    );
  }

  return (
    <ol
      className="conversation-transcript"
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {visibleItems.map((item) => {
        const fallback = renderDefaultItem(item, renderText, onOpenItem);
        return (
          <li
            className="conversation-transcript__item"
            data-kind={item.kind}
            key={conversationItemKey(item)}
          >
            {renderItem ? renderItem(item, fallback) : fallback}
            {item.truncated && (
              <p className="conversation-truncated-notice" role="note">
                这条记录超过桌面传输上限，已安全截断
                {item.originalBytes ? `（原始 ${item.originalBytes.toLocaleString()} 字节）` : ""}。
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
