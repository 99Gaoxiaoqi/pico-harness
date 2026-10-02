import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { RuntimeConversationItem, RuntimePlanControlSnapshot } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Detail, Field, Label, s, color } from "../ui";
import { MessageMarkdown } from "../MessageMarkdown";
import { referencedMediaIds } from "../markdown";
import { MessageMedia } from "../MessageMedia";
import { streamingMediaText } from "../media";

export function StreamingItem({ kind, text }: { kind: string; text: string }) {
  const pico = usePico();
  const [expanded, setExpanded] = useState(false);
  const process = kind === "thinking" || kind === "toolOutput";
  return (
    <View style={process ? styles.process : styles.assistantMessage}>
      {process ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={styles.disclosure}
        >
          <Text style={s.muted}>
            {expanded ? "▾" : "▸"} {kind === "thinking" ? "思考中" : "工具输出"}
          </Text>
        </Pressable>
      ) : (
        <Label>Pico 正在回复</Label>
      )}
      {(!process || expanded) &&
        (process ? (
          <Text selectable style={s.muted}>
            {streamingMediaText(text)}
          </Text>
        ) : (
          <MessageMarkdown
            text={streamingMediaText(text)}
            renderMedia={() => null}
            onLink={(href) => void pico.perform(() => Linking.openURL(href))}
          />
        ))}
    </View>
  );
}
export function TranscriptItem({
  item,
  sessionId,
  syncReason,
  visible,
  onReview,
  onOpenChild,
}: {
  item: RuntimeConversationItem;
  sessionId: string;
  syncReason?: string;
  visible: boolean;
  onReview?: () => void;
  onOpenChild?: (sessionId: string, workspacePath: string) => void;
}) {
  const pico = usePico();
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState("");
  const label =
    item.kind === "userMessage"
      ? "你"
      : item.kind === "assistantMessage"
        ? "Pico"
        : item.kind === "tool"
          ? item.name
          : ({
              thinking: "思考过程",
              skill: "技能",
              plan: "计划",
              runBoundary: "任务",
              approval: "需要批准",
              prompt: "需要回答",
              changes: "更改",
              goal: "目标",
              subagent: "子代理",
              systemNotice: "提示",
              error: "错误",
            }[item.kind] ?? item.kind);
  const content =
    "content" in item
      ? String(item.content)
      : "detail" in item
        ? String(item.detail ?? "")
        : "summary" in item
          ? String(item.summary ?? "")
          : "";
  const waiting = (item.kind === "approval" || item.kind === "prompt") && item.state === "waiting";
  const message = item.kind === "userMessage" || item.kind === "assistantMessage";
  const process = item.kind === "thinking" || item.kind === "tool" || item.kind === "skill";
  if (message) {
    const media = item.media ?? [];
    const referenced = referencedMediaIds(content, media);
    const seen = new Set<string>();
    const standalone = media.filter((reference) => {
      if (referenced.has(reference.artifactId) || seen.has(reference.artifactId)) return false;
      seen.add(reference.artifactId);
      return true;
    });
    return (
      <View style={item.kind === "userMessage" ? styles.userMessage : styles.assistantMessage}>
        <View style={item.kind === "userMessage" ? styles.userBubble : undefined}>
          <MessageMarkdown
            text={content}
            media={media}
            renderMedia={(reference) => <MessageMedia reference={reference} visible={visible} />}
            onLink={(href) => void pico.perform(() => Linking.openURL(href))}
          />
          {standalone.map((reference) => (
            <MessageMedia key={reference.artifactId} reference={reference} visible={visible} />
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`查看${label}的消息详情`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}
        >
          <Text style={[s.muted, { fontSize: 11 }]}>{expanded ? "收起详情" : "消息详情"}</Text>
        </Pressable>
        {item.truncated && <Label>此记录因传输预算截断</Label>}
        {expanded && <Detail value={item} />}
      </View>
    );
  }
  return (
    <View style={[styles.process, waiting && styles.interaction]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.disclosure}
      >
        <View style={[s.row, { gap: 6 }, process && { flexWrap: "nowrap" }]}>
          <Text style={s.muted}>{expanded ? "▾" : "▸"}</Text>
          <Text style={[s.muted, { fontWeight: "500" }]}>{label}</Text>
          {"title" in item && <Text style={s.text}>{String(item.title)}</Text>}
          {"status" in item && <Label>{String(item.status)}</Label>}
          {!!content && process && !expanded && (
            <Text numberOfLines={1} style={[s.muted, { flex: 1 }]}>
              {content}
            </Text>
          )}
        </View>
      </Pressable>
      {!!content && (!process || expanded) && (
        <Text selectable style={process ? s.muted : s.text}>
          {content}
        </Text>
      )}
      {item.kind === "tool" && expanded && (
        <>
          <Text selectable style={s.mono}>
            {item.args}
          </Text>
          {item.result && (
            <Text selectable style={s.mono}>
              {item.result.projection.text}
            </Text>
          )}
        </>
      )}
      {item.truncated && <Label>此记录因传输预算截断</Label>}
      {waiting && item.kind === "approval" && item.data.kind !== "plan" && (
        <View style={s.row}>
          {(["allow_once", "allow_session", "deny"] as const).map((decision, i) => (
            <Button
              key={decision}
              title={["允许一次", "本会话允许", "拒绝"][i]!}
              reason={syncReason ?? pico.reason("approval.respond")}
              onPress={() =>
                void pico.perform(() =>
                  pico.request("approval.respond", {
                    sessionId,
                    approvalId: String(item.data.approvalId ?? item.id),
                    decision,
                    idempotencyKey: `approval:${item.id}:${decision}`,
                  }),
                )
              }
            />
          ))}
        </View>
      )}
      {waiting && item.kind === "prompt" && (
        <>
          <PromptOptions data={item.data} onChoose={setAnswer} />
          <Field label="回答" placeholder="输入回答" value={answer} onChange={setAnswer} compact />
          <View style={s.row}>
            <Button
              title="提交回答"
              reason={syncReason ?? pico.reason("prompt.respond")}
              onPress={() =>
                void pico.perform(() =>
                  pico.request("prompt.respond", {
                    sessionId,
                    promptId: String(item.data.promptId ?? item.id),
                    answer,
                    idempotencyKey: `prompt:${item.id}:${answer}`,
                  }),
                )
              }
            />
            <Button
              title="取消"
              secondary
              reason={syncReason ?? pico.reason("prompt.cancel")}
              onPress={() =>
                void pico.perform(() =>
                  pico.request("prompt.cancel", {
                    sessionId,
                    promptId: String(item.data.promptId ?? item.id),
                  }),
                )
              }
            />
          </View>
        </>
      )}
      {item.kind === "changes" && onReview && (
        <Button title="查看改动 →" quiet onPress={onReview} />
      )}
      {item.kind === "subagent" &&
        (typeof item.data?.childSessionId === "string" &&
        typeof item.data?.childWorkspacePath === "string" &&
        onOpenChild ? (
          <Button
            title="打开子会话 →"
            quiet
            reason={pico.reason("session.get")}
            onPress={() =>
              onOpenChild(
                item.data!.childSessionId as string,
                item.data!.childWorkspacePath as string,
              )
            }
          />
        ) : (
          <Label>子会话身份未明确，请在电脑查看。</Label>
        ))}
      {expanded && <Detail value={item} />}
    </View>
  );
}
function PromptOptions({
  data,
  onChoose,
}: {
  data: Record<string, unknown>;
  onChoose: (x: string) => void;
}) {
  const options = Array.isArray(data.options) ? data.options : [];
  return (
    <View style={s.row}>
      {options.map((x, i) => (
        <Button
          key={i}
          secondary
          title={typeof x === "string" ? x : String((x as Record<string, unknown>).label ?? i + 1)}
          onPress={() =>
            onChoose(
              typeof x === "string"
                ? x
                : String(
                    (x as Record<string, unknown>).value ??
                      (x as Record<string, unknown>).label ??
                      i,
                  ),
            )
          }
        />
      ))}
    </View>
  );
}
export function PlanCard({
  plan,
  sessionId,
  syncReason,
}: {
  plan: RuntimePlanControlSnapshot;
  sessionId: string;
  syncReason?: string;
}) {
  const pico = usePico();
  const [feedback, setFeedback] = useState("");
  const proposal = plan.projection.pendingProposal ?? plan.projection.latestProposal;
  const execution = plan.projection.execution;
  if (!proposal && !execution) return null;
  const id = proposal?.planId ?? execution!.planId;
  const revision = proposal?.revision ?? execution!.revision;
  const actions =
    plan.state === "interrupted"
      ? (["resume_execution", "cancel_execution", "replan_execution"] as const)
      : plan.state === "pending_review"
        ? (["execute", "continue_editing", "reject_exit"] as const)
        : [];
  return (
    <Card style={{ marginTop: 10 }}>
      <Text style={s.text}>
        {proposal?.title ?? "执行计划"} · {plan.state}
      </Text>
      {(proposal?.steps ?? execution?.steps)?.map((x) => (
        <Text key={x.id} style={s.text}>
          {x.status === "completed" ? "✓" : "○"} {x.title}
        </Text>
      ))}
      {proposal?.overview && <Text style={s.text}>{proposal.overview}</Text>}
      {!!actions.length && (
        <>
          <Field
            label="反馈（可选）"
            placeholder="补充反馈（可选）"
            value={feedback}
            onChange={setFeedback}
            compact
          />
          <View style={s.row}>
            {actions.map((action) => (
              <Button
                key={action}
                title={
                  {
                    execute: "批准执行",
                    continue_editing: "继续修改",
                    reject_exit: "拒绝",
                    resume_execution: "恢复",
                    cancel_execution: "取消",
                    replan_execution: "重新规划",
                  }[action]
                }
                reason={
                  syncReason ??
                  (plan.availability !== "ready" ? "计划控制暂不可用" : pico.reason("plan.respond"))
                }
                onPress={() =>
                  void pico.perform(() =>
                    pico.request("plan.respond", {
                      sessionId,
                      planId: id,
                      action,
                      expectedRevision: revision,
                      expectedSessionSequence: plan.projection.sessionSequence,
                      controlEpoch: plan.projection.controlEpoch ?? "",
                      ...(feedback ? { feedback } : {}),
                    }),
                  )
                }
              />
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  userMessage: { alignSelf: "flex-end", maxWidth: "92%", gap: 6, marginTop: 10, marginBottom: 16 },
  userBubble: {
    backgroundColor: color.surface,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 28,
  },
  assistantMessage: { gap: 6, marginTop: 10, marginBottom: 16 },
  process: { gap: 4, paddingVertical: 3 },
  disclosure: { minHeight: 44, justifyContent: "center" },
  interaction: {
    backgroundColor: color.panel,
    padding: 12,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
  },
});
