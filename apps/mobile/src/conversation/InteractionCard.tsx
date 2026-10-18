import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  parseApprovalSessionScope,
  type ApprovalSessionScopeView,
  type RuntimeConversationItem,
} from "@pico/protocol/mobile";
import { usePico } from "../store";
import { ActionsSheet } from "../ActionsSheet";
import { Detail, Label, s, color } from "../ui";

type Interaction = Extract<RuntimeConversationItem, { kind: "approval" | "prompt" }>;
type Decision = "allow_once" | "allow_session" | "deny";
type Action = Decision | "answer" | "cancel";
type CardScope = { key: string };
type Submission = {
  scope: CardScope;
  action: Action;
  answer: string;
  pending: boolean;
  complete?: string;
  error?: string;
  unknown?: boolean;
};
// Keep an unfinished answer when the transcript virtualizes or the user visits another session.
// Answers stay in memory only, scoped to the host, workspace, session and question.
const answerDrafts = new Map<string, string>();

export function InteractionCard({
  item,
  sessionId,
  syncReason,
  onResize,
}: {
  item: Interaction;
  sessionId: string;
  syncReason?: string;
  onResize?: () => void;
}) {
  const pico = usePico();
  const interactionId = String(
    (item.kind === "approval" ? item.data.approvalId : item.data.promptId) ?? item.id,
  );
  const draftScope = JSON.stringify([
    pico.host?.id,
    pico.workspace?.id,
    sessionId,
    item.kind,
    interactionId,
  ]);
  const requestScope = JSON.stringify([draftScope, pico.generation]);
  const selected = useRef<CardScope>({ key: requestScope });
  if (selected.current.key !== requestScope) selected.current = { key: requestScope };
  const selection = selected.current;
  const mounted = useRef(true);
  const pending = useRef<{ scope: CardScope; token: symbol } | undefined>(undefined);
  const [draft, setDraft] = useState({
    scope: draftScope,
    value: answerDrafts.get(draftScope) ?? "",
  });
  const [submission, setSubmission] = useState<Submission>();
  const [answerSheet, setAnswerSheet] = useState<CardScope>();
  const answer = draft.scope === draftScope ? draft.value : (answerDrafts.get(draftScope) ?? "");
  const view = submission?.scope === selection ? submission : undefined;
  const waiting = item.state === "waiting" && !view?.complete;
  const busy = !!view?.pending;
  const scope =
    item.kind === "approval" ? parseApprovalSessionScope(item.data.sessionScope) : undefined;
  const method = (action: Action) =>
    action === "answer"
      ? "prompt.respond"
      : action === "cancel"
        ? "prompt.cancel"
        : "approval.respond";
  const disabledReason = (action: Action) =>
    busy ? "正在提交，请稍候" : (syncReason ?? pico.reason(method(action)));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (item.state !== "waiting") answerDrafts.delete(draftScope);
  }, [draftScope, item.state]);

  function changeAnswer(value: string) {
    if (
      !waiting ||
      pending.current?.scope === selection ||
      selected.current !== selection ||
      view?.unknown
    )
      return;
    answerDrafts.set(draftScope, value);
    setDraft({ scope: draftScope, value });
  }
  async function submit(action: Action, submittedAnswer = answer) {
    if (
      !waiting ||
      !mounted.current ||
      selected.current !== selection ||
      pending.current?.scope === selection ||
      disabledReason(action) ||
      (action === "answer" && !submittedAnswer.trim()) ||
      (action === "allow_session" && !scope)
    )
      return;
    const token = Symbol();
    pending.current = { scope: selection, token };
    const next: Submission = {
      scope: selection,
      action,
      answer: submittedAnswer,
      pending: true,
    };
    setSubmission(next);
    const current = () =>
      mounted.current && selected.current === selection && pending.current?.token === token;
    try {
      let accepted: boolean;
      if (action === "answer") {
        const result = await pico.request("prompt.respond", {
          sessionId,
          promptId: interactionId,
          answer: submittedAnswer,
          idempotencyKey: `prompt:${item.id}:${submittedAnswer}`,
        });
        accepted = result.accepted;
      } else if (action === "cancel") {
        const result = await pico.request("prompt.cancel", { sessionId, promptId: interactionId });
        accepted = result.cancelled;
      } else {
        const result = await pico.request("approval.respond", {
          sessionId,
          approvalId: interactionId,
          decision: action,
          idempotencyKey: `approval:${item.id}:${action}`,
        });
        accepted = result.accepted;
      }
      if (!current()) return;
      if (!accepted) throw new Error("电脑未接受此操作，请同步后重试");
      answerDrafts.delete(draftScope);
      setSubmission({ ...next, pending: false, complete: completedLabel(action) });
      setAnswerSheet(undefined);
      onResize?.();
    } catch (error) {
      if (!current()) return;
      const detail =
        error && typeof error === "object"
          ? (error as { message?: unknown; outcome?: unknown })
          : {};
      setSubmission({
        ...next,
        pending: false,
        error: typeof detail.message === "string" ? detail.message : "提交失败，请重试",
        unknown: detail.outcome === "unknown",
      });
      onResize?.();
    } finally {
      if (pending.current?.token === token) pending.current = undefined;
    }
  }
  const status =
    view?.complete ??
    (item.state === "waiting"
      ? busy
        ? "正在提交"
        : item.kind === "approval"
          ? "需要批准"
          : "需要回答"
      : item.kind === "approval"
        ? completedLabel(item.state as Decision)
        : "已处理 · 问题已结束");
  const operation = item.kind === "approval" ? operationPreview(item.data) : undefined;
  const options =
    item.kind === "prompt" && Array.isArray(item.data.options) ? item.data.options : [];
  const submissionError = waiting && view?.error && (
    <View style={styles.error}>
      <Text accessibilityRole="alert" style={styles.dangerText}>
        {view.unknown ? "结果尚未确认。" : "提交未完成。"}
        {view.error}
      </Text>
      {item.kind === "prompt" && <Label>回答草稿已保留。</Label>}
      <ActionButton
        title="重试上次操作"
        secondary
        reason={disabledReason(view.action)}
        onPress={() => void submit(view.action, view.answer)}
      />
    </View>
  );
  const retryAnswer = view?.error && (view.action !== "answer" || view.answer === answer);
  const promptFooter = (
    <View style={styles.promptFooter}>
      {view?.error && (
        <Text accessibilityRole="alert" numberOfLines={2} style={styles.dangerText}>
          {view.unknown ? "结果尚未确认。" : "提交未完成。"}
          {view.error}
        </Text>
      )}
      {(syncReason ?? pico.reason("prompt.respond")) && (
        <Label>{syncReason ?? pico.reason("prompt.respond")}</Label>
      )}
      {busy && <Label>正在提交，请稍候…</Label>}
      <View style={styles.footerActions}>
        <View style={styles.footerAction}>
          <ActionButton
            title={retryAnswer ? "重试上次操作" : "提交回答"}
            reason={
              retryAnswer
                ? disabledReason(view.action)
                : (disabledReason("answer") ?? (!answer.trim() ? "请先输入或选择回答" : undefined))
            }
            onPress={() => void (retryAnswer ? submit(view.action, view.answer) : submit("answer"))}
          />
        </View>
        {!view?.unknown && (
          <View style={styles.footerAction}>
            <ActionButton
              title="取消提问"
              secondary
              reason={disabledReason("cancel")}
              onPress={() => void submit("cancel")}
            />
          </View>
        )}
      </View>
    </View>
  );
  return (
    <View style={styles.card}>
      <Text
        accessibilityLiveRegion="polite"
        style={[
          styles.status,
          !waiting && styles.handled,
          (item.state === "deny" || (view?.action === "deny" && view.complete)) &&
            styles.dangerText,
        ]}
      >
        {status}
      </Text>
      <Text style={styles.title}>{item.title}</Text>
      {item.detail && (
        <View style={styles.section}>
          {item.kind === "approval" && <Label>原因</Label>}
          <Text selectable style={s.text}>
            {item.detail}
          </Text>
        </View>
      )}
      {operation && (
        <View style={styles.operation}>
          <Label>{operation.label}</Label>
          <Text selectable style={[s.mono, styles.operationText]}>
            {operation.text}
          </Text>
        </View>
      )}
      {waiting && item.kind === "approval" && item.data.kind !== "plan" && (
        <>
          <Label>允许一次：仅批准当前操作。</Label>
          {scope && (
            <View style={styles.scope}>
              <Label>本会话允许的范围</Label>
              <Text selectable style={s.text}>
                {scopeDescription(scope)}
              </Text>
            </View>
          )}
          {!view?.unknown && (
            <View style={styles.actions}>
              <ActionButton
                title="允许一次"
                reason={disabledReason("allow_once")}
                onPress={() => void submit("allow_once")}
              />
              {scope && (
                <ActionButton
                  title="本会话允许"
                  secondary
                  reason={disabledReason("allow_session")}
                  onPress={() => void submit("allow_session")}
                />
              )}
              <ActionButton
                title="拒绝"
                danger
                reason={disabledReason("deny")}
                onPress={() => void submit("deny")}
              />
            </View>
          )}
        </>
      )}
      {waiting && item.kind === "approval" && item.data.kind === "plan" && (
        <Label>请在执行计划卡片中处理。</Label>
      )}
      {waiting && item.kind === "prompt" && (
        <>
          <Label>{answer ? "回答草稿已保留。" : "打开回答面板，选择选项或填写回答。"}</Label>
          <ActionButton
            title={answer ? "继续填写" : "填写回答"}
            onPress={() => {
              if (selected.current === selection) setAnswerSheet(selection);
            }}
          />
          {view?.error && (
            <Text style={styles.dangerText}>
              {view.unknown
                ? "结果尚未确认，请打开回答面板重试原操作。"
                : "提交未完成，请打开回答面板重试。"}
            </Text>
          )}
          {answerSheet === selection && (
            <ActionsSheet
              title="回答问题"
              footer={promptFooter}
              open
              onClose={() => {
                if (selected.current === selection) setAnswerSheet(undefined);
              }}
            >
              <Text style={styles.title}>{item.title}</Text>
              {item.detail && <Text style={s.text}>{item.detail}</Text>}
              <View style={styles.actions}>
                {options.map((option, index) => {
                  const record =
                    option && typeof option === "object" ? (option as Record<string, unknown>) : {};
                  const title =
                    typeof option === "string" ? option : String(record.label ?? index + 1);
                  const value =
                    typeof option === "string"
                      ? option
                      : String(record.optionId ?? record.value ?? record.label ?? index);
                  return (
                    <ActionButton
                      key={index}
                      title={title}
                      detail={
                        typeof record.description === "string" ? record.description : undefined
                      }
                      secondary
                      selected={answer === value}
                      reason={
                        busy ? "正在提交，请稍候" : view?.unknown ? "先确认上次提交结果" : undefined
                      }
                      onPress={() => changeAnswer(value)}
                    />
                  );
                })}
                <Label>回答</Label>
                <TextInput
                  accessibilityLabel="回答"
                  placeholder="输入回答或选择上方选项"
                  placeholderTextColor={color.faint}
                  value={answer}
                  onChangeText={changeAnswer}
                  editable={!busy && !view?.unknown}
                  multiline
                  textAlignVertical="top"
                  style={[s.input, styles.answer]}
                />
              </View>
            </ActionsSheet>
          )}
        </>
      )}
      {waiting &&
        (syncReason ??
          pico.reason(item.kind === "approval" ? "approval.respond" : "prompt.respond")) && (
          <Label>
            {syncReason ??
              pico.reason(item.kind === "approval" ? "approval.respond" : "prompt.respond")}
          </Label>
        )}
      {view?.complete && view.action === "answer" && (
        <Text selectable style={s.text}>
          {view.answer}
        </Text>
      )}
      {item.kind === "approval" && submissionError}
      {item.truncated && <Label>此记录因传输预算截断</Label>}
      <Detail value={item} title="操作详情" />
    </View>
  );
}

function completedLabel(action: Action) {
  return {
    allow_once: "已允许一次",
    allow_session: "已允许 · 本会话范围",
    deny: "已拒绝",
    answer: "已提交回答",
    cancel: "已取消提问",
  }[action];
}
function operationPreview(data: Record<string, unknown>) {
  const raw =
    typeof data.command === "string"
      ? data.command
      : typeof data.args === "string"
        ? data.args
        : data.args && typeof data.args === "object"
          ? JSON.stringify(data.args, null, 2)
          : "";
  if (!raw) return undefined;
  const label =
    data.toolName === "bash"
      ? "命令"
      : ["read_file", "write_file", "edit_file"].includes(String(data.toolName))
        ? "路径"
        : "操作内容";
  try {
    const args: unknown = JSON.parse(raw);
    if (args && typeof args === "object") {
      const value = (args as Record<string, unknown>)[label === "路径" ? "path" : "command"];
      if (typeof value === "string") return { label, text: value };
    }
  } catch {
    /* A shell command is already readable text. */
  }
  return { label, text: raw };
}
function scopeDescription(scope: ApprovalSessionScopeView): string {
  switch (scope.type) {
    case "network":
      return "本会话后续网络访问自动允许；文件与命令仍按当前权限判断。";
    case "all-edits":
      return "权限切换为“帮我批准”，本会话普通文件修改免审批；敏感操作仍需确认。";
    case "directories":
      return `本会话可${scope.access === "read" ? "读取" : "修改"}以下授权目录：\n${scope.directories.join("\n")}${scope.enableAutoEdits ? "\n权限切换为“帮我批准”，本会话普通文件修改免审批；敏感操作仍需确认。" : ""}`;
    case "file":
      return `本会话仅允许${scope.access === "read" ? "读取" : "修改"}此文件：\n${scope.path}`;
    case "bash-command":
      return `本会话允许${scope.match === "exact" ? "与以下内容完全匹配的命令" : "所有匹配以下前缀的命令"}：\n${scope.command}`;
    case "tool":
      return `本会话后续调用 ${scope.toolName} 工具将自动允许。`;
  }
}
function ActionButton({
  title,
  detail,
  onPress,
  reason,
  secondary,
  danger,
  selected,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  reason?: string;
  secondary?: boolean;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={reason ?? detail}
      accessibilityState={{ disabled: !!reason, selected }}
      disabled={!!reason}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        (secondary || danger) && styles.secondary,
        selected && styles.selected,
        reason && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[styles.buttonText, secondary && styles.secondaryText, danger && styles.dangerText]}
      >
        {selected ? "✓ " : ""}
        {title}
      </Text>
      {detail && <Text style={s.muted}>{detail}</Text>}
    </Pressable>
  );
}
const styles = StyleSheet.create({
  card: {
    backgroundColor: color.panel,
    padding: 16,
    marginVertical: 10,
    gap: 12,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 16,
  },
  status: { color: color.warning, fontSize: 13, fontWeight: "600" },
  handled: { color: color.muted },
  title: { color: color.text, fontSize: 16, lineHeight: 24, fontWeight: "600" },
  section: { gap: 4 },
  operation: { padding: 12, gap: 6, borderRadius: 10, backgroundColor: color.surface },
  operationText: { color: color.text, flexShrink: 1 },
  scope: { gap: 4, borderLeftWidth: 2, borderLeftColor: color.lineStrong, paddingLeft: 10 },
  actions: { gap: 8 },
  answer: { minHeight: 88 },
  promptFooter: { gap: 8 },
  footerActions: { flexDirection: "row", gap: 8 },
  footerAction: { flex: 1, minWidth: 0 },
  error: { gap: 8, padding: 12, backgroundColor: color.dangerSoft, borderRadius: 10 },
  button: {
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: 10,
    backgroundColor: color.accent,
  },
  buttonText: {
    color: color.bg,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    textAlign: "center",
  },
  secondary: { backgroundColor: color.bg, borderColor: color.line },
  secondaryText: { color: color.text },
  dangerText: { color: color.danger },
  selected: { borderColor: color.accent, backgroundColor: color.accentSoft },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
