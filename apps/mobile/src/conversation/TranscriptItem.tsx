import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type {
  RuntimeConversationItem,
  RuntimePlanControlSnapshot,
  RuntimeTranscriptItemRecord,
} from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Detail, Field, Label, s, color } from "../ui";
import { MessageMarkdown } from "../MessageMarkdown";
import { referencedMediaIds } from "../markdown";
import { MessageMedia } from "../MessageMedia";
import { streamingMediaText } from "../media";
import { InteractionCard } from "./InteractionCard";

export function ProcessGroup({
  records,
  sessionId,
  syncReason,
  onResize,
}: {
  records: readonly RuntimeTranscriptItemRecord[];
  sessionId: string;
  syncReason?: string;
  onResize: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tools = records.filter((record) => record.item.kind === "tool");
  const running = tools.some(
    (record) => record.item.kind === "tool" && record.item.status === "running",
  );
  const label = tools.length
    ? `${running ? "执行中" : "执行过程"} · ${tools.length} 项操作`
    : `思考过程 · ${records.length} 段`;
  return (
    <View style={styles.process}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}，${expanded ? "收起" : "展开"}`}
        accessibilityState={{ expanded }}
        onPress={() => {
          onResize();
          setExpanded(!expanded);
        }}
        style={styles.disclosure}
      >
        <Text style={s.muted}>
          {expanded ? "▾" : "▸"} {label}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.groupContents}>
          {records.map((record) => (
            <TranscriptItem
              key={record.itemId}
              item={record.item}
              sessionId={sessionId}
              syncReason={syncReason}
              visible={false}
              onResize={onResize}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export function StreamingItem({
  kind,
  text,
  onResize,
}: {
  kind: string;
  text: string;
  onResize?: () => void;
}) {
  const pico = usePico();
  const [expanded, setExpanded] = useState(false);
  const process = kind === "thinking" || kind === "toolOutput";
  return (
    <View style={process ? styles.process : styles.assistantMessage}>
      {process ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => {
            onResize?.();
            setExpanded(!expanded);
          }}
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
  onResize,
}: {
  item: RuntimeConversationItem;
  sessionId: string;
  syncReason?: string;
  visible: boolean;
  onReview?: () => void;
  onOpenChild?: (sessionId: string, workspacePath: string) => void;
  onResize?: () => void;
}) {
  const pico = usePico();
  const [expanded, setExpanded] = useState(false);
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
        {item.truncated && <Label>此记录因传输预算截断</Label>}
      </View>
    );
  }
  if (item.kind === "approval" || item.kind === "prompt")
    return (
      <InteractionCard
        item={item}
        sessionId={sessionId}
        syncReason={syncReason}
        onResize={onResize}
      />
    );
  if (item.kind === "changes")
    return (
      <View style={styles.resultCard}>
        <Label>{item.state === "applied" ? "改动已应用" : "改动已更新"}</Label>
        <Text style={styles.resultTitle}>
          {item.title === "Changes applied" || item.title === "Changes updated"
            ? "代码改动"
            : item.title}
        </Text>
        {!!content && (
          <Text selectable style={s.text}>
            {content}
          </Text>
        )}
        {onReview && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看改动：${item.title}`}
            onPress={onReview}
            style={styles.resultRow}
          >
            <Text style={styles.resultAction}>查看改动</Text>
            <Text style={s.muted}>›</Text>
          </Pressable>
        )}
        {item.truncated && <Label>此记录因传输预算截断</Label>}
        <Detail value={item} title="改动详情" />
      </View>
    );
  return (
    <View style={styles.process}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => {
          onResize?.();
          setExpanded(!expanded);
        }}
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
  groupContents: { paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: color.line },
  resultCard: {
    gap: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 16,
    marginVertical: 10,
  },
  resultTitle: { color: color.text, fontSize: 16, lineHeight: 24, fontWeight: "600" },
  resultAction: { color: color.text, fontSize: 14, fontWeight: "600" },
  resultRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: color.surface,
  },
  disclosure: { minHeight: 44, justifyContent: "center" },
});
