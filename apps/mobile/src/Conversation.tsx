import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { isTerminalRunStatus } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { decodedBase64Size } from "./core";
import { Button, Card, Detail, Label, s, color } from "./ui";
import { ActionsSheet } from "./ActionsSheet";
import type { WorkbarTab } from "./Workbar";
import { useSessionTranscript } from "./conversation/useSessionTranscript";
import { useMessageComposer } from "./conversation/useMessageComposer";
import { useTranscriptViewport } from "./conversation/useTranscriptViewport";
import { transcriptRows, type TranscriptRow } from "./conversation/transcriptRows";
import { ComposerOptions, ComposerReferences } from "./conversation/ComposerOptions";
import { SessionActions } from "./conversation/SessionActions";
import {
  TranscriptItem,
  ProcessGroup,
  StreamingItem,
  PlanCard,
} from "./conversation/TranscriptItem";

export function Conversation({
  active,
  sessionId,
  keyboardOffset,
  onSession,
  onPanel,
  sideParentSessionId,
  parentIsSideChat = true,
}: {
  active: boolean;
  sessionId: string;
  keyboardOffset: number;
  onSession: (id: string, parentSessionId?: string, kind?: "sideChat" | "child") => void;
  sideParentSessionId?: string;
  parentIsSideChat?: boolean;
  onPanel: (tab?: WorkbarTab) => void;
}) {
  const pico = usePico();
  const { view, sessionReady, restoreVersion, settings, plan, loadOlder, refreshTranscript } =
    useSessionTranscript(sessionId);
  // The shared replica retains the last Run, including its terminal state.
  const run =
    view?.activeRun && !isTerminalRunStatus(view.activeRun.status) ? view.activeRun : undefined;
  const composer = useMessageComposer({
    sessionId,
    sessionReady,
    activeRun: run,
    refreshTranscript,
    onSession,
  });
  const {
    text,
    setText,
    sending,
    images,
    uncertain,
    frozen,
    send,
    clearDraft,
    removeImage,
    captureSelection,
  } = composer;
  const presentation = useRef<{ history: string; rows: TranscriptRow[] }>({
    history: "",
    rows: [],
  });
  const history = `${view?.watermark?.historyEpoch}/${view?.watermark?.projectorVersion}`;
  const rows = transcriptRows(
    view?.records ?? [],
    presentation.current.history === history ? presentation.current.rows : [],
  );
  presentation.current = { history, rows };
  const [visibleItems, setVisibleItems] = useState(new Set<string>());
  const viewport = useTranscriptViewport(view, sessionReady, active, restoreVersion, rows);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    viewport.onViewableItemsChanged(viewableItems);
    setVisibleItems(
      new Set(
        viewableItems.flatMap(
          (token) =>
            presentation.current.rows
              .find((row) => row.key === token.key)
              ?.records.map((record) => record.itemId) ?? [],
        ),
      ),
    );
  }).current;
  const [sheet, setSheet] = useState<"run">();
  useEffect(() => {
    if (!active) {
      setSheet(undefined);
      Keyboard.dismiss();
    }
  }, [active]);
  function openSheet(value: NonNullable<typeof sheet>) {
    if (!active) return;
    Keyboard.dismiss();
    setSheet(value);
  }
  function openPanel(tab?: WorkbarTab) {
    if (!active) return;
    Keyboard.dismiss();
    setSheet(undefined);
    onPanel(tab);
  }
  const syncReason = sessionReady ? undefined : "正在补齐会话";
  const sendReason = composer.sendReason ?? syncReason ?? pico.reason("session.send");
  const showSendHelp = Boolean(
    text.trim() ||
    images.length ||
    composer.selectedSkills.length ||
    composer.selectedAgent ||
    composer.optionsReason ||
    syncReason ||
    pico.reason("session.send"),
  );
  const modelSummary = settings
    ? `${settings.model} · ${settings.collaborationMode === "agent" ? "普通" : settings.collaborationMode === "plan" ? "计划" : "研究"} · ${settings.thinkingEffort}`
    : "读取会话设置…";
  const pendingItem = view?.records.find(
    (record) =>
      ((record.item.kind === "approval" && record.item.data.kind !== "plan") ||
        record.item.kind === "prompt") &&
      record.item.state === "waiting",
  );
  const pendingPlan = plan?.state === "pending_review";
  // Keep hooks/drafts alive, but remove native focus targets and stale cell hit regions.
  if (!active) return null;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={keyboardOffset}
    >
      {sideParentSessionId && (
        <View style={{ paddingHorizontal: 16 }}>
          <Button title="返回父会话" quiet onPress={() => onSession(sideParentSessionId)} />
        </View>
      )}
      <FlatList
        ref={viewport.listRef}
        CellRendererComponent={viewport.Cell}
        onLayout={viewport.onLayout}
        onScroll={viewport.onScroll}
        onScrollBeginDrag={viewport.onScrollBeginDrag}
        onScrollEndDrag={viewport.onScrollEndDrag}
        onMomentumScrollBegin={viewport.onMomentumScrollBegin}
        onMomentumScrollEnd={viewport.onMomentumScrollEnd}
        onScrollToIndexFailed={viewport.onScrollToIndexFailed}
        onContentSizeChange={viewport.onContentSizeChange}
        scrollEventThrottle={32}
        data={rows}
        keyExtractor={(x) => x.key}
        extraData={visibleItems}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
        contentContainerStyle={[s.body, { gap: 0, paddingTop: 10, paddingBottom: 24 }]}
        ListHeaderComponent={
          view?.olderCursor ? (
            <Button
              title="加载更早记录"
              quiet
              onPress={() => void pico.perform(() => viewport.loadOlder(loadOlder))}
            />
          ) : null
        }
        renderItem={({ item }) =>
          item.records.length > 1 ? (
            <ProcessGroup
              records={item.records}
              sessionId={sessionId}
              syncReason={syncReason}
              onResize={viewport.beforeRowResize}
            />
          ) : (
            <TranscriptItem
              item={item.records[0]!.item}
              sessionId={sessionId}
              syncReason={syncReason}
              visible={visibleItems.has(item.records[0]!.itemId)}
              onReview={() => openPanel("审查")}
              onResize={viewport.beforeRowResize}
              onOpenChild={(childId, childWorkspace) =>
                void pico.perform(async () => {
                  const current = captureSelection();
                  const [parent, child] = await Promise.all([
                    pico.request("session.get", { sessionId }),
                    pico.request("session.get", { sessionId: childId }),
                  ]);
                  if (!current()) return;
                  if (
                    parent.session.workspacePath !== child.session.workspacePath ||
                    childWorkspace !== child.session.workspacePath ||
                    child.session.parentSession?.sessionId !== sessionId ||
                    child.session.parentSession.workspacePath !== parent.session.workspacePath
                  ) {
                    Alert.alert("请在电脑查看", "当前记录不是同一授权项目内的明确子会话。");
                    return;
                  }
                  onSession(childId, sessionId, "child");
                })
              }
            />
          )
        }
        ListEmptyComponent={
          <Label>
            {!pico.connected
              ? "连接恢复后会补齐记录"
              : sessionReady && view?.phase === "ready"
                ? "有什么需要 Pico 帮你处理？"
                : view?.phase === "recovering" || view?.phase === "idle"
                  ? "历史尚未同步，请重新连接后重试"
                  : "正在读取历史…"}
          </Label>
        }
        ListFooterComponent={
          <View style={{ gap: 10 }}>
            {view?.activeOverlay.map((x) => (
              <StreamingItem
                key={x.streamId}
                kind={x.kind}
                text={x.text}
                onResize={viewport.beforeRowResize}
              />
            ))}
            {plan && <PlanCard plan={plan} sessionId={sessionId} syncReason={syncReason} />}
            {!!view?.queuedInputs.length && <Label>队列中 {view.queuedInputs.length} 条输入</Label>}
          </View>
        }
      />
      {viewport.showLatest && (
        <View style={{ alignItems: "center" }}>
          <Button title="回到最新 ↓" quiet onPress={viewport.jumpToLatest} />
        </View>
      )}
      {(run || pendingItem || pendingPlan) && (
        <View style={styles.runStrip}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              pendingItem
                ? pendingItem.item.kind === "approval"
                  ? "查看待批准请求"
                  : "查看待回答问题"
                : pendingPlan
                  ? "查看待审计划"
                  : "查看当前任务进度"
            }
            accessibilityState={{ disabled: !!syncReason }}
            accessibilityHint={syncReason}
            disabled={!!syncReason}
            style={{ flex: 1, minHeight: 44, justifyContent: "center" }}
            onPress={() =>
              pendingItem
                ? viewport.jumpToItem(pendingItem.itemId)
                : pendingPlan
                  ? viewport.jumpToLatest()
                  : openSheet("run")
            }
          >
            <Text numberOfLines={1} style={s.muted}>
              {pendingItem
                ? pendingItem.item.kind === "approval"
                  ? "需要批准 · 查看请求"
                  : "需要回答 · 查看问题"
                : pendingPlan
                  ? "计划待审 · 查看计划"
                  : `${
                      run?.status === "paused"
                        ? "任务已暂停"
                        : run?.status === "pause_requested"
                          ? "正在暂停"
                          : run?.status === "cancelling"
                            ? "正在停止"
                            : run?.status === "queued"
                              ? "任务已排队"
                              : "正在执行"
                    } · 查看进度`}
            </Text>
            {!!run?.description && !pendingItem && !pendingPlan && (
              <Text numberOfLines={1} style={s.text}>
                {run.description}
              </Text>
            )}
          </Pressable>
          {run && (
            <Button
              title={run.status === "paused" ? "继续" : "停止"}
              quiet
              reason={
                syncReason ?? pico.reason(run.status === "paused" ? "run.resume" : "run.cancel")
              }
              onPress={() =>
                run.status === "paused"
                  ? void pico.perform(() => pico.request("run.resume", { runId: run.runId }))
                  : Alert.alert("停止当前任务？", run.description, [
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
          )}
        </View>
      )}
      <View style={styles.composer}>
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
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={`移除图片 ${i + 1}`}
                accessibilityState={{ disabled: frozen || sending }}
                disabled={frozen || sending}
                style={{ minHeight: 44 }}
                onPress={() => removeImage(i)}
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
        <ComposerReferences composer={composer} active={active} />
        {frozen && <Label>待确认请求的输入已锁定，重试将使用相同内容。</Label>}
        <View style={styles.inputRow}>
          <ComposerOptions
            composer={composer}
            active={active}
            modelSummary={modelSummary}
            onSettings={() => openPanel("设置")}
            transcriptDetails={
              <View style={{ gap: 6 }}>
                <Label>以下为已加载的记录。更早的记录可先在会话中加载。</Label>
                {view?.records.map((record) => (
                  <Detail
                    key={record.itemId}
                    title={
                      record.item.kind === "userMessage"
                        ? "你的消息"
                        : record.item.kind === "assistantMessage"
                          ? "Pico 的回复"
                          : "title" in record.item
                            ? String(record.item.title)
                            : record.item.kind
                    }
                    value={record.item}
                  />
                ))}
              </View>
            }
            sessionMenu={(closeMenu) => (
              <View style={{ gap: 10 }}>
                <SessionActions
                  sessionId={sessionId}
                  idle={sessionReady && !run}
                  onSession={onSession}
                  onClose={closeMenu}
                />
                <Button
                  title="研究报告"
                  quiet
                  reason={pico.reason("session.research.query")}
                  onPress={() => openPanel("研究")}
                />
                <View style={s.row}>
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
                  {sideParentSessionId && parentIsSideChat && (
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
            )}
          />
          {frozen ? (
            <Text style={styles.messageInput}>等待确认…</Text>
          ) : (
            <TextInput
              accessibilityLabel="消息"
              editable={composer.draftReady && !sending && !composer.pickingImage}
              value={text}
              onChangeText={setText}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
              placeholder="发消息…"
              placeholderTextColor={color.muted}
              style={styles.messageInput}
            />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? "发送中" : "发送消息"}
            accessibilityState={{ disabled: !!sendReason, busy: sending }}
            accessibilityHint={sendReason}
            disabled={!!sendReason}
            style={({ pressed }) => [
              styles.sendTarget,
              { opacity: sendReason ? 0.5 : pressed ? 0.75 : 1 },
            ]}
            onPress={() => void send()}
          >
            {sending ? (
              <ActivityIndicator color={color.bg} />
            ) : (
              <Text style={styles.sendIcon}>↑</Text>
            )}
          </Pressable>
        </View>
        {composer.sendReason && !uncertain && showSendHelp && <Label>{composer.sendReason}</Label>}
      </View>
      <ActionsSheet
        title="当前任务"
        open={active && sheet === "run"}
        onClose={() => setSheet(undefined)}
      >
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
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  runStrip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    backgroundColor: color.panel,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    padding: 6,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 28,
  },
  sendTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderRadius: 22,
  },
  sendIcon: { color: color.bg, fontSize: 24, lineHeight: 30 },
  composer: {
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 8,
  },
  messageInput: {
    flex: 1,
    color: color.text,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 44,
    maxHeight: 160,
    paddingHorizontal: 4,
    paddingVertical: 10,
    textAlignVertical: "top",
  },
});
