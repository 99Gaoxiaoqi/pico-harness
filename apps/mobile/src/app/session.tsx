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
      <Stack.Screen options={{ headerLargeTitle: false, title }} />
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
              <ActivityIndicator color="#176FB8" size="small" />
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
              <ActivityIndicator color="#208AEF" />
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
                <ActivityIndicator color="#FFFFFF" size="small" />
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { gap: 10, padding: 16, paddingBottom: 48 },
  runBanner: {
    alignItems: "center",
    backgroundColor: "#E7F2FD",
    borderRadius: 12,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  runText: { color: "#176FB8", flex: 1, fontSize: 13, fontWeight: "600" },
  realtimeWarning: { backgroundColor: "#FFF4E5", borderRadius: 12, padding: 11 },
  realtimeWarningText: { color: "#865B16", fontSize: 12, lineHeight: 17 },
  centerState: { alignItems: "center", gap: 10, paddingVertical: 64 },
  mutedText: { color: "#77777D", fontSize: 14 },
  errorCard: { backgroundColor: "#FFF0F0", borderRadius: 14, gap: 5, padding: 14 },
  errorTitle: { color: "#9A2525", fontSize: 15, fontWeight: "700" },
  errorText: { color: "#A13D3D", fontSize: 13, lineHeight: 19 },
  messageRow: { alignItems: "flex-start" },
  userMessageRow: { alignItems: "flex-end" },
  messageBubble: { borderRadius: 16, maxWidth: "88%", paddingHorizontal: 14, paddingVertical: 11 },
  userBubble: { backgroundColor: "#208AEF", borderBottomRightRadius: 5 },
  assistantBubble: { backgroundColor: "#F1F1F3", borderBottomLeftRadius: 5 },
  messageText: { color: "#252529", fontSize: 15, lineHeight: 22 },
  streamingCursor: { color: "#208AEF" },
  userMessageText: { color: "#FFFFFF" },
  thinkingCard: { borderLeftColor: "#C8C8CD", borderLeftWidth: 2, gap: 5, padding: 10 },
  thinkingText: { color: "#696970", fontSize: 13, fontStyle: "italic", lineHeight: 19 },
  eventCard: { backgroundColor: "#F8F8F9", borderRadius: 11, gap: 4, padding: 10 },
  eventLabel: { color: "#63636A", fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  eventDetail: { color: "#77777D", fontSize: 12, lineHeight: 17 },
  composerSafeArea: { backgroundColor: "#FFFFFF", borderTopColor: "#E8E8EB", borderTopWidth: 1 },
  sendError: { color: "#B42323", fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
  composer: { alignItems: "flex-end", flexDirection: "row", gap: 8, padding: 12 },
  composerInput: {
    backgroundColor: "#F3F3F5",
    borderRadius: 18,
    color: "#202024",
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  sendButtonDisabled: { backgroundColor: "#B9D8F5" },
  sendButtonPressed: { opacity: 0.78 },
  sendButtonText: { color: "#FFFFFF", fontSize: 24, fontWeight: "700", lineHeight: 26 },
});
