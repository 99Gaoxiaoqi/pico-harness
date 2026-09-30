import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { parseSlashInput } from "@pico/core/slash-parser";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DesktopCommandSuggestion,
  DesktopCommandDestination,
} from "../../shared/command-policy.js";
import type { LocalCommandResult } from "@pico/cli/command-contracts";
import type { RuntimeUserDefaults } from "@pico/protocol";
import type {
  DesktopCommandContext,
  DesktopCommandAction,
  DesktopCommandExecution,
} from "../../preload/command-contract.js";
import type { RuntimeStore } from "../runtime.js";
import { newSessionHref, sessionHref, workspaceSessionKey } from "../workspace-session.js";
import { writePersistentDraft } from "./usePersistentDraft.js";
import { CommandDialog } from "./CommandDialog.js";
import type { ComposerCommands } from "./CommandSuggestions.js";
import { applyConversationSettings } from "./conversation-settings.js";
import { ComposerModelPicker } from "../ComposerModelPicker.js";
import { ConversationContextMenu } from "./ConversationContextMenu.js";
import "./commands.css";

export const isDesktopCommandInput = (text: string) => text.trimStart().startsWith("/");

export function useDesktopCommands({
  runtime,
  workspacePath,
  sessionId,
  running,
  initialSettings,
  draft,
  onConsumeDraft,
  onInitialSettings,
  onOpenGoal,
  onGoalControl,
  onOpenModel,
  onActivate,
  onOpenResource,
  onDraftChange,
  blocked = false,
}: {
  runtime: RuntimeStore;
  workspacePath: string;
  sessionId?: string | undefined;
  running: boolean;
  initialSettings?: RuntimeUserDefaults | undefined;
  draft: string;
  onConsumeDraft: () => void;
  onInitialSettings?: (settings: RuntimeUserDefaults) => void;
  onOpenGoal: () => void;
  onGoalControl: (
    input: Extract<DesktopCommandAction, { kind: "goal" }>["input"],
  ) => Promise<boolean>;
  onOpenModel?: () => void;
  onOpenResource?: (kind: "skill" | "agent") => void;
  onActivate?: (activation: { kind: "skill" | "agent"; name: string; subagentId?: string }) => void;
  onDraftChange: (text: string) => void;
  blocked?: boolean;
}) {
  const navigate = useNavigate();
  const scopeKey = JSON.stringify([workspacePath, sessionId]);
  const scope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const currentScope = useRef<typeof scope | undefined>(scope);
  currentScope.current = scope;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [catalog, setCatalog] = useState<readonly DesktopCommandSuggestion[]>([]);
  const [pendingScope, setPendingScope] = useState<typeof scope>();
  const pending = pendingScope === scope;
  const inFlight = useRef<typeof scope | undefined>(undefined);
  const unconfirmed = useRef(new Map<string, string>());
  const temporaryWorkspaces = useRef(new Map<string, string>());
  const [notice, setNotice] = useState<{
    key: string;
    text: string;
    redirect?: DesktopCommandExecution["redirect"];
  }>();
  const [native, setNative] = useState<{
    key: string;
    kind: "model" | "skill" | "agent" | "compact";
    commandDraft?: string | undefined;
  }>();
  const [compactScope, setCompactScope] = useState<typeof scope>();
  const compactBusy = compactScope === scope;
  const compactLock = useRef<typeof scope | undefined>(undefined);
  const [dialog, setDialog] = useState<{
    key: string;
    id: string;
    result: LocalCommandResult;
    context: DesktopCommandContext;
  }>();
  const context = useMemo(
    () => ({ workspacePath, sessionId, running, initialSettings }),
    [workspacePath, sessionId, running, initialSettings],
  );

  const ref = sessionId ? { workspacePath, sessionId } : undefined;
  const applySettings = (patch: RuntimeUserDefaults) =>
    applyConversationSettings(runtime, ref, initialSettings ?? {}, patch, onInitialSettings);
  function openNative(target: "goal" | "model" | "skill" | "agent" | "sessions") {
    if (target === "sessions") navigate("/sessions");
    else if (target === "goal") onOpenGoal();
    else if (target === "model" && onOpenModel) onOpenModel();
    else if ((target === "skill" || target === "agent") && onOpenResource) {
      window.requestAnimationFrame(() => onOpenResource(target));
    } else setNative({ key: scopeKey, kind: target });
  }
  function requestCompact() {
    setNative({ key: scopeKey, kind: "compact" });
  }
  async function openDestination(destination: DesktopCommandDestination) {
    if (currentScope.current !== scope) return;
    if (destination === "snapshots") {
      await execute("/rewind", false);
      return;
    }
    if (destination === "agents") {
      openNative("agent");
      return;
    }
    if ((destination === "memory" || destination === "automations") && !workspacePath) {
      setNotice({ key: scopeKey, text: "请先选择项目。" });
      return;
    }
    const paths = {
      skills: "/extensions/skills",
      sessions: "/sessions",
      workspaces: "/settings/workspaces",
      system: "/settings/system",
      usage: "/settings/usage",
      memory: "/memory",
      providers: "/settings/models",
      automations: "/automations",
      mcp: "/extensions/mcp",
    };
    const search = new URLSearchParams();
    if (workspacePath) search.set("workspace", workspacePath);
    navigate(`${paths[destination]}${search.size ? `?${search}` : ""}`);
  }
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = undefined;
    };
  }, [scope]);
  useEffect(() => {
    let stale = false;
    if (!window.pico?.commands) return;
    void window.pico.commands
      .catalog(context)
      .then((result) => {
        if (!stale && result.ok) setCatalog(result.value);
      })
      .catch(() => {
        if (!stale) setCatalog([]);
      });
    return () => {
      stale = true;
    };
  }, [context]);
  const suggestions = useMemo<ComposerCommands>(
    () => ({
      catalog,
      async complete(text) {
        if (!window.pico?.commands) return [];
        const result = await window.pico.commands.complete(context, text);
        return result.ok ? result.value : [];
      },
    }),
    [catalog, context],
  );

  async function execute(text: string, consumeDraft = true) {
    if (!isDesktopCommandInput(text)) return false;
    if (blocked || native?.key === scopeKey) return true;
    if (inFlight.current === scope) return true;
    inFlight.current = scope;
    setPendingScope(scope);
    const sourceScope = scope;
    const sourceDraft = currentDraft.current;
    try {
      if (!window.pico?.commands)
        throw new Error("当前桌面预览不支持命令执行，请在 Pico 桌面端使用。");
      const parsed = parseSlashInput(text);
      const sendsInput =
        parsed &&
        ((["skill", "use-skill"].includes(parsed.name) && parsed.argv.length > 0) ||
          (parsed.name === "agent" && parsed.argv.length > 1) ||
          (parsed.name === "swarm" &&
            parsed.args.trim() &&
            !["on", "off", "status"].includes(parsed.args.trim())));
      let targetWorkspace = workspacePath;
      if (!targetWorkspace && sendsInput) {
        targetWorkspace =
          temporaryWorkspaces.current.get(scopeKey) ??
          (await runtime.actions.ensureTemporaryWorkspace()) ??
          "";
        if (targetWorkspace) temporaryWorkspaces.current.set(scopeKey, targetWorkspace);
      }
      if (currentScope.current !== sourceScope) return true;
      const targetContext = { ...context, workspacePath: targetWorkspace };
      const identity = JSON.stringify([
        targetContext.workspacePath,
        sessionId,
        initialSettings,
        text,
      ]);
      const requestId = unconfirmed.current.get(identity) ?? crypto.randomUUID();
      unconfirmed.current.set(identity, requestId);
      const response = await window.pico.commands.execute(targetContext, text, requestId);
      if (currentScope.current !== sourceScope) return true;
      if (!response.ok) throw new Error(response.error.message);
      const {
        outcome,
        switchSession,
        initialSettings: updatedSettings,
        action,
        redirect,
      } = response.value;
      if (outcome.kind === "unknown" || outcome.kind === "rejected") {
        unconfirmed.current.delete(identity);
        setNotice({ key: scopeKey, text: outcome.message ?? "命令未执行。", redirect });
        return true;
      }
      const result = outcome.result;
      if (result?.message?.startsWith("命令执行失败：")) {
        setNotice({ key: scopeKey, text: result.message });
        return true;
      }
      let destinationSession = switchSession;
      if (updatedSettings && !(await applySettings(updatedSettings))) return true;
      if (action?.kind === "settings" && !(await applySettings(action.patch))) return true;
      if (action?.kind === "goal") {
        const succeeded = await onGoalControl(action.input);
        if (currentScope.current !== sourceScope) return true;
        if (!succeeded) {
          setNotice({ key: scopeKey, text: "Goal 未更新，请检查最新目标状态后重试。" });
          unconfirmed.current.delete(identity);
          if (ref) await runtime.actions.loadSession(ref);
          return true;
        }
      }
      if (action?.kind === "compact")
        setNative({
          key: scopeKey,
          kind: "compact",
          commandDraft: consumeDraft ? sourceDraft : undefined,
        });
      if (action?.kind === "open") openNative(action.target);
      if (
        action?.kind === "rename" &&
        ref &&
        !(await runtime.actions.renameSession(ref, action.title))
      )
        return true;
      if (action?.kind === "fork") {
        const forked = await runtime.actions.forkSession({
          workspacePath,
          sessionId: action.sessionId,
        });
        if (!forked) return true;
        destinationSession = forked.sessionId;
      }
      if (currentScope.current !== sourceScope) return true;
      unconfirmed.current.delete(identity);
      if (consumeDraft && action?.kind !== "compact" && currentDraft.current === sourceDraft)
        onConsumeDraft();
      const modelSelector = result?.ui?.kind === "open-selector" && result.ui.selector === "model";
      if (modelSelector) openNative("model");
      setDialog(
        result?.ui && !modelSelector
          ? { key: scopeKey, id: crypto.randomUUID(), result, context: targetContext }
          : undefined,
      );
      setNotice(
        result?.message && (!result.ui || modelSelector)
          ? { key: scopeKey, text: result.message }
          : undefined,
      );
      if (destinationSession !== undefined) {
        navigate(
          destinationSession === null
            ? newSessionHref(targetContext.workspacePath)
            : sessionHref({
                workspacePath: targetContext.workspacePath,
                sessionId: destinationSession,
              }),
        );
      }
      // Refresh only the conversation: reload bootstraps the app and unmounts command dialogs.
      if (targetContext.workspacePath) {
        const targetSession = destinationSession === undefined ? sessionId : destinationSession;
        if (targetSession)
          void runtime.actions.loadSession({
            workspacePath: targetContext.workspacePath,
            sessionId: targetSession,
          });
      }
    } catch (cause) {
      if (currentScope.current === sourceScope)
        setNotice({
          key: scopeKey,
          text: cause instanceof Error ? cause.message : String(cause),
        });
    } finally {
      if (inFlight.current === sourceScope) inFlight.current = undefined;
      setPendingScope((current) => (current === sourceScope ? undefined : current));
    }
    return true;
  }

  return {
    execute,
    pending,
    suggestions,
    requestCompact,
    feedback: (
      <>
        {notice?.key === scopeKey && (
          <section className="command-result" role="status" aria-label="命令结果">
            <header>
              <strong>命令结果</strong>
              <Button
                label="关闭命令结果"
                variant="ghost"
                size="sm"
                onClick={() => setNotice(undefined)}
              />
            </header>
            <pre>{notice.text}</pre>
            {notice.redirect && (
              <Button
                label={notice.redirect.label}
                onClick={() => void openDestination(notice.redirect!.destination)}
              />
            )}
          </section>
        )}
        {native?.key === scopeKey && native.kind === "compact" && (
          <Dialog
            isOpen
            onOpenChange={(open) => {
              if (!open && !compactBusy) setNative(undefined);
            }}
            aria-label="压缩上下文"
          >
            <section className="command-dialog">
              <h2>压缩上下文</h2>
              <p>将对当前会话生成上下文摘要，历史记录会保留。</p>
              <Button label="取消" isDisabled={compactBusy} onClick={() => setNative(undefined)} />
              <Button
                label="确认压缩"
                isDisabled={compactBusy || !ref}
                onClick={() => {
                  if (!ref || compactLock.current === scope) return;
                  compactLock.current = scope;
                  setCompactScope(scope);
                  void runtime.actions
                    .compactSession(ref)
                    .then((succeeded) => {
                      if (currentScope.current !== scope) return;
                      if (succeeded) {
                        if (
                          native.commandDraft !== undefined &&
                          currentDraft.current === native.commandDraft
                        )
                          onConsumeDraft();
                        setNative(undefined);
                      } else
                        setNotice({ key: scopeKey, text: "压缩失败，请检查 Runtime 错误后重试。" });
                    })
                    .catch((cause) => {
                      if (currentScope.current === scope)
                        setNotice({ key: scopeKey, text: String(cause) });
                    })
                    .finally(() => {
                      if (compactLock.current === scope) compactLock.current = undefined;
                      setCompactScope((current) => (current === scope ? undefined : current));
                    });
                }}
              />
            </section>
          </Dialog>
        )}
        {native?.key === scopeKey && native.kind === "model" && (
          <section className="command-result">
            <ComposerModelPicker
              routes={runtime.data.modelRoutes}
              providers={runtime.data.providerConfig.providers}
              value={
                ref
                  ? runtime.data.conversations[workspaceSessionKey(ref)]?.settings?.modelRouteId
                  : initialSettings?.modelRouteId
              }
              openRequest={1}
              disabled={running}
              onConfigure={() => navigate("/settings/models")}
              onChange={async (modelRouteId) => {
                if ((await applySettings({ modelRouteId })) && currentScope.current === scope)
                  setNative(undefined);
              }}
            />
            <Button label="关闭模型选择" onClick={() => setNative(undefined)} />
          </section>
        )}
        {native?.key === scopeKey && (native.kind === "skill" || native.kind === "agent") && (
          <ConversationContextMenu
            skills={native.kind === "skill" ? runtime.data.catalogSkills : []}
            agents={native.kind === "agent" ? runtime.data.catalogAgents : []}
            onClose={() => setNative(undefined)}
            onSelect={(activation) => {
              setNative(undefined);
              if (onActivate) onActivate(activation);
              else onDraftChange(`/${activation.kind} ${JSON.stringify(activation.name)} `);
            }}
          />
        )}
        {dialog?.key === scopeKey && (
          <CommandDialog
            key={dialog.id}
            context={dialog.context}
            result={dialog.result}
            catalog={catalog}
            onClose={() => setDialog(undefined)}
            onCommand={(input) => {
              setDialog(undefined);
              void execute(input, false);
            }}
            onRewind={(targetSessionId, prompt) => {
              if (currentScope.current !== scope) return;
              const ref = {
                workspacePath: dialog.context.workspacePath,
                sessionId: targetSessionId,
              };
              if (prompt) writePersistentDraft(workspaceSessionKey(ref), prompt);
              setDialog(undefined);
              void runtime.actions.loadSession(ref);
              navigate(sessionHref(ref));
            }}
          />
        )}
      </>
    ),
  };
}
