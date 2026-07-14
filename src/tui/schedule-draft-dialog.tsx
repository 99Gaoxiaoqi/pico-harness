import React, { useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { CronDraft, CronDraftDecision, CronDraftId } from "../tasks/cron-draft.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { ScheduleDraftReviewHandler } from "./schedule-draft-review.js";

const SCHEDULE_DRAFT_DIALOG_PREFIX = "schedule-draft:pending:";
export const SCHEDULE_DRAFT_DIALOG_PRIORITY = 70;

export interface ScheduleDraftDialogProps {
  readonly draft: CronDraft;
  readonly onDecision: (kind: CronDraftDecision["kind"]) => void;
}

export interface ScheduleDraftDialogHost {
  readonly openDialog: (request: DialogRequest) => void;
  readonly closeDialog: (dialogId: string) => void;
}

export interface ScheduleDraftDialogRequestOptions {
  readonly priority?: number;
  readonly onClose?: (dialogId: string) => void;
}

export function scheduleDraftDialogId(draftId: CronDraftId): string {
  return `${SCHEDULE_DRAFT_DIALOG_PREFIX}${draftId}`;
}

export function isScheduleDraftDialogId(id: string): boolean {
  return id.startsWith(SCHEDULE_DRAFT_DIALOG_PREFIX);
}

export function createScheduleDraftDialogRequest(
  draft: CronDraft,
  handler: Pick<ScheduleDraftReviewHandler, "confirm" | "modify" | "cancel">,
  options: ScheduleDraftDialogRequestOptions = {},
): DialogRequest {
  const id = scheduleDraftDialogId(draft.draftId);
  const settle = (kind: CronDraftDecision["kind"]): void => {
    const settled =
      kind === "confirm"
        ? handler.confirm(draft.draftId)
        : kind === "modify"
          ? handler.modify(draft.draftId)
          : handler.cancel(draft.draftId);
    if (settled) options.onClose?.(id);
  };
  return {
    id,
    layer: "modal",
    priority: options.priority ?? SCHEDULE_DRAFT_DIALOG_PRIORITY,
    content: <ScheduleDraftDialog draft={draft} onDecision={settle} />,
  };
}

/** Bind pending reviews to an existing DialogRequest host without changing the host itself. */
export function bindScheduleDraftDialogs(
  handler: ScheduleDraftReviewHandler,
  host: ScheduleDraftDialogHost,
): () => void {
  const openedDialogIds = new Set<string>();
  const open = (draft: CronDraft): void => {
    const id = scheduleDraftDialogId(draft.draftId);
    if (openedDialogIds.has(id)) return;
    openedDialogIds.add(id);
    host.openDialog(createScheduleDraftDialogRequest(draft, handler));
  };
  const close = (draftId: CronDraftId): void => {
    const id = scheduleDraftDialogId(draftId);
    if (!openedDialogIds.delete(id)) return;
    host.closeDialog(id);
  };

  const unsubscribe = handler.subscribe((event) => {
    if (event.kind === "pending") open(event.draft);
    else close(event.draft.draftId);
  });
  for (const draft of handler.getPendingDrafts()) open(draft);

  return () => {
    unsubscribe();
    for (const id of openedDialogIds) host.closeDialog(id);
    openedDialogIds.clear();
  };
}

export function ScheduleDraftDialog({
  draft,
  onDecision,
}: ScheduleDraftDialogProps): React.ReactNode {
  const submittedDraftId = useRef<CronDraftId | null>(null);

  useEffect(() => {
    submittedDraftId.current = null;
  }, [draft.draftId]);

  useInput((input, key) => {
    const decision = resolveScheduleDraftDialogKey(input, key);
    if (!decision || submittedDraftId.current === draft.draftId) return;
    submittedDraftId.current = draft.draftId;
    onDecision(decision);
  });

  return (
    <Box flexDirection="column">
      {formatScheduleDraftDialog(draft)
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function resolveScheduleDraftDialogKey(
  input: string,
  key: {
    readonly return?: boolean;
    readonly escape?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
  },
): CronDraftDecision["kind"] | null {
  if (key.ctrl || key.meta) return null;
  if (key.escape || input === "\u001b" || input.toLowerCase() === "n") return "cancel";
  if (key.return || input.toLowerCase() === "y") return "confirm";
  if (input.toLowerCase() === "m") return "modify";
  return null;
}

export function formatScheduleDraftDialog(draft: CronDraft): string {
  const tools = draft.allowedTools.length > 0 ? draft.allowedTools.join(", ") : "无可用后台工具";
  const nextRuns = draft.nextRuns.slice(0, 3);
  const lines = [
    "定时任务草案",
    `标题: ${draft.title}`,
    `自然语言时间: ${draft.scheduleText}`,
    `时区: ${draft.timeZone}`,
    `工作区: ${draft.workspacePath}`,
    `模型: ${draft.modelRouteId}`,
    `工具与联网: 全部工具（${tools}） · ${draft.toolNetworkPolicy === "allow" ? "允许联网" : draft.toolNetworkPolicy}`,
    `凭证状态: ${formatCredentialStatus(draft.credentialStatus)}`,
    `Daemon 状态: ${draft.daemonStatus}`,
    "未来三次运行:",
    ...nextRuns.map(
      (timestamp, index) => `  ${index + 1}. ${formatRunTime(timestamp, draft.timeZone)}`,
    ),
    ...(nextRuns.length === 0 ? ["  暂无可预览时间"] : []),
    "详情:",
    `  Cron: ${draft.cronExpression}`,
    "Enter/Y 确认 · M 修改 · Esc/N 取消",
  ];
  return lines.join("\n");
}

function formatCredentialStatus(status: CronDraft["credentialStatus"]): string {
  if (status === "available") return "可用";
  if (status === "missing") return "缺失";
  return "不可用";
}

function formatRunTime(timestamp: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone,
      hourCycle: "h23",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}
