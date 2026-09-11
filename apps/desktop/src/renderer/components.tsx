import * as Tooltip from "@radix-ui/react-tooltip";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Folder,
  Layers3,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { CapabilityView, WorkspaceMode } from "./model.js";

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
  onDelete,
  deleting = false,
}: {
  readonly items: readonly CapabilityView[];
  readonly emptyTitle: string;
  readonly emptyDetail: string;
  readonly onDelete?: ((item: CapabilityView) => void) | undefined;
  readonly deleting?: boolean | undefined;
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
            {item.source && (
              <div className="capability-source" aria-label={`${item.name} 来源`}>
                <span>{scopeLabel(item.source.scope)}</span>
                <span>{item.source.sourceLabel}</span>
                <span>{item.source.readOnly ? "只读" : "可管理"}</span>
                <span>{item.source.effective ? "已生效" : "未生效"}</span>
                {item.source.shadowedBy && <span>被 {item.source.shadowedBy} 覆盖</span>}
              </div>
            )}
          </div>
          <div className="capability-row__actions">
            {item.meta && <span className="row-meta">{item.meta}</span>}
            {onDelete && item.source?.scope === "user" && !item.source.readOnly && (
              <Button variant="quiet" disabled={deleting} onClick={() => onDelete(item)}>
                删除
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function scopeLabel(scope: NonNullable<CapabilityView["source"]>["scope"]): string {
  return scope === "user" ? "用户级" : scope === "project" ? "项目级" : "Plugin";
}

export function WorkspaceModeBadge({ mode }: { readonly mode: WorkspaceMode | undefined }) {
  return (
    <span className={`workspace-mode-badge workspace-mode-badge--${mode ?? "folder"}`}>
      {mode === "git" ? <ShieldCheck aria-hidden="true" /> : <Folder aria-hidden="true" />}
      {mode === "git" ? "版本保护" : "基础模式"}
    </span>
  );
}

export function WorkspaceModeCard({ mode }: { readonly mode: WorkspaceMode | undefined }) {
  const protectedMode = mode === "git";
  return (
    <section className="workspace-mode-card" aria-label="工作区模式">
      <div>
        <WorkspaceModeBadge mode={mode} />
        <strong>{protectedMode ? "这个文件夹已启用版本保护" : "这个文件夹可以直接使用"}</strong>
      </div>
      <p>
        {protectedMode
          ? "Pico 可以隔离并行任务，并在确认后合并它们的更改。"
          : "Pico 可以直接读写文件并运行并行分析子代理；可写子代理的隔离、分支和独立合并目前需要 Git。"}
      </p>
      {!protectedMode && (
        <small>版本保护是一项进阶能力，由 Git 提供；不了解它也不影响现在开始。</small>
      )}
    </section>
  );
}

export function CapabilityUnavailable({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <EmptyState
      icon={<Layers3 />}
      title={title}
      detail={detail}
      action={
        <InlineNotice tone="warning">此区域不会用本地 fixture 替代 Runtime 数据。</InlineNotice>
      }
    />
  );
}

export function PreviewBadge() {
  return (
    <span className="preview-badge">
      <Sparkles aria-hidden="true" size={13} /> Preview
    </span>
  );
}
