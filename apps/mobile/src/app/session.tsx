import type { MobileConversationItem, MobileTranscript } from "@pico/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { MobileGatewayClient } from "../lib/mobile-gateway-client";

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
      setTranscript(
        await new MobileGatewayClient({ origin, token }).getTranscript(projectId, sessionId),
      );
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

  return (
    <>
      <Stack.Screen options={{ headerLargeTitle: false, title }} />
      <ScrollView
        contentContainerStyle={styles.content}
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
        ) : transcript?.items.length ? (
          transcript.items.map((item) => <TranscriptItem key={item.id} item={item} />)
        ) : (
          <View style={styles.centerState}>
            <Text style={styles.mutedText}>这个会话还没有消息</Text>
          </View>
        )}
      </ScrollView>
    </>
  );
}

function TranscriptItem({ item }: { readonly item: MobileConversationItem }) {
  if (item.kind === "userMessage" || item.kind === "assistantMessage") {
    const user = item.kind === "userMessage";
    return (
      <View style={[styles.messageRow, user && styles.userMessageRow]}>
        <View style={[styles.messageBubble, user ? styles.userBubble : styles.assistantBubble]}>
          <Text selectable style={[styles.messageText, user && styles.userMessageText]}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  }
  if (item.kind === "thinking") {
    return (
      <View style={styles.thinkingCard}>
        <Text style={styles.eventLabel}>思考</Text>
        <Text selectable style={styles.thinkingText}>
          {item.content}
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

function summarizeItem(item: MobileConversationItem): { label: string; detail?: string } {
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

function singleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const styles = StyleSheet.create({
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
  userMessageText: { color: "#FFFFFF" },
  thinkingCard: { borderLeftColor: "#C8C8CD", borderLeftWidth: 2, gap: 5, padding: 10 },
  thinkingText: { color: "#696970", fontSize: 13, fontStyle: "italic", lineHeight: 19 },
  eventCard: { backgroundColor: "#F8F8F9", borderRadius: 11, gap: 4, padding: 10 },
  eventLabel: { color: "#63636A", fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  eventDetail: { color: "#77777D", fontSize: 12, lineHeight: 17 },
});
