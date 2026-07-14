import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Folder,
  LoaderCircle,
  ShieldAlert,
  X,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { ApprovalView, CapabilityView, PromptView } from "./model.js";

export function IconButton({
  label,
  ...props
}: ComponentProps<"button"> & { readonly label: string }) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className="icon-button" aria-label={label} {...props} />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" sideOffset={6}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<"button"> & {
  readonly variant?: "primary" | "secondary" | "quiet" | "danger";
}) {
  return (
    <button type="button" className={`button button--${variant} ${className}`.trim()} {...props} />
  );
}

export function EmptyState({
  icon = <Circle aria-hidden="true" />,
  title,
  detail,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">{icon}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function InlineNotice({
  tone = "neutral",
  children,
}: {
  readonly tone?: "neutral" | "warning" | "error" | "success";
  readonly children: ReactNode;
}) {
  const Icon = tone === "warning" || tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div
      className={`inline-notice inline-notice--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" size={16} />
      <span>{children}</span>
    </div>
  );
}

export function StatusPill({ status }: { readonly status: string }) {
  const normalized = status.toLowerCase();
  const tone = ["ready", "running", "active", "succeeded", "done"].includes(normalized)
    ? "success"
    : ["failed", "error", "cancelled"].includes(normalized)
      ? "error"
      : ["attention", "waiting", "pause_requested", "paused"].includes(normalized)
        ? "warning"
        : "neutral";
  const labels: Readonly<Record<string, string>> = {
    ready: "可用",
    running: "运行中",
    active: "进行中",
    succeeded: "已完成",
    done: "已完成",
    failed: "失败",
    error: "错误",
    cancelled: "已取消",
    cancelling: "正在停止",
    paused: "已暂停",
    pause_requested: "等待暂停",
    waiting: "等待中",
    attention: "需处理",
    disabled: "未启用",
    idle: "空闲",
    archived: "已归档",
  };
  return <span className={`status-pill status-pill--${tone}`}>{labels[normalized] ?? status}</span>;
}

export function CapabilityList({
  items,
  emptyTitle,
  emptyDetail,
}: {
  readonly items: readonly CapabilityView[];
  readonly emptyTitle: string;
  readonly emptyDetail: string;
}) {
  if (items.length === 0) return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  return (
    <div className="capability-list">
      {items.map((item) => (
        <article className="capability-row" key={item.id}>
          <span className={`capability-mark capability-mark--${item.state}`} aria-hidden="true">
            {item.state === "ready" ? <Check size={15} /> : <Circle size={11} />}
          </span>
          <div className="capability-row__body">
            <div className="row-title">
              <h3>{item.name}</h3>
              <StatusPill status={item.state} />
            </div>
            <p>{item.description}</p>
          </div>
          {item.meta && <span className="row-meta">{item.meta}</span>}
        </article>
      ))}
    </div>
  );
}

export function ApprovalDialog({
  approval,
  open,
  onOpenChange,
  onDecision,
  busy,
}: {
  readonly approval?: ApprovalView | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDecision: (decision: "allow_once" | "allow_session" | "deny") => void;
  readonly busy: boolean;
}) {
  if (!approval) return null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog" aria-describedby="approval-detail">
          <div className="dialog__icon dialog__icon--warning">
            <ShieldAlert aria-hidden="true" />
          </div>
          <Dialog.Title>{approval.title}</Dialog.Title>
          <Dialog.Description id="approval-detail">{approval.detail}</Dialog.Description>
          {approval.command && <pre className="command-preview">{approval.command}</pre>}
          <div className="risk-row">
            <span>风险等级</span>
            <StatusPill status={approval.risk === "low" ? "ready" : "attention"} />
          </div>
          <div className="dialog__actions">
            <Button variant="danger" disabled={busy} onClick={() => onDecision("deny")}>
              拒绝
            </Button>
            <Button disabled={busy} onClick={() => onDecision("allow_session")}>
              本任务内允许
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => onDecision("allow_once")}>
              仅允许这次
            </Button>
          </div>
          <Dialog.Close asChild>
            <IconButton className="dialog__close" label="关闭审批窗口">
              <X aria-hidden="true" size={18} />
            </IconButton>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PromptDialog({
  prompt,
  open,
  onOpenChange,
  onAnswer,
  busy,
}: {
  readonly prompt?: PromptView | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAnswer: (answer: string) => void;
  readonly busy: boolean;
}) {
  if (!prompt) return null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog dialog--question">
          <span className="eyebrow">Pico 需要你的选择</span>
          <Dialog.Title>{prompt.question}</Dialog.Title>
          <Dialog.Description>你的回答会加入当前运行上下文，任务随后继续。</Dialog.Description>
          <div className="choice-list" role="group" aria-label="可选回答">
            {prompt.options.map((option) => (
              <button key={option} type="button" disabled={busy} onClick={() => onAnswer(option)}>
                <span>{option}</span>
                <ArrowRight aria-hidden="true" size={16} />
              </button>
            ))}
          </div>
          <Dialog.Close asChild>
            <IconButton className="dialog__close" label="关闭问题窗口">
              <X aria-hidden="true" size={18} />
            </IconButton>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function StepState({ state }: { readonly state: "done" | "active" | "waiting" | "failed" }) {
  if (state === "done")
    return <CheckCircle2 className="step-icon step-icon--done" aria-label="已完成" />;
  if (state === "active")
    return <LoaderCircle className="step-icon step-icon--active" aria-label="进行中" />;
  if (state === "failed")
    return <AlertTriangle className="step-icon step-icon--failed" aria-label="失败" />;
  return <Clock3 className="step-icon" aria-label="等待中" />;
}

export function PathButton({
  path,
  onClick,
}: {
  readonly path: string;
  readonly onClick: () => void;
}) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return (
    <button type="button" className="path-button" onClick={onClick}>
      <Folder aria-hidden="true" size={15} />
      <span>{name}</span>
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}
