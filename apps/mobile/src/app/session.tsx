import type { MobileRun, MobileTranscript } from "@pico/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MobileGatewayClient, type MobileGatewayConnection } from "../lib/mobile-gateway-client";
import {
  applyMobileLiveEvent,
  mergeMobileConversationItems,
  reconcileMobileLiveItems,
  type MobileLiveConversationItem,
  type MobileRenderedConversationItem,
} from "../lib/mobile-live-transcript";
import {
  MobileGatewayRealtimeClient,
  type MobileRealtimeState,
} from "../lib/mobile-gateway-realtime";
import { mobileTheme } from "../lib/mobile-theme";

const GATEWAY_ORIGIN_KEY = "pico.mobile.gatewayOrigin";
const GATEWAY_TOKEN_KEY = "pico.mobile.gatewayToken";

export default function SessionScreen() {
  const params = useLocalSearchParams<{
    projectId?: string;
    sessionId?: string;
    title?: string;
  }>();
  const projectId = singleParam(params.projectId);
  const sessionId = singleParam(params.sessionId);
  const title = singleParam(params.title) ?? "会话";
  const [transcript, setTranscript] = useState<MobileTranscript>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState<MobileGatewayConnection>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [liveItems, setLiveItems] = useState<readonly MobileLiveConversationItem[]>([]);
  const [realtimeState, setRealtimeState] = useState<MobileRealtimeState>();
  const [realtimeError, setRealtimeError] = useState<string>();
  const transcriptRef = useRef<MobileTranscript | undefined>(undefined);
  const hydrationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const shouldFollowOutput = useRef(true);
  const pendingSend = useRef<
    { readonly text: string; readonly idempotencyKey: string } | undefined
  >(undefined);

  const load = useCallback(async () => {
    if (!projectId || !sessionId) {
      setError("会话链接缺少必要参数");
      setLoading(false);
      return;
    }
    try {
      const [origin, token] = await Promise.all([
        SecureStore.getItemAsync(GATEWAY_ORIGIN_KEY),
        SecureStore.getItemAsync(GATEWAY_TOKEN_KEY),
      ]);
      if (!origin || !token) throw new Error("请先返回项目页连接 Desktop Gateway");
      const nextConnection = { origin, token };
      setConnection((current) =>
        current?.origin === origin && current.token === token ? current : nextConnection,
      );
      const nextTranscript = await new MobileGatewayClient(nextConnection).getTranscript(
        projectId,
        sessionId,
      );
      transcriptRef.current = nextTranscript;
      setTranscript(nextTranscript);
      setLiveItems((current) => reconcileMobileLiveItems(nextTranscript.items, current));
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "会话记录读取失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleHydration = useCallback(() => {
    if (hydrationTimer.current) clearTimeout(hydrationTimer.current);
    hydrationTimer.current = setTimeout(() => void load(), 120);
  }, [load]);

  useEffect(() => {
    if (!connection || !projectId || !sessionId) return;
    const subscription = new MobileGatewayRealtimeClient(connection).subscribe(
      projectId,
      sessionId,
      {
        onEvent(event) {
          switch (event.type) {
            case "ready":
              void load();
              break;
            case "live":
              setLiveItems((current) =>
                applyMobileLiveEvent(current, event, transcriptRef.current?.items ?? []),
              );
              break;
            case "run":
              setTranscript((current) =>
                current ? applyRealtimeRun(current, event.run) : current,
              );
              if (!isActiveRun(event.run)) scheduleHydration();
              break;
            case "transcriptUpdated":
              scheduleHydration();
              break;
            case "resync":
              void load();
              break;
          }
        },
        onStateChange(state) {
          setRealtimeState(state);
          if (state === "connected") setRealtimeError(undefined);
        },
        onError(realtimeFailure) {
          setRealtimeError(realtimeFailure.message);
        },
      },
    );
    return () => {
      subscription.dispose();
      if (hydrationTimer.current) clearTimeout(hydrationTimer.current);
    };
  }, [connection, load, projectId, scheduleHydration, sessionId]);

  const conversationItems = useMemo(
    () => mergeMobileConversationItems(transcript?.items ?? [], liveItems),
    [liveItems, transcript?.items],
  );

  useEffect(() => {
    if (!shouldFollowOutput.current) return;
    const frame = requestAnimationFrame(() =>
      scrollViewRef.current?.scrollToEnd({ animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [conversationItems]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !projectId || !sessionId || !connection || sending) return;
    const request =
      pendingSend.current?.text === text
        ? pendingSend.current
        : { text, idempotencyKey: createIdempotencyKey() };
    pendingSend.current = request;
    setSending(true);
    setSendError(undefined);
    try {
      await new MobileGatewayClient(connection).sendMessage(projectId, {
        sessionId,
        text: request.text,
        idempotencyKey: request.idempotencyKey,
      });
      pendingSend.current = undefined;
      setDraft("");
      shouldFollowOutput.current = true;
      await load();
    } catch (sendFailure) {
      setSendError(sendFailure instanceof Error ? sendFailure.message : "消息发送失败");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          headerRight: () => (
            <View accessibilityLabel={realtimeLabel(realtimeState)} style={styles.headerStatus}>
              <View style={[styles.headerStatusDot, realtimeStatusStyle(realtimeState)]} />
              <Text style={styles.headerStatusText}>实时</Text>
            </View>
          ),
          title,
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
        style={styles.screen}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => {
            if (shouldFollowOutput.current) scrollViewRef.current?.scrollToEnd({ animated: false });
          }}
          onMomentumScrollEnd={({ nativeEvent }) => {
            shouldFollowOutput.current = isNearBottom(nativeEvent);
          }}
          onScrollBeginDrag={() => {
            shouldFollowOutput.current = false;
          }}
          onScrollEndDrag={({ nativeEvent }) => {
            shouldFollowOutput.current = isNearBottom(nativeEvent);
          }}
          ref={scrollViewRef}
          refreshControl={
            <RefreshControl
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              refreshing={refreshing}
            />
          }
        >
          {transcript?.activeRun && (
            <View style={styles.runBanner}>
              <ActivityIndicator color={mobileTheme.colors.accent} size="small" />
              <Text style={styles.runText}>正在运行·{transcript.activeRun.description}</Text>
            </View>
          )}
          {connection && realtimeState === "disconnected" ? (
            <View style={styles.realtimeWarning}>
              <Text style={styles.realtimeWarningText}>
                实时更新已断开{realtimeError ? ` · ${realtimeError}` : ""}，下拉可重新同步
              </Text>
            </View>
          ) : null}
          {loading ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={mobileTheme.colors.accent} />
              <Text style={styles.mutedText}>正在读取会话…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>无法读取会话</Text>
              <Text selectable style={styles.errorText}>
                {error}
              </Text>
            </View>
          ) : conversationItems.length ? (
            conversationItems.map((item) => <TranscriptItem key={item.id} item={item} />)
          ) : (
            <View style={styles.centerState}>
              <Text style={styles.mutedText}>这个会话还没有消息</Text>
            </View>
          )}
        </ScrollView>
        <SafeAreaView edges={["bottom"]} style={styles.composerSafeArea}>
          {sendError ? <Text style={styles.sendError}>{sendError}</Text> : null}
          <View style={styles.composer}>
            <TextInput
              accessibilityLabel="消息"
              editable={!sending && Boolean(connection)}
              multiline
              onChangeText={(value) => {
                setDraft(value);
                if (pendingSend.current?.text !== value.trim()) pendingSend.current = undefined;
              }}
              placeholder={connection ? "继续这个会话…" : "连接 Gateway 后可发送"}
              style={styles.composerInput}
              value={draft}
            />
            <Pressable
              accessibilityLabel="发送消息"
              accessibilityRole="button"
              disabled={sending || !draft.trim() || !connection}
              onPress={() => void send()}
              style={({ pressed }) => [
                styles.sendButton,
                (sending || !draft.trim() || !connection) && styles.sendButtonDisabled,
                pressed && styles.sendButtonPressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={mobileTheme.colors.white} size="small" />
              ) : (
                <Text style={styles.sendButtonText}>↑</Text>
              )}
            </Pressable>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </>
  );
}

function TranscriptItem({ item }: { readonly item: MobileRenderedConversationItem }) {
  if (item.kind === "userMessage" || item.kind === "assistantMessage") {
    const user = item.kind === "userMessage";
    const streaming = "streaming" in item && item.streaming;
    return (
      <View style={[styles.messageRow, user && styles.userMessageRow]}>
        <View style={[styles.messageBubble, user ? styles.userBubble : styles.assistantBubble]}>
          <Text selectable style={[styles.messageText, user && styles.userMessageText]}>
            {item.content}
            {streaming ? <Text style={styles.streamingCursor}> ▍</Text> : null}
          </Text>
        </View>
      </View>
    );
  }
  if (item.kind === "thinking") {
    const streaming = "streaming" in item && item.streaming;
    return (
      <View style={styles.thinkingCard}>
        <Text style={styles.eventLabel}>思考</Text>
        <Text selectable style={styles.thinkingText}>
          {item.content}
          {streaming ? <Text style={styles.streamingCursor}> ▍</Text> : null}
        </Text>
      </View>
    );
  }

  const summary = summarizeItem(item);
  return (
    <View style={styles.eventCard}>
      <Text style={styles.eventLabel}>{summary.label}</Text>
      {summary.detail ? (
        <Text selectable style={styles.eventDetail}>
          {summary.detail}
        </Text>
      ) : null}
    </View>
  );
}

function summarizeItem(item: MobileRenderedConversationItem): { label: string; detail?: string } {
  switch (item.kind) {
    case "userMessage":
    case "assistantMessage":
    case "thinking":
      return { label: item.kind, detail: item.content };
    case "systemNotice":
    case "error":
      return { label: item.kind === "error" ? "错误" : "系统", detail: item.content };
    case "tool":
      return { label: `工具·${item.name}·${item.status}`, detail: item.summary ?? item.args };
    case "skill":
      return { label: `Skill·${item.name}`, detail: item.args };
    case "runBoundary":
      return { label: `Run·${item.status}`, detail: item.error };
    case "subagent":
      return { label: `子代理·${item.name ?? item.title}`, detail: item.detail };
    case "plan":
    case "approval":
    case "prompt":
    case "changes":
    case "goal":
      return { label: item.title, detail: item.detail };
  }
}

function isActiveRun(run: MobileRun): boolean {
  return (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "pause_requested" ||
    run.status === "paused" ||
    run.status === "cancelling"
  );
}

function applyRealtimeRun(transcript: MobileTranscript, run: MobileRun): MobileTranscript {
  if (isActiveRun(run)) return { ...transcript, activeRun: run };
  if (transcript.activeRun?.runId !== run.runId) return transcript;
  return {
    session: transcript.session,
    items: transcript.items,
    ...(transcript.nextBefore ? { nextBefore: transcript.nextBefore } : {}),
    revision: transcript.revision,
  };
}

function isNearBottom(event: NativeScrollEvent): boolean {
  return event.contentSize.height - event.layoutMeasurement.height - event.contentOffset.y < 80;
}

function singleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createIdempotencyKey(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function realtimeLabel(state: MobileRealtimeState | undefined): string {
  switch (state) {
    case "connected":
      return "实时更新已连接";
    case "connecting":
      return "实时更新连接中";
    case "disconnected":
      return "实时更新已断开";
    default:
      return "实时更新尚未连接";
  }
}

function realtimeStatusStyle(state: MobileRealtimeState | undefined) {
  switch (state) {
    case "connected":
      return styles.realtimeConnected;
    case "connecting":
      return styles.realtimeConnecting;
    case "disconnected":
      return styles.realtimeDisconnected;
    default:
      return styles.realtimeIdle;
  }
}

const styles = StyleSheet.create({
  screen: { backgroundColor: mobileTheme.colors.canvas, flex: 1 },
  content: {
    gap: 20,
    paddingBottom: 56,
    paddingHorizontal: mobileTheme.spacing.large,
    paddingTop: mobileTheme.spacing.xlarge,
  },
  headerStatus: { alignItems: "center", flexDirection: "row", gap: 5 },
  headerStatusDot: { borderRadius: 3, height: 6, width: 6 },
  headerStatusText: { color: mobileTheme.colors.inkTertiary, fontSize: 10 },
  realtimeIdle: { backgroundColor: mobileTheme.colors.lineStrong },
  realtimeConnecting: { backgroundColor: mobileTheme.colors.warning },
  realtimeConnected: { backgroundColor: mobileTheme.colors.accent },
  realtimeDisconnected: { backgroundColor: mobileTheme.colors.danger },
  runBanner: {
    alignItems: "center",
    backgroundColor: mobileTheme.colors.accentSoft,
    borderRadius: mobileTheme.radius.small,
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  runText: {
    color: mobileTheme.colors.accentStrong,
    flex: 1,
    fontSize: mobileTheme.type.small,
    fontWeight: "600",
  },
  realtimeWarning: {
    backgroundColor: mobileTheme.colors.warningSoft,
    borderRadius: mobileTheme.radius.small,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  realtimeWarningText: {
    color: mobileTheme.colors.warning,
    fontSize: mobileTheme.type.caption,
    lineHeight: 16,
  },
  centerState: { alignItems: "center", gap: 10, paddingVertical: 64 },
  mutedText: { color: mobileTheme.colors.inkTertiary, fontSize: mobileTheme.type.body },
  errorCard: {
    backgroundColor: mobileTheme.colors.dangerSoft,
    borderRadius: mobileTheme.radius.medium,
    gap: 5,
    padding: 14,
  },
  errorTitle: {
    color: mobileTheme.colors.danger,
    fontSize: mobileTheme.type.body,
    fontWeight: "700",
  },
  errorText: { color: mobileTheme.colors.danger, fontSize: mobileTheme.type.small, lineHeight: 18 },
  messageRow: { alignItems: "flex-start" },
  userMessageRow: { alignItems: "flex-end" },
  messageBubble: {
    borderRadius: mobileTheme.radius.large,
    maxWidth: "88%",
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  userBubble: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: "transparent",
    borderRadius: 0,
    maxWidth: "100%",
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  messageText: { color: mobileTheme.colors.ink, fontSize: mobileTheme.type.body, lineHeight: 23 },
  streamingCursor: { color: mobileTheme.colors.accent },
  userMessageText: { color: mobileTheme.colors.ink },
  thinkingCard: {
    borderLeftColor: mobileTheme.colors.lineStrong,
    borderLeftWidth: 2,
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  thinkingText: {
    color: mobileTheme.colors.inkTertiary,
    fontSize: mobileTheme.type.small,
    lineHeight: 18,
  },
  eventCard: {
    backgroundColor: mobileTheme.colors.surface,
    borderColor: mobileTheme.colors.line,
    borderRadius: mobileTheme.radius.small,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  eventLabel: {
    color: mobileTheme.colors.inkSecondary,
    fontSize: mobileTheme.type.caption,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  eventDetail: {
    color: mobileTheme.colors.inkTertiary,
    fontSize: mobileTheme.type.caption,
    lineHeight: 16,
  },
  composerSafeArea: {
    backgroundColor: mobileTheme.colors.canvas,
    borderTopColor: mobileTheme.colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sendError: {
    color: mobileTheme.colors.danger,
    fontSize: mobileTheme.type.caption,
    paddingHorizontal: 16,
    paddingTop: 7,
  },
  composer: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  composerInput: {
    backgroundColor: mobileTheme.colors.canvas,
    borderColor: mobileTheme.colors.lineStrong,
    borderRadius: mobileTheme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    color: mobileTheme.colors.ink,
    flex: 1,
    fontSize: mobileTheme.type.body,
    maxHeight: 120,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: mobileTheme.colors.accent,
    borderRadius: mobileTheme.radius.small,
    height: 36,
    justifyContent: "center",
    marginBottom: 2,
    width: 36,
  },
  sendButtonDisabled: { backgroundColor: mobileTheme.colors.surfaceStrong },
  sendButtonPressed: { opacity: 0.78 },
  sendButtonText: {
    color: mobileTheme.colors.white,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 22,
  },
});
