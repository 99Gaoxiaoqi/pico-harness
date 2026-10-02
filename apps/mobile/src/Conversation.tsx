import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import type {
  RuntimeConversationItem,
  RuntimeInputAttachment,
  RuntimePlanControlSnapshot,
  RuntimeSessionSettings,
} from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { MobileTranscript } from "./transcript";
import { usePico } from "./store";
import { decodedBase64Size, validateAttachments } from "./core";
import { Button, Card, Chips, Detail, Field, Label, s, color } from "./ui";

export function Conversation({
  sessionId,
  onSession,
  onPanel,
}: {
  sessionId: string;
  onSession: (id: string) => void;
  onPanel: () => void;
}) {
  const pico = usePico();
  const [view, setView] = useState<TranscriptReplicaView>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<RuntimeInputAttachment[]>([]);
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [mode, setMode] = useState<"auto" | "steer" | "queue" | "replace">("auto");
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const [uncertain, setUncertain] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [plan, setPlan] = useState<RuntimePlanControlSnapshot>();
  const controller = useRef<MobileTranscript | undefined>(undefined);
  useEffect(() => {
    if (!pico.workspace || !pico.connected) return;
    const subscription = new MobileTranscript(pico, pico.workspace.id, sessionId, (v) => {
      setView(v);
      setPlan(subscription.planControl);
    });
    controller.current = subscription;
    const off = pico.onFrame((frame) => void subscription.receive(frame).catch(pico.report));
    void subscription.open().catch(pico.report);
    void pico
      .request("session.settings.get", { sessionId })
      .then((x) => setSettings(x.settings))
      .catch(pico.report);
    return () => {
      off();
      subscription.dispose();
      controller.current = undefined;
    };
  }, [pico.generation, pico.connected, pico.workspace?.id, sessionId]);
  useEffect(() => {
    setText("");
    setImages([]);
    setUncertain(false);
    setFrozen(false);
    setKey(Crypto.randomUUID());
    setView(undefined);
  }, [sessionId]);
  async function addImage(camera = false) {
    try {
      if (images.length >= 4) throw new Error("最多选择 4 张图片");
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error("需要相机权限");
      }
      const selected = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
      if (selected.canceled) return;
      let image: RuntimeInputAttachment | undefined;
      for (const width of [1024, 768, 512, 320, 192]) {
        const result = await manipulateAsync(selected.assets[0]!.uri, [{ resize: { width } }], {
          compress: 0.55,
          format: SaveFormat.JPEG,
          base64: true,
        });
        if (!result.base64) continue;
        const candidate: RuntimeInputAttachment = {
          type: "image_base64",
          mimeType: "image/jpeg",
          data: result.base64,
        };
        try {
          validateAttachments([...images, candidate]);
          image = candidate;
          break;
        } catch {
          /* shrink */
        }
      }
      if (!image) throw new Error("图片无法压缩至剩余附件预算");
      setImages([...images, image]);
    } catch (error) {
      pico.report(error);
    }
  }
  async function send() {
    setSending(true);
    try {
      validateAttachments(images);
      const result = await pico.request("session.send", {
        sessionId,
        input: { kind: "text", text, ...(images.length ? { attachments: images } : {}) },
        behavior: mode,
        idempotencyKey: key,
        ...(view?.activeRun ? { expectedRunId: view.activeRun.runId } : {}),
      });
      setText("");
      setImages([]);
      setKey(Crypto.randomUUID());
      setUncertain(false);
      setFrozen(false);
      onSession(result.session.sessionId);
    } catch (error) {
      setUncertain(true);
      setFrozen(true);
      pico.report(error);
      await controller.current?.open().catch(pico.report);
    } finally {
      setSending(false);
    }
  }
  const run = view?.activeRun;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={[s.body, { paddingVertical: 10 }]}>
        <View style={s.row}>
          <Button title="工作栏" secondary onPress={onPanel} />
          <Button
            title="侧聊"
            secondary
            reason={pico.reason("sideChat.create")}
            onPress={() =>
              void pico.perform(async () => {
                const x = await pico.request("sideChat.create", {
                  sourceSessionId: sessionId,
                  panelId: Crypto.randomUUID(),
                  idempotencyKey: Crypto.randomUUID(),
                });
                onSession(x.session.sessionId);
              })
            }
          />
          {run && <Label>{run.status}</Label>}
        </View>
        {run && (
          <View style={s.row}>
            <Button
              title="暂停"
              secondary
              reason={pico.reason("run.pause")}
              onPress={() =>
                void pico.perform(() => pico.request("run.pause", { runId: run.runId }))
              }
            />
            <Button
              title="继续"
              secondary
              reason={pico.reason("run.resume")}
              onPress={() =>
                void pico.perform(() => pico.request("run.resume", { runId: run.runId }))
              }
            />
            <Button
              title="停止"
              secondary
              reason={pico.reason("run.cancel")}
              onPress={() =>
                Alert.alert("停止当前任务？", run.description, [
                  { text: "返回" },
                  {
                    text: "停止",
                    style: "destructive",
                    onPress: () =>
                      void pico.perform(() => pico.request("run.cancel", { runId: run.runId })),
                  },
                ])
              }
            />
          </View>
        )}
        {settings && (
          <View style={s.row}>
            <Label>
              {settings.model} · {settings.collaborationMode} · {settings.permissionMode}
            </Label>
            <Button title="会话设置" secondary onPress={onPanel} />
          </View>
        )}
      </View>
      <FlatList
        data={view?.records ?? []}
        keyExtractor={(x) => x.itemId}
        contentContainerStyle={s.body}
        ListHeaderComponent={
          view?.olderCursor ? (
            <Button
              title="加载更早记录"
              secondary
              onPress={() => void pico.perform(() => controller.current!.older())}
            />
          ) : null
        }
        renderItem={({ item }) => <TranscriptItem item={item.item} sessionId={sessionId} />}
        ListEmptyComponent={
          <Label>{pico.connected ? "正在读取历史…" : "连接恢复后会补齐记录"}</Label>
        }
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {view?.activeOverlay.map((x) => (
              <Card key={x.streamId}>
                <Label>
                  {x.kind === "thinking"
                    ? "思考中"
                    : x.kind === "toolOutput"
                      ? "工具输出"
                      : "Pico 正在回复"}
                </Label>
                <Text selectable style={s.text}>
                  {x.text}
                </Text>
              </Card>
            ))}
            {plan && <PlanCard plan={plan} sessionId={sessionId} />}{" "}
            {!!view?.queuedInputs.length && <Label>队列中 {view.queuedInputs.length} 条输入</Label>}
          </View>
        }
      />
      <View style={[s.body, { borderTopWidth: 1, borderTopColor: color.line }]}>
        {uncertain && (
          <Card>
            <Text style={s.text}>结果未确认，已重新同步会话。确认消息是否已出现。</Text>
            <Button
              title="使用原幂等键重试"
              secondary
              reason={!pico.connected ? "正在恢复连接" : undefined}
              onPress={() => void send()}
            />
            <Button
              title="已确认，清除草稿"
              secondary
              onPress={() => {
                setText("");
                setImages([]);
                setUncertain(false);
                setFrozen(false);
                setKey(Crypto.randomUUID());
              }}
            />
          </Card>
        )}
        {!!images.length && (
          <View style={s.row}>
            {images.map((x, i) => (
              <Pressable
                key={i}
                onPress={() => {
                  if (!frozen) setImages(images.filter((_, j) => i !== j));
                }}
              >
                <Image
                  source={{ uri: `data:${x.mimeType};base64,${x.data}` }}
                  style={{ width: 58, height: 58, borderRadius: 9 }}
                />
                <Label>{Math.ceil(decodedBase64Size(x.data) / 1024)} KiB · 移除</Label>
              </Pressable>
            ))}
          </View>
        )}
        {frozen ? (
          <Label>待确认请求的输入已锁定，重试将使用相同内容。</Label>
        ) : (
          <Field
            label="消息"
            value={text}
            onChange={setText}
            multiline
            placeholder="让 Pico 帮你处理电脑上的任务"
          />
        )}
        <Chips
          values={["auto", "steer", "queue", "replace"] as const}
          value={mode}
          onChange={(x) => {
            if (!frozen) setMode(x);
          }}
        />
        <View style={s.row}>
          <Button
            title="相册"
            secondary
            reason={frozen ? "先确认待处理请求" : undefined}
            onPress={() => void addImage()}
          />
          <Button
            title="拍照"
            secondary
            reason={frozen ? "先确认待处理请求" : undefined}
            onPress={() => void addImage(true)}
          />
          <Button
            title={sending ? "发送中…" : "发送"}
            reason={
              sending
                ? "正在发送"
                : !text.trim() && !images.length
                  ? "请输入消息"
                  : view?.phase !== "ready"
                    ? "正在补齐会话"
                    : pico.reason("session.send")
            }
            onPress={() => void send()}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
function TranscriptItem({ item, sessionId }: { item: RuntimeConversationItem; sessionId: string }) {
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
          : item.kind;
  const content =
    "content" in item
      ? String(item.content)
      : "detail" in item
        ? String(item.detail ?? "")
        : "summary" in item
          ? String(item.summary ?? "")
          : "";
  const waiting = (item.kind === "approval" || item.kind === "prompt") && item.state === "waiting";
  return (
    <Card>
      <Pressable onPress={() => setExpanded(!expanded)}>
        <View style={s.row}>
          <Text
            style={{
              color: item.kind === "userMessage" ? color.accent : color.muted,
              fontWeight: "700",
            }}
          >
            {label}
          </Text>
          {"title" in item && <Text style={s.text}>{String(item.title)}</Text>}
          {"status" in item && <Label>{String(item.status)}</Label>}
        </View>
      </Pressable>
      <Text
        selectable
        numberOfLines={["thinking", "tool"].includes(item.kind) && !expanded ? 4 : undefined}
        style={s.text}
      >
        {content}
      </Text>
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
      {waiting && item.kind === "approval" && (
        <View style={s.row}>
          {(["allow_once", "allow_session", "deny"] as const).map((decision, i) => (
            <Button
              key={decision}
              title={["允许一次", "本会话允许", "拒绝"][i]!}
              reason={pico.reason("approval.respond")}
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
          <Field label="回答" value={answer} onChange={setAnswer} />
          <View style={s.row}>
            <Button
              title="提交回答"
              reason={pico.reason("prompt.respond")}
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
              reason={pico.reason("prompt.cancel")}
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
      {expanded && <Detail value={item} />}
    </Card>
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
function PlanCard({ plan, sessionId }: { plan: RuntimePlanControlSnapshot; sessionId: string }) {
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
    <Card>
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
          <Field label="反馈（可选）" value={feedback} onChange={setFeedback} />
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
                  plan.availability !== "ready" ? "计划控制暂不可用" : pico.reason("plan.respond")
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
