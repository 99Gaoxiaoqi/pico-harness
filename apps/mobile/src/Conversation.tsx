import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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
import type { RemoteParams } from "@pico/protocol/remote";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { MobileTranscript } from "./transcript";
import { usePico } from "./store";
import { decodedBase64Size, validateAttachments } from "./core";
import { Button, Card, Detail, Field, Label, s, color } from "./ui";
import { ActionsSheet } from "./ActionsSheet";
import type { WorkbarTab } from "./Workbar";

const sendModes = [
  { value: "auto", label: "自动", detail: "空闲时开始新任务；运行中补充引导。" },
  { value: "steer", label: "引导", detail: "为运行中的任务补充要求；空闲时开始新任务。" },
  { value: "queue", label: "排队", detail: "有任务运行时，等当前任务结束后处理。" },
  { value: "replace", label: "替换", detail: "有任务运行时，停止当前任务并排队处理这条消息。" },
] as const;

export function Conversation({
  sessionId,
  onSession,
  onPanel,
  sideParentSessionId,
}: {
  sessionId: string;
  onSession: (id: string, parentSessionId?: string) => void;
  sideParentSessionId?: string;
  onPanel: (tab?: WorkbarTab) => void;
}) {
  const pico = usePico();
  const [view, setView] = useState<TranscriptReplicaView>();
  const [sessionReady, setSessionReady] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sheet, setSheet] = useState<"more" | "images" | "mode" | "run">();
  function openSheet(value: NonNullable<typeof sheet>) {
    Keyboard.dismiss();
    setSheet(value);
  }
  function openPanel(tab?: WorkbarTab) {
    Keyboard.dismiss();
    setSheet(undefined);
    onPanel(tab);
  }
  const picking = useRef(false);
  const [pickingImage, setPickingImage] = useState(false);
  const [images, setImages] = useState<RuntimeInputAttachment[]>([]);
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [mode, setMode] = useState<"auto" | "steer" | "queue" | "replace">("auto");
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const [uncertain, setUncertain] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [plan, setPlan] = useState<RuntimePlanControlSnapshot>();
  const controller = useRef<MobileTranscript | undefined>(undefined);
  const pendingSend = useRef<RemoteParams<"session.send"> | undefined>(undefined);
  const selection = useRef("");
  selection.current = `${pico.host?.id}/${pico.workspace?.id}/${sessionId}`;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSessionReady(false);
    if (!pico.workspace || !pico.connected) return;
    let subscribed = true;
    const subscription = new MobileTranscript(pico, pico.workspace.id, sessionId, (v) => {
      setView(v);
      setPlan(subscription.planControl);
    });
    controller.current = subscription;
    const off = pico.onFrame((frame) => void subscription.receive(frame).catch(pico.report));
    const offNotifications = pico.onNotification((event) => {
      if (event.scope.sessionId !== sessionId) return;
      if (event.topic === "plan.updated") void subscription.open().catch(pico.report);
      if (event.topic === "session.settingsUpdated")
        void pico
          .request("session.settings.get", { sessionId })
          .then((x) => setSettings(x.settings))
          .catch(pico.report);
    });
    void subscription
      .open()
      .then(() => {
        if (subscribed) setSessionReady(true);
      })
      .catch(pico.report);
    void pico
      .request("session.settings.get", { sessionId })
      .then((x) => setSettings(x.settings))
      .catch(pico.report);
    return () => {
      subscribed = false;
      off();
      offNotifications();
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
    setSending(false);
    pendingSend.current = undefined;
  }, [sessionId, pico.host?.id, pico.workspace?.id]);
  async function addImage(camera = false) {
    const selectedContext = selection.current;
    if (picking.current || sending || frozen) return;
    picking.current = true;
    setPickingImage(true);
    try {
      if (images.length >= 4) throw new Error("最多选择 4 张图片");
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error("需要相机权限");
      }
      const selected = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
      if (selected.canceled || !mounted.current || selection.current !== selectedContext) return;
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
      if (mounted.current && selection.current === selectedContext) setImages([...images, image]);
    } catch (error) {
      if (mounted.current && selection.current === selectedContext) pico.report(error);
    } finally {
      picking.current = false;
      if (mounted.current) setPickingImage(false);
    }
  }
  async function send() {
    if (sending || picking.current || !sessionReady || !pico.connected) return;
    const selectedContext = selection.current;
    const current = () => mounted.current && selection.current === selectedContext;
    setSending(true);
    try {
      if (!pendingSend.current) {
        validateAttachments(images);
        pendingSend.current = {
          sessionId,
          input: { kind: "text", text, ...(images.length ? { attachments: [...images] } : {}) },
          behavior: mode,
          idempotencyKey: key,
          ...(view?.activeRun ? { expectedRunId: view.activeRun.runId } : {}),
        };
      }
      const result = await pico.request("session.send", pendingSend.current);
      if (!current()) return;
      pendingSend.current = undefined;
      setText("");
      setImages([]);
      setKey(Crypto.randomUUID());
      setUncertain(false);
      setFrozen(false);
      onSession(result.session.sessionId);
    } catch (error) {
      if (!current()) return;
      const notExecuted =
        error instanceof Error && "outcome" in error && error.outcome === "not_executed";
      if (notExecuted) {
        pendingSend.current = undefined;
        setUncertain(false);
        setFrozen(false);
        setKey(Crypto.randomUUID());
      } else {
        setUncertain(true);
        setFrozen(true);
      }
      pico.report(error);
      await controller.current?.open().catch(pico.report);
    } finally {
      if (current()) setSending(false);
    }
  }
  const syncReason = sessionReady ? undefined : "正在补齐会话";
  const run = view?.activeRun;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="会话设置"
          onPress={() => openPanel("设置")}
          style={styles.modelTarget}
        >
          <Text numberOfLines={1} style={s.muted}>
            {settings?.model ?? "会话设置"}
          </Text>
        </Pressable>
        {run && (
          <Button
            title={
              run.status === "paused"
                ? "任务已暂停"
                : run.status === "pause_requested"
                  ? "正在暂停"
                  : run.status === "cancelling"
                    ? "正在停止"
                    : "任务运行中"
            }
            quiet
            onPress={() => openSheet("run")}
          />
        )}
        <Button title="更多" quiet onPress={() => openSheet("more")} />
      </View>
      <FlatList
        data={view?.records ?? []}
        keyExtractor={(x) => x.itemId}
        contentContainerStyle={[s.body, { gap: 0, paddingTop: 10, paddingBottom: 24 }]}
        ListHeaderComponent={
          view?.olderCursor ? (
            <Button
              title="加载更早记录"
              quiet
              onPress={() => void pico.perform(() => controller.current!.older())}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <TranscriptItem item={item.item} sessionId={sessionId} syncReason={syncReason} />
        )}
        ListEmptyComponent={
          <Label>{pico.connected ? "正在读取历史…" : "连接恢复后会补齐记录"}</Label>
        }
        ListFooterComponent={
          <View style={{ gap: 10 }}>
            {view?.activeOverlay.map((x) => (
              <StreamingItem key={x.streamId} kind={x.kind} text={x.text} />
            ))}
            {plan && <PlanCard plan={plan} sessionId={sessionId} syncReason={syncReason} />}
            {!!view?.queuedInputs.length && <Label>队列中 {view.queuedInputs.length} 条输入</Label>}
          </View>
        }
      />
      <View style={[s.body, styles.composer]}>
        {uncertain && (
          <Card>
            <Text style={s.text}>结果未确认，已重新同步会话。确认消息是否已出现。</Text>
            <Button
              title="使用原幂等键重试"
              secondary
              reason={syncReason ?? pico.reason("session.send")}
              onPress={() => void send()}
            />
            <Button
              title="已确认，清除草稿"
              secondary
              onPress={() => {
                pendingSend.current = undefined;
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
                  if (!frozen && !sending && !picking.current)
                    setImages(images.filter((_, j) => i !== j));
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
          <TextInput
            accessibilityLabel="消息"
            editable={!sending}
            value={text}
            onChangeText={setText}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="让 Pico 帮你处理电脑上的任务"
            placeholderTextColor={color.muted}
            style={styles.messageInput}
          />
        )}
        <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
          <View style={s.row}>
            <Button
              title={pickingImage ? "处理中…" : "添加图片"}
              quiet
              reasonDetail={false}
              reason={
                frozen
                  ? "先确认待处理请求"
                  : pickingImage
                    ? "正在处理图片"
                    : sending
                      ? "正在发送"
                      : undefined
              }
              onPress={() => openSheet("images")}
            />
            <Button
              title={sendModes.find((x) => x.value === mode)!.label}
              quiet
              reasonDetail={false}
              reason={frozen ? "先确认待处理请求" : sending ? "正在发送" : undefined}
              onPress={() => openSheet("mode")}
            />
          </View>
          <Button
            title={sending ? "发送中…" : "发送"}
            reason={
              sending
                ? "正在发送"
                : pickingImage
                  ? "正在处理图片"
                  : !text.trim() && !images.length
                    ? "请输入消息"
                    : !sessionReady || view?.phase !== "ready"
                      ? "正在补齐会话"
                      : pico.reason("session.send")
            }
            onPress={() => void send()}
          />
        </View>
      </View>
      <ActionsSheet title="会话操作" open={sheet === "more"} onClose={() => setSheet(undefined)}>
        <View style={{ gap: 10 }}>
          <View style={s.row}>
            <Button title="工作栏" quiet onPress={() => openPanel()} />
            <Button
              title="侧聊"
              quiet
              reason={syncReason ?? pico.reason("sideChat.create")}
              onPress={() =>
                void pico.perform(async () => {
                  const selectedContext = selection.current;
                  const x = await pico.request("sideChat.create", {
                    sourceSessionId: sessionId,
                    panelId: Crypto.randomUUID(),
                    idempotencyKey: Crypto.randomUUID(),
                  });
                  if (mounted.current && selectedContext === selection.current)
                    onSession(x.session.sessionId, sessionId);
                })
              }
            />
            {sideParentSessionId && (
              <Button
                title="关闭侧聊"
                quiet
                reason={syncReason ?? pico.reason("sideChat.close")}
                onPress={() =>
                  void pico.perform(async () => {
                    const selectedContext = selection.current;
                    await pico.request("sideChat.close", { sessionId });
                    if (mounted.current && selectedContext === selection.current)
                      onSession(sideParentSessionId);
                  })
                }
              />
            )}
            {run && <Label>{run.status}</Label>}
          </View>
          {settings && (
            <View style={[s.row, { flexWrap: "nowrap" }]}>
              <Text numberOfLines={1} style={[s.muted, { flex: 1 }]}>
                {settings.model} · {settings.collaborationMode} · {settings.permissionMode}
              </Text>
              <Button title="会话设置" quiet onPress={() => openPanel("设置")} />
            </View>
          )}
        </View>
      </ActionsSheet>
      <ActionsSheet title="当前任务" open={sheet === "run"} onClose={() => setSheet(undefined)}>
        {run ? (
          <>
            <Text style={s.text}>{run.description}</Text>
            <Label>任务由电脑执行。关闭面板或离开手机不会停止任务。</Label>
            {run && (
              <View style={s.row}>
                <Button
                  title="暂停"
                  quiet
                  reason={
                    syncReason ??
                    (run.status !== "running" ? "当前任务不能暂停" : pico.reason("run.pause"))
                  }
                  onPress={() =>
                    void pico.perform(() => pico.request("run.pause", { runId: run.runId }))
                  }
                />
                <Button
                  title="继续"
                  quiet
                  reason={
                    syncReason ??
                    (run.status !== "paused" ? "当前任务没有暂停" : pico.reason("run.resume"))
                  }
                  onPress={() =>
                    void pico.perform(() => pico.request("run.resume", { runId: run.runId }))
                  }
                />
                <Button
                  title="停止"
                  quiet
                  reason={syncReason ?? pico.reason("run.cancel")}
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
          </>
        ) : (
          <Label>当前任务已结束。</Label>
        )}
      </ActionsSheet>
      <ActionsSheet title="添加图片" open={sheet === "images"} onClose={() => setSheet(undefined)}>
        <Label>已选 {images.length}/4 张；图片会压缩到本次附件预算内。</Label>
        <Button
          title="从相册选择"
          secondary
          reason={pickingImage ? "正在处理图片" : undefined}
          onPress={() => void addImage().finally(() => setSheet(undefined))}
        />
        <Button
          title="拍照"
          secondary
          reason={pickingImage ? "正在处理图片" : undefined}
          onPress={() => void addImage(true).finally(() => setSheet(undefined))}
        />
      </ActionsSheet>
      <ActionsSheet title="发送方式" open={sheet === "mode"} onClose={() => setSheet(undefined)}>
        <Label>电脑有任务运行时，选择这条消息如何参与执行。</Label>
        {sendModes.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === option.value, disabled: frozen || sending }}
            disabled={frozen || sending}
            onPress={() => {
              setMode(option.value);
              setSheet(undefined);
            }}
            style={[styles.modeOption, mode === option.value && styles.modeSelected]}
          >
            <Text style={[s.text, mode === option.value && { color: color.accent }]}>
              {option.label}
              {mode === option.value ? " · 已选择" : ""}
            </Text>
            <Label>{option.detail}</Label>
          </Pressable>
        ))}
      </ActionsSheet>
    </KeyboardAvoidingView>
  );
}
function StreamingItem({ kind, text }: { kind: string; text: string }) {
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
      {(!process || expanded) && (
        <Text selectable style={process ? s.muted : s.text}>
          {text}
        </Text>
      )}
    </View>
  );
}
function TranscriptItem({
  item,
  sessionId,
  syncReason,
}: {
  item: RuntimeConversationItem;
  sessionId: string;
  syncReason?: string;
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
    return (
      <View style={item.kind === "userMessage" ? styles.userMessage : styles.assistantMessage}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`查看${label}的消息详情`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={item.kind === "userMessage" ? styles.userBubble : undefined}
        >
          <Text selectable style={s.text}>
            {content}
          </Text>
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
function PlanCard({
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
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  modelTarget: { minHeight: 44, flex: 1, justifyContent: "center" },
  modeOption: {
    minHeight: 64,
    padding: 12,
    gap: 4,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: color.line,
  },
  modeSelected: { backgroundColor: color.accentSoft, borderColor: color.accent },
  composer: {
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 10,
    gap: 7,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 22,
    shadowColor: "#000000",
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 10,
    elevation: 2,
  },
  messageInput: {
    color: color.text,
    fontSize: 15,
    lineHeight: 23,
    minHeight: 54,
    paddingHorizontal: 4,
    paddingVertical: 6,
    textAlignVertical: "top",
  },
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
