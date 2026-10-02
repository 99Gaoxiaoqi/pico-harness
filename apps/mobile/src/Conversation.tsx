import React, { useRef, useState } from "react";
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
  type ViewToken,
} from "react-native";
import * as Crypto from "expo-crypto";
import { usePico } from "./store";
import { decodedBase64Size } from "./core";
import { Button, Card, Label, s, color } from "./ui";
import { ActionsSheet } from "./ActionsSheet";
import type { WorkbarTab } from "./Workbar";
import { useSessionTranscript } from "./conversation/useSessionTranscript";
import { useMessageComposer } from "./conversation/useMessageComposer";
import { TranscriptItem, StreamingItem, PlanCard } from "./conversation/TranscriptItem";

const sendModes = [
  { value: "auto", label: "自动", detail: "空闲时开始新任务；运行中补充引导。" },
  { value: "steer", label: "引导", detail: "为运行中的任务补充要求；空闲时开始新任务。" },
  { value: "queue", label: "排队", detail: "有任务运行时，等当前任务结束后处理。" },
  { value: "replace", label: "替换", detail: "有任务运行时，停止当前任务并排队处理这条消息。" },
] as const;

export function Conversation({
  sessionId,
  keyboardOffset,
  onSession,
  onPanel,
  sideParentSessionId,
}: {
  sessionId: string;
  keyboardOffset: number;
  onSession: (id: string, parentSessionId?: string) => void;
  sideParentSessionId?: string;
  onPanel: (tab?: WorkbarTab) => void;
}) {
  const pico = usePico();
  const { view, sessionReady, settings, plan, loadOlder, refreshTranscript } =
    useSessionTranscript(sessionId);
  const {
    text,
    setText,
    sending,
    pickingImage,
    images,
    mode,
    setMode,
    uncertain,
    frozen,
    addImage,
    send,
    clearDraft,
    removeImage,
    captureSelection,
  } = useMessageComposer({
    sessionId,
    sessionReady,
    activeRun: view?.activeRun,
    refreshTranscript,
    onSession,
  });
  const [visibleItems, setVisibleItems] = useState(new Set<string>());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    setVisibleItems(new Set(viewableItems.map((token) => token.key)));
  }).current;
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
  const syncReason = sessionReady ? undefined : "正在补齐会话";
  const run = view?.activeRun;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={keyboardOffset}
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
        extraData={visibleItems}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
        contentContainerStyle={[s.body, { gap: 0, paddingTop: 10, paddingBottom: 24 }]}
        ListHeaderComponent={
          view?.olderCursor ? (
            <Button title="加载更早记录" quiet onPress={() => void pico.perform(loadOlder)} />
          ) : null
        }
        renderItem={({ item }) => (
          <TranscriptItem
            item={item.item}
            sessionId={sessionId}
            syncReason={syncReason}
            visible={visibleItems.has(item.itemId)}
          />
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
            <Button title="已确认，清除草稿" secondary onPress={clearDraft} />
          </Card>
        )}
        {!!images.length && (
          <View style={s.row}>
            {images.map((x, i) => (
              <Pressable key={i} onPress={() => removeImage(i)}>
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
                  const current = captureSelection();
                  const x = await pico.request("sideChat.create", {
                    sourceSessionId: sessionId,
                    panelId: Crypto.randomUUID(),
                    idempotencyKey: Crypto.randomUUID(),
                  });
                  if (current()) onSession(x.session.sessionId, sessionId);
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
                    const current = captureSelection();
                    await pico.request("sideChat.close", { sessionId });
                    if (current()) onSession(sideParentSessionId);
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
});
