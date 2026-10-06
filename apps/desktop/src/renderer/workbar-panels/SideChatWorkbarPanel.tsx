import {
  useCommandSuggestions,
  type ComposerCommands,
  type ComposerResources,
} from "../conversation/CommandSuggestions.js";
import { ConversationComposerMenu } from "../conversation/ConversationComposerMenu.js";
import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
} from "@astryxdesign/core/Chat";
import { CircleAlert, GitFork, LoaderCircle, Send, Square, X } from "lucide-react";
import { useRef, useEffect, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { parseComposerDraft } from "../conversation/composer-references.js";

import { omitApprovalAuditItems } from "../conversation/items.js";
import {
  ConversationTranscript,
  type ConversationTranscriptProps,
} from "../conversation/ConversationTranscript.js";
import type { ConversationItemView } from "../conversation/types.js";

export type SideChatChildState = "idle" | "creating" | "live" | "cleanup" | "failed";

export interface SideChatChildSession {
  readonly panelId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId?: string;
  readonly state: SideChatChildState;
  readonly throughEventId?: string;
}

export type SideChatErrorCode =
  | "no_settled_turn"
  | "create_failed"
  | "session_unavailable"
  | "unknown";

export interface SideChatPanelError {
  readonly code: SideChatErrorCode;
  readonly message: string;
}

export interface SideChatWorkbarPanelProps {
  readonly workspacePath?: string | undefined;
  readonly commands?: ComposerCommands | undefined;
  readonly resources?: ComposerResources | undefined;
  readonly resourceRequest?: { kind: "skill" | "agent"; id: number } | undefined;
  readonly commandFeedback?: ReactNode;
  readonly commandPending?: boolean;
  readonly sendPending?: boolean;
  readonly activeRun?: ConversationTranscriptProps["activeRun"];
  readonly child: SideChatChildSession;
  readonly items: readonly ConversationItemView[];
  readonly draft: string;
  readonly active: boolean;
  readonly running: boolean;
  readonly loading: boolean;
  readonly error?: SideChatPanelError | null;
  readonly goalStatus?: ReactNode;
  readonly goalDialog?: ReactNode;
  readonly onSetGoal?: (() => void) | undefined;
  readonly goalDisabled?: boolean | undefined;
  readonly pendingPrompt?: ReactNode;
  readonly pendingApproval?: ReactNode;
  readonly pendingApprovalCallId?: string | undefined;
  readonly onSend: (message: string) => void;
  readonly onStop: () => void;
  readonly stopFocusRequest?: number | undefined;
  readonly onDraftChange: (draft: string) => void;
  readonly onRetryCreate: () => void;
  readonly onClose: () => void;
  readonly onOpenItem?: (item: ConversationItemView) => void;
}

/** Parent data adapters use this gate without unmounting the presentational panel. */
export function shouldActivateSideChatData(active: boolean, state: SideChatChildState): boolean {
  return active && (state === "creating" || state === "live");
}

export function sideChatCanSend(
  childState: SideChatChildState,
  running: boolean,
  draft: string,
): boolean {
  return childState === "live" && !running && draft.trim().length > 0;
}

export function SideChatWorkbarPanel({
  workspacePath,
  commands,
  resources,
  resourceRequest,
  commandFeedback,
  commandPending = false,
  sendPending = false,
  child,
  activeRun,
  items,
  draft,
  active,
  running,
  loading,
  error,
  goalStatus,
  goalDialog,
  onSetGoal,
  goalDisabled,
  pendingPrompt,
  pendingApproval,
  pendingApprovalCallId,
  onSend,
  onStop,
  stopFocusRequest,
  onDraftChange,
  onRetryCreate,
  onClose,
  onOpenItem,
}: SideChatWorkbarPanelProps) {
  const editableRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ChatComposerInputHandle>(null);
  const stopSlot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (stopFocusRequest) stopSlot.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [stopFocusRequest]);
  const openResources = (kind: "skill" | "agent" = "skill") => {
    editorRef.current?.focus();
    editorRef.current?.insertText(` /${kind} `);
    onDraftChange(editorRef.current?.getValue() ?? draft);
  };
  useEffect(() => {
    if (resourceRequest) openResources(resourceRequest.kind);
  }, [resourceRequest]);
  const commandMenu = useCommandSuggestions(draft, onDraftChange, commands, resources, editableRef);
  const commandInput =
    Boolean(commands) &&
    !parseComposerDraft(draft).references.length &&
    draft.trimStart().startsWith("/");
  const canSend =
    child.state === "live" &&
    !commandPending &&
    (commandInput || (!sendPending && sideChatCanSend(child.state, running, draft)));
  const send = () => {
    const message = draft.trim();
    if (!canSend) return;
    onSend(message);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };
  const handleDraftKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (commandMenu.onKeyDown(event)) return;
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    event.preventDefault();
    send();
  };
  const unavailable = child.state !== "live";

  return (
    <section
      className="tool-panel tool-panel--side-chat"
      data-active={active || undefined}
      data-child-state={child.state}
      aria-label="侧边对话"
    >
      <header className="side-chat__header">
        <div>
          <span className="side-chat__fork-mark" aria-hidden="true">
            <GitFork size={14} />
          </span>
          <span>
            <strong>临时分支</strong>
            <small>{sideChatStateLabel(child.state, running)}</small>
          </span>
        </div>
        <Button
          label="关闭侧边对话"
          isIconOnly
          icon={<X aria-hidden="true" size={15} />}
          className="tool-panel__icon-button"
          variant="ghost"
          size="sm"
          onClick={onClose}
        />
      </header>

      <p className="side-chat__boundary" role="note">
        这段对话拥有独立记录，不会回写父会话；对工作区的修改仍然共享。
      </p>

      {error && (
        <SideChatErrorState
          error={error}
          retrying={child.state === "creating"}
          onRetry={onRetryCreate}
        />
      )}

      <div className="side-chat__transcript" aria-busy={loading}>
        {child.state === "creating" ? (
          <div className="side-chat__state" role="status">
            <LoaderCircle className="side-chat__spinner" aria-hidden="true" size={20} />
            <strong>正在创建临时分支…</strong>
            <span>将从父会话最近成功完成的回合继续。</span>
          </div>
        ) : child.state === "cleanup" ? (
          <div className="side-chat__state" role="status">
            <LoaderCircle className="side-chat__spinner" aria-hidden="true" size={20} />
            <strong>正在清理临时分支…</strong>
          </div>
        ) : !error && child.state === "failed" ? (
          <div className="side-chat__state">
            <CircleAlert aria-hidden="true" size={20} />
            <strong>临时分支不可用</strong>
            <Button label="重新创建" onClick={onRetryCreate} size="sm" />
          </div>
        ) : child.state === "live" ? (
          <ConversationTranscript
            mediaScope={
              active && workspacePath && child.targetSessionId
                ? { workspacePath, sessionId: child.targetSessionId }
                : undefined
            }
            activeRun={activeRun}
            items={omitApprovalAuditItems(items, pendingApprovalCallId)}
            label="临时分支会话记录"
            onOpenItem={onOpenItem}
            emptyState={
              loading ? (
                <div className="side-chat__state" role="status">
                  <LoaderCircle className="side-chat__spinner" aria-hidden="true" size={20} />
                  <strong>正在载入临时分支…</strong>
                </div>
              ) : (
                <div className="side-chat__state">
                  <GitFork aria-hidden="true" size={21} />
                  <strong>在临时分支中继续追问</strong>
                  <span>这里的消息不会加入父会话记录。</span>
                </div>
              )
            }
          />
        ) : null}
      </div>

      {(pendingPrompt || pendingApproval) && (
        <div className="side-chat__interaction" aria-label="侧边对话待处理交互">
          {pendingPrompt}
          {pendingApproval}
        </div>
      )}

      {commandFeedback}
      {goalStatus}
      {goalDialog}
      <form className="side-chat__composer" onSubmit={submit}>
        {commandMenu.menu}
        <ChatComposer
          className="pico-astryx-composer"
          value={draft}
          onChange={onDraftChange}
          onSubmit={send}
          isDisabled={unavailable}
          elevation="none"
          input={
            <ChatComposerInput
              {...commandMenu.inputProps}
              handleRef={editorRef}
              className="pico-chat-input"
              label="发送给临时分支"
              value={draft}
              onChange={onDraftChange}
              onSubmit={send}
              hasHistory={false}
              pasteAsToken={false}
              maxRows={200 / 22}
              placeholder={unavailable ? "临时分支就绪后可发送消息…" : "在临时分支中继续…"}
              isDisabled={unavailable}
              onKeyDown={handleDraftKeyDown}
            />
          }
          footerActions={
            <ConversationComposerMenu
              onAttach={resources ? () => openResources() : undefined}
              onAttachAgent={resources ? () => openResources("agent") : undefined}
              onSetGoal={onSetGoal}
              goalDisabled={goalDisabled}
              disabled={unavailable}
            >
              <span>{running ? "Agent 正在运行" : "Enter 发送 · Shift+Enter 换行"}</span>
            </ConversationComposerMenu>
          }
          sendButton={
            <>
              {running && (
                <span ref={stopSlot}>
                  <Button
                    label="停止"
                    className="side-chat__stop"
                    onClick={onStop}
                    icon={<Square aria-hidden="true" size={12} />}
                    size="sm"
                  />
                </span>
              )}
              {(!running || commandInput) && (
                <Button
                  type="submit"
                  className="side-chat__send"
                  label="发送消息"
                  isIconOnly
                  icon={<Send aria-hidden="true" size={14} />}
                  isDisabled={!canSend}
                  size="sm"
                />
              )}
            </>
          }
        />
      </form>
    </section>
  );
}

function SideChatErrorState({
  error,
  retrying,
  onRetry,
}: {
  readonly error: SideChatPanelError;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const noTurn = error.code === "no_settled_turn";
  return (
    <section className="side-chat__error" role="alert">
      <CircleAlert aria-hidden="true" size={17} />
      <div>
        <strong>{noTurn ? "需要一个已完成的回合" : "无法创建临时分支"}</strong>
        <p>{error.message}</p>
      </div>
      <Button
        label={retrying ? "重试中…" : "重试"}
        isDisabled={retrying}
        onClick={onRetry}
        size="sm"
      />
    </section>
  );
}

function sideChatStateLabel(state: SideChatChildState, running: boolean): string {
  if (state === "live" && running) return "运行中";
  const labels: Record<SideChatChildState, string> = {
    idle: "等待创建",
    creating: "创建中",
    live: "已连接",
    cleanup: "清理中",
    failed: "创建失败",
  };
  return labels[state];
}
