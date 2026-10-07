import { PendingSendNotice } from "../PendingSendNotice.js";
import {
  getComposerResources,
  parseComposerDraft,
  validateComposerReferences,
} from "../conversation/composer-references.js";
import { usePersistentDraft } from "../conversation/usePersistentDraft.js";
import { useDesktopCommands } from "../conversation/useDesktopCommands.js";
import { useConversationGoal } from "../conversation/ConversationGoalControls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConversationInteractionSlot } from "../conversation/ConversationInteractionSlot.js";
import { mergeConversationItemGroups } from "../conversation/items.js";
import type { ConversationItemView } from "../conversation/types.js";
import type { TimelineItem } from "../model.js";
import type { RuntimeStore } from "../runtime.js";
import { workspaceSessionKey } from "../workspace-session.js";
import {
  SideChatWorkbarPanel,
  type SideChatChildSession,
  type SideChatPanelError,
} from "./SideChatWorkbarPanel.js";
import { resolveSideChatCreationTarget } from "./side-chat-creation.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const deferredCleanup = new Map<string, number>();

export function SideChatPanelController({
  runtime,
  workspacePath,
  sourceSessionId,
  panelId,
  active,
  quoteRequest,
  onRequestClose,
}: {
  readonly runtime: RuntimeStore;
  readonly workspacePath: string;
  readonly sourceSessionId: string;
  readonly panelId: string;
  readonly active: boolean;
  readonly quoteRequest?: { readonly id: string; readonly text: string } | undefined;
  readonly onRequestClose: () => void;
}) {
  const { data, actions, busy } = runtime;
  const composerResources = getComposerResources(data, workspacePath);
  const [child, setChild] = useState<SideChatChildSession>({
    panelId,
    sourceSessionId,
    state: "idle",
  });
  const [resourceRequest, setResourceRequest] = useState<{ kind: "skill" | "agent"; id: number }>();
  const [stopFocusRequest, setStopFocusRequest] = useState(0);
  const [quoteFocusRequest, setQuoteFocusRequest] = useState(0);
  const [error, setError] = useState<SideChatPanelError | null>(null);
  const targetSessionIdRef = useRef<string | undefined>(undefined);
  const appliedQuoteIdRef = useRef<string | undefined>(undefined);
  const createGenerationRef = useRef(0);
  const cleanupKey = useMemo(
    () => JSON.stringify([workspacePath, sourceSessionId, panelId]),
    [panelId, sourceSessionId, workspacePath],
  );

  const sourceKey = `side:${cleanupKey}`;
  const pendingSend = runtime.pendingSends?.find(
    (entry) => entry.scope.picoHome === data.picoHome && entry.scope.sourceKey === sourceKey,
  );
  const { value: draft, update: setDraft, clear, clearIfUnchanged } = usePersistentDraft(sourceKey);

  useEffect(() => {
    if (!quoteRequest || appliedQuoteIdRef.current === quoteRequest.id) return;
    const quote = quoteRequest.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setDraft(`${draft.trimEnd()}${draft.trim() ? "\n\n" : ""}${quote}\n\n`);
    appliedQuoteIdRef.current = quoteRequest.id;
    setQuoteFocusRequest((current) => current + 1);
  }, [draft, quoteRequest, setDraft]);

  const create = useCallback(async () => {
    const generation = ++createGenerationRef.current;
    setChild((current) => ({ ...current, state: "creating" }));
    setError(null);
    const result = await window.pico.runtime["sideChat.create"]({
      workspacePath,
      sourceSessionId,
      panelId,
      idempotencyKey: `side-chat:${sourceSessionId}:${panelId}`,
    });
    if (generation !== createGenerationRef.current) return;
    if (!result.ok) {
      const noSettledTurn = result.error.message.includes("成功完成的回合");
      setChild((current) => ({ ...current, state: "failed" }));
      setError({
        code: noSettledTurn ? "no_settled_turn" : "create_failed",
        message: result.error.message,
      });
      return;
    }
    const creation = resolveSideChatCreationTarget(result.value);
    if (!creation) {
      setChild((current) => ({ ...current, state: "failed" }));
      setError({ code: "session_unavailable", message: "Runtime 未返回有效的临时会话" });
      return;
    }
    const { targetSessionId, throughEventId } = creation;
    targetSessionIdRef.current = targetSessionId;
    setChild({
      panelId,
      sourceSessionId,
      targetSessionId,
      throughEventId,
      state: "live",
    });
    await actions.loadSession({ workspacePath, sessionId: targetSessionId });
  }, [actions, panelId, sourceSessionId, workspacePath]);

  useEffect(() => {
    const pendingCleanup = deferredCleanup.get(cleanupKey);
    if (pendingCleanup !== undefined) {
      window.clearTimeout(pendingCleanup);
      deferredCleanup.delete(cleanupKey);
    }
    void create();
  }, [cleanupKey, create]);

  useEffect(() => {
    const targetSessionId = child.targetSessionId;
    if (child.state !== "live" || !targetSessionId) return;
    const heartbeat = window.setInterval(() => {
      void window.pico.runtime["sideChat.create"]({
        workspacePath,
        sourceSessionId,
        panelId,
        idempotencyKey: `side-chat:${sourceSessionId}:${panelId}`,
      });
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(heartbeat);
  }, [child.state, child.targetSessionId, panelId, sourceSessionId, workspacePath]);

  useEffect(() => {
    if (!active || child.state !== "live" || !child.targetSessionId) return;
    void actions.loadSession({ workspacePath, sessionId: child.targetSessionId });
  }, [actions, active, child.state, child.targetSessionId, workspacePath]);

  useEffect(
    () => () => {
      createGenerationRef.current += 1;
      const targetSessionId = targetSessionIdRef.current;
      if (!targetSessionId) return;
      const timeout = window.setTimeout(() => {
        deferredCleanup.delete(cleanupKey);
        void window.pico.runtime["sideChat.close"]({ workspacePath, sessionId: targetSessionId });
      }, 100);
      deferredCleanup.set(cleanupKey, timeout);
    },
    [cleanupKey, workspacePath],
  );

  const targetSessionId = child.targetSessionId;
  const conversation = targetSessionId
    ? data.conversations[workspaceSessionKey({ workspacePath, sessionId: targetSessionId })]
    : undefined;
  const sessionRuns = useMemo(
    () =>
      targetSessionId
        ? data.runs.filter(
            (run) => run.workspacePath === workspacePath && run.sessionId === targetSessionId,
          )
        : [],
    [data.runs, targetSessionId, workspacePath],
  );
  const activeRun = sessionRuns.find((run) => !isTerminalRun(run.status));
  const runIds = useMemo(() => new Set(sessionRuns.map((run) => run.id)), [sessionRuns]);
  const pendingApproval = data.approvals
    .filter(
      (item) => runIds.has(item.runId) && (item.kind === "plan" || item.runId === activeRun?.id),
    )
    .at(-1);
  const pendingPrompt = data.prompts.filter((item) => runIds.has(item.runId)).at(-1);
  const items = useMemo(() => {
    const live = activeRun
      ? data.timeline.filter((item) => item.runId === activeRun.id).map(sideChatTimelineItem)
      : [];
    return mergeConversationItemGroups(
      conversation?.items ?? [],
      conversation?.goalItem ? [conversation.goalItem] : [],
      live,
    );
  }, [activeRun, conversation?.items, conversation?.goalItem, data.timeline]);

  const close = useCallback(async () => {
    createGenerationRef.current += 1;
    const target = targetSessionIdRef.current;
    setChild((current) => ({ ...current, state: "cleanup" }));
    if (target) {
      await window.pico.runtime["sideChat.close"]({ workspacePath, sessionId: target });
      targetSessionIdRef.current = undefined;
    }
    onRequestClose();
  }, [onRequestClose, workspacePath]);

  const respondToApproval = useCallback(
    (
      decision:
        | "allow_once"
        | "allow_session"
        | "deny"
        | "execute"
        | "continue_editing"
        | "reject_exit"
        | "resume_execution"
        | "cancel_execution"
        | "replan_execution",
      feedback?: string,
    ) => {
      if (!pendingApproval || !targetSessionId) return;
      if (pendingApproval.kind === "plan") {
        void actions.respondPlan({
          planId: pendingApproval.planId,
          sessionId: targetSessionId,
          action: decision as
            | "execute"
            | "continue_editing"
            | "reject_exit"
            | "resume_execution"
            | "cancel_execution"
            | "replan_execution",
          expectedRevision: pendingApproval.expectedRevision,
          expectedSessionSequence: pendingApproval.expectedSessionSequence,
          controlEpoch: pendingApproval.controlEpoch,
          ...(feedback ? { feedback } : {}),
        });
        return;
      }
      void actions.respondApproval(
        pendingApproval.id,
        decision as "allow_once" | "allow_session" | "deny",
      );
    },
    [actions, pendingApproval, targetSessionId],
  );

  const commands = useDesktopCommands({
    runtime,
    workspacePath,
    sessionId: targetSessionId,
    running: Boolean(activeRun),
    draft,
    onConsumeDraft: clear,
    onOpenResource: (kind) => setResourceRequest({ kind, id: Date.now() }),
    onOpenControl: (target) => {
      if (target !== "interrupt" || !activeRun) return false;
      setStopFocusRequest((value) => value + 1);
      return true;
    },
    onOpenGoal: () => goalControls.openDialog(),
    onGoalControl: (input) => goalControls.control(input),
    onDraftChange: setDraft,
    blocked: Boolean(pendingApproval || pendingPrompt) || child.state !== "live",
  });

  const goalControls = useConversationGoal({
    snapshot: conversation?.goal,
    disabled: child.state !== "live" || conversation?.goal === undefined,
    busy:
      busy ===
      `goal-control:${targetSessionId ? workspaceSessionKey({ workspacePath, sessionId: targetSessionId }) : ""}`,
    costCNY: conversation?.usage?.costCNY,
    costStatus: conversation?.usage?.costStatus,
    onArm: async (draft) =>
      targetSessionId
        ? actions.controlGoal(
            { workspacePath, sessionId: targetSessionId },
            {
              action: "arm",
              expectedRevision: conversation?.goal?.currentGoal?.revision ?? 0,
              ...draft,
            },
          )
        : false,
    onAction: async (action, goal) =>
      targetSessionId
        ? actions.controlGoal(
            { workspacePath, sessionId: targetSessionId },
            {
              action,
              goalId: goal.id,
              expectedRevision: goal.revision,
            },
          )
        : false,
  });

  return (
    <SideChatWorkbarPanel
      workspacePath={workspacePath}
      commands={commands.suggestions}
      resources={composerResources}
      resourceRequest={resourceRequest}
      stopFocusRequest={stopFocusRequest}
      focusRequest={quoteFocusRequest}
      commandFeedback={
        <>
          {commands.feedback}
          {pendingSend && <PendingSendNotice runtime={runtime} entry={pendingSend} />}
        </>
      }
      sendPending={Boolean(pendingSend)}
      commandPending={commands.pending}
      activeRun={activeRun}
      goalStatus={goalControls.statusBar}
      goalDialog={goalControls.dialog}
      onSetGoal={goalControls.openDialog}
      goalDisabled={!goalControls.canSetGoal}
      child={child}
      items={items}
      draft={draft}
      active={active}
      running={Boolean(activeRun)}
      loading={child.state === "creating" || (child.state === "live" && !conversation)}
      error={error}
      pendingPrompt={
        pendingPrompt ? (
          <ConversationInteractionSlot
            prompt={pendingPrompt}
            busy={busy === "prompt"}
            onApprovalDecision={() => undefined}
            onPromptAnswer={(answer) => void actions.respondPrompt(pendingPrompt.id, answer)}
            onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
          />
        ) : undefined
      }
      pendingApproval={
        !pendingPrompt && pendingApproval ? (
          <ConversationInteractionSlot
            approval={pendingApproval}
            busy={busy === "approval"}
            onApprovalDecision={respondToApproval}
            onPromptAnswer={() => undefined}
            onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
          />
        ) : undefined
      }
      pendingApprovalCallId={pendingApproval?.providerCallId}
      onDraftChange={setDraft}
      onSend={(message) => {
        if (!targetSessionId) return;
        void (async () => {
          const parsed = parseComposerDraft(message);
          const failure = validateComposerReferences(
            parsed.references,
            composerResources.skills,
            composerResources.agents,
          );
          if (failure) {
            setError({ code: "unknown", message: failure });
            return;
          }
          if (!parsed.references.length && (await commands.execute(message))) return;
          if (pendingSend) return;
          await actions
            .sendMessage({
              workspacePath,
              sourceKey,
              draftSnapshot: draft,
              sessionId: targetSessionId,
              text: parsed.text,
              ...(parsed.references[0]?.kind === "agent"
                ? { activation: parsed.references[0] }
                : {}),
              ...(parsed.references.some((ref) => ref.kind === "skill")
                ? {
                    skills: parsed.references
                      .filter((ref) => ref.kind === "skill")
                      .map(({ name, sourceId, sourcePath }) => ({
                        name,
                        ...(sourceId ? { sourceId } : {}),
                        ...(sourcePath ? { sourcePath } : {}),
                      })),
                  }
                : {}),
            })
            .then((result) => {
              if (result.succeeded) clearIfUnchanged(draft);
            });
        })();
      }}
      onStop={() => activeRun && void actions.stopRun(activeRun.id)}
      onRetryCreate={() => void create()}
      onClose={() => void close()}
    />
  );
}

function sideChatTimelineItem(item: TimelineItem): ConversationItemView {
  if (item.kind === "plan") {
    return {
      id: item.id,
      kind: "plan",
      title: item.title,
      steps: [
        { id: `${item.id}:step`, title: item.detail ?? item.title, state: item.state ?? "active" },
      ],
      at: item.at,
    };
  }
  if (item.kind === "tool") {
    return {
      id: item.id,
      kind: "tool",
      toolName: item.title,
      title: item.title,
      detail: item.detail,
      state: item.state ?? "active",
      at: item.at,
    };
  }
  if (item.eventType === "assistant.message") {
    return { id: item.id, kind: "assistantMessage", text: item.detail ?? item.title, at: item.at };
  }
  return {
    id: item.id,
    kind: "status",
    title: item.title,
    detail: item.detail,
    tone: item.state === "failed" ? "error" : item.state === "done" ? "success" : "neutral",
    at: item.at,
  };
}

function isTerminalRun(status: string): boolean {
  return ["cancelled", "failed", "succeeded", "completed"].includes(status);
}
