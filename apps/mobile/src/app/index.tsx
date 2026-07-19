import { Stack, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MobileProject, MobileProjectId, MobileSession } from "@pico/protocol";
import { MobileGatewayClient } from "../lib/mobile-gateway-client";
import { mobileTheme } from "../lib/mobile-theme";

const GATEWAY_ORIGIN_KEY = "pico.mobile.gatewayOrigin";
const GATEWAY_TOKEN_KEY = "pico.mobile.gatewayToken";
const DEFAULT_GATEWAY_ORIGIN =
  Platform.OS === "android" ? "http://10.0.2.2:47831" : "http://127.0.0.1:47831";

type ConnectionPhase = "idle" | "connecting" | "connected" | "error";

export default function ProjectsScreen() {
  const router = useRouter();
  const [origin, setOrigin] = useState(DEFAULT_GATEWAY_ORIGIN);
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<readonly MobileProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<MobileProjectId>();
  const [sessions, setSessions] = useState<readonly MobileSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
  const [showConnection, setShowConnection] = useState(true);
  const [message, setMessage] = useState("输入 Desktop Gateway 的临时 Token 后连接。");

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      SecureStore.getItemAsync(GATEWAY_ORIGIN_KEY),
      SecureStore.getItemAsync(GATEWAY_TOKEN_KEY),
    ]).then(([storedOrigin, storedToken]) => {
      if (!mounted) return;
      if (storedOrigin) setOrigin(storedOrigin);
      if (storedToken) setToken(storedToken);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const connect = async () => {
    setPhase("connecting");
    setMessage("正在读取已信任项目…");
    try {
      const client = new MobileGatewayClient({ origin, token });
      const nextProjects = await client.listProjects();
      await Promise.all([
        SecureStore.setItemAsync(GATEWAY_ORIGIN_KEY, origin.trim()),
        SecureStore.setItemAsync(GATEWAY_TOKEN_KEY, token),
      ]);
      setProjects(nextProjects);
      setSelectedProjectId(undefined);
      setSessions([]);
      setPhase("connected");
      setShowConnection(false);
      setMessage(
        nextProjects.length > 0
          ? `已连接·${nextProjects.length} 个可用项目`
          : "已连接·Desktop 暂无已信任项目",
      );
    } catch (error) {
      setProjects([]);
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Gateway 连接失败");
    }
  };

  const openProject = async (project: MobileProject) => {
    if (selectedProjectId === project.projectId) {
      setSelectedProjectId(undefined);
      setSessions([]);
      return;
    }
    setSelectedProjectId(project.projectId);
    setSessionsLoading(true);
    try {
      const nextSessions = await new MobileGatewayClient({ origin, token }).listSessions(
        project.projectId,
      );
      setSessions(nextSessions);
    } catch (error) {
      setSessions([]);
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "会话列表读取失败");
    } finally {
      setSessionsLoading(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Pico",
          headerRight: () => (
            <Pressable
              accessibilityLabel="Desktop 连接设置"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setShowConnection((visible) => !visible)}
              style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
            >
              <View style={[styles.headerStatusDot, statusStyle(phase)]} />
              <Text style={styles.headerActionText}>连接</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.pageHeading}>
          <View>
            <Text selectable style={styles.title}>
              项目
            </Text>
            <Text selectable style={styles.subtitle}>
              继续 Desktop 中已信任的工作区
            </Text>
          </View>
          {phase === "connected" ? (
            <Text style={styles.projectCount}>{projects.length}</Text>
          ) : null}
        </View>

        {showConnection ? (
          <View style={styles.connectionPanel}>
            <View style={styles.panelHeading}>
              <View style={styles.connectionTitleRow}>
                <View style={[styles.statusDot, statusStyle(phase)]} />
                <Text style={styles.panelTitle}>Desktop Gateway</Text>
              </View>
              <Text style={styles.connectionPrivacy}>仅保存于本机钥匙串</Text>
            </View>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>地址</Text>
              <TextInput
                accessibilityLabel="Gateway 地址"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setOrigin}
                placeholder={DEFAULT_GATEWAY_ORIGIN}
                placeholderTextColor={mobileTheme.colors.inkTertiary}
                style={styles.input}
                value={origin}
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>临时 Token</Text>
              <TextInput
                accessibilityLabel="Gateway 临时 Token"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setToken}
                onSubmitEditing={() => void connect()}
                placeholder="从 Gateway 输出中复制"
                placeholderTextColor={mobileTheme.colors.inkTertiary}
                returnKeyType="go"
                secureTextEntry
                style={styles.input}
                value={token}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={phase === "connecting"}
              onPress={() => void connect()}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                phase === "connecting" && styles.buttonDisabled,
              ]}
            >
              {phase === "connecting" ? (
                <ActivityIndicator color={mobileTheme.colors.white} size="small" />
              ) : (
                <Text style={styles.buttonText}>连接并刷新</Text>
              )}
            </Pressable>
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.message, phase === "error" && styles.errorMessage]}
            >
              {message}
            </Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowConnection(true)}
            style={({ pressed }) => [styles.connectionSummary, pressed && styles.pressed]}
          >
            <View style={[styles.statusDot, statusStyle(phase)]} />
            <Text style={styles.connectionSummaryText} numberOfLines={1}>
              {message}
            </Text>
            <Text style={styles.summaryAction}>设置</Text>
          </Pressable>
        )}

        {phase === "connected" ? (
          <View style={styles.projectSection}>
            {projects.length > 0 ? (
              projects.map((project) => (
                <View key={project.projectId} style={styles.projectGroup}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void openProject(project)}
                    style={({ pressed }) => [styles.projectRow, pressed && styles.projectPressed]}
                  >
                    <View style={styles.projectMark}>
                      <View style={styles.folderIcon}>
                        <View style={styles.folderTab} />
                        <View style={styles.folderBody} />
                      </View>
                    </View>
                    <View style={styles.projectCopy}>
                      <Text numberOfLines={1} style={styles.projectName}>
                        {project.name}
                      </Text>
                      <Text style={styles.projectMeta}>已信任工作区</Text>
                    </View>
                    {sessionsLoading && selectedProjectId === project.projectId ? (
                      <ActivityIndicator color={mobileTheme.colors.accent} size="small" />
                    ) : (
                      <Text style={styles.disclosure}>
                        {selectedProjectId === project.projectId ? "⌄" : "›"}
                      </Text>
                    )}
                  </Pressable>
                  {selectedProjectId === project.projectId && !sessionsLoading && (
                    <View style={styles.sessionList}>
                      {sessions.length === 0 ? (
                        <Text style={styles.emptySessions}>暂无可用会话</Text>
                      ) : (
                        sessions.map((session) => (
                          <Pressable
                            accessibilityRole="button"
                            key={session.sessionId}
                            onPress={() =>
                              router.push({
                                pathname: "/session",
                                params: {
                                  projectId: project.projectId,
                                  sessionId: session.sessionId,
                                  title: session.title,
                                },
                              })
                            }
                            style={({ pressed }) => [
                              styles.sessionRow,
                              pressed && styles.projectPressed,
                            ]}
                          >
                            <View style={styles.sessionCopy}>
                              <Text numberOfLines={1} style={styles.sessionTitle}>
                                {session.pinned ? "● " : ""}
                                {session.title}
                              </Text>
                              <Text style={styles.sessionMeta}>
                                {formatUpdatedAt(session.updatedAt)}
                              </Text>
                            </View>
                            <Text style={styles.sessionDisclosure}>›</Text>
                          </Pressable>
                        ))
                      )}
                    </View>
                  )}
                </View>
              ))
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>暂无项目</Text>
                <Text style={styles.emptyText}>先在 Desktop 中添加并信任一个工作区。</Text>
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

function formatUpdatedAt(value: string | number): string {
  const timestamp = new Date(value).getTime();
  const elapsed = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsed < 0) return new Date(value).toLocaleDateString();
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(value).toLocaleDateString();
}

function statusStyle(phase: ConnectionPhase) {
  switch (phase) {
    case "connecting":
      return styles.status_connecting;
    case "connected":
      return styles.status_connected;
    case "error":
      return styles.status_error;
    case "idle":
      return styles.status_idle;
  }
}

const styles = StyleSheet.create({
  content: {
    gap: mobileTheme.spacing.large,
    paddingBottom: 40,
    paddingHorizontal: mobileTheme.spacing.large,
    paddingTop: mobileTheme.spacing.small,
  },
  pageHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: mobileTheme.spacing.small,
  },
  title: {
    color: mobileTheme.colors.ink,
    fontSize: mobileTheme.type.title,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  subtitle: {
    color: mobileTheme.colors.inkTertiary,
    fontSize: mobileTheme.type.small,
    marginTop: 3,
  },
  projectCount: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
    borderRadius: mobileTheme.radius.round,
    color: mobileTheme.colors.inkSecondary,
    fontSize: mobileTheme.type.caption,
    fontWeight: "700",
    minWidth: 24,
    overflow: "hidden",
    paddingHorizontal: 7,
    paddingVertical: 4,
    textAlign: "center",
  },
  headerAction: { alignItems: "center", flexDirection: "row", gap: 6, paddingVertical: 5 },
  headerActionText: { color: mobileTheme.colors.inkSecondary, fontSize: mobileTheme.type.small },
  headerStatusDot: { borderRadius: 3, height: 6, width: 6 },
  pressed: { opacity: 0.62 },
  connectionPanel: {
    backgroundColor: mobileTheme.colors.surface,
    borderColor: mobileTheme.colors.line,
    borderRadius: mobileTheme.radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    gap: mobileTheme.spacing.medium,
    padding: mobileTheme.spacing.large,
  },
  panelHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  connectionTitleRow: { alignItems: "center", flexDirection: "row", gap: 7 },
  panelTitle: { color: mobileTheme.colors.ink, fontSize: mobileTheme.type.body, fontWeight: "600" },
  connectionPrivacy: { color: mobileTheme.colors.inkTertiary, fontSize: 10 },
  statusDot: { borderRadius: 5, height: 10, width: 10 },
  status_idle: { backgroundColor: mobileTheme.colors.lineStrong },
  status_connecting: { backgroundColor: mobileTheme.colors.warning },
  status_connected: { backgroundColor: mobileTheme.colors.accent },
  status_error: { backgroundColor: mobileTheme.colors.danger },
  fieldGroup: { gap: 5 },
  label: {
    color: mobileTheme.colors.inkSecondary,
    fontSize: mobileTheme.type.caption,
    fontWeight: "600",
  },
  input: {
    backgroundColor: mobileTheme.colors.canvas,
    borderColor: mobileTheme.colors.line,
    borderRadius: mobileTheme.radius.small,
    borderWidth: StyleSheet.hairlineWidth,
    color: mobileTheme.colors.ink,
    fontSize: mobileTheme.type.body,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  button: {
    alignItems: "center",
    backgroundColor: mobileTheme.colors.accent,
    borderRadius: mobileTheme.radius.small,
    justifyContent: "center",
    minHeight: 40,
  },
  buttonPressed: { opacity: 0.82 },
  buttonDisabled: { opacity: 0.65 },
  buttonText: {
    color: mobileTheme.colors.white,
    fontSize: mobileTheme.type.body,
    fontWeight: "600",
  },
  message: {
    color: mobileTheme.colors.inkSecondary,
    fontSize: mobileTheme.type.caption,
    lineHeight: 16,
  },
  errorMessage: { color: mobileTheme.colors.danger },
  connectionSummary: {
    alignItems: "center",
    borderColor: mobileTheme.colors.line,
    borderRadius: mobileTheme.radius.small,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
  },
  connectionSummaryText: {
    color: mobileTheme.colors.inkSecondary,
    flex: 1,
    fontSize: mobileTheme.type.caption,
  },
  summaryAction: {
    color: mobileTheme.colors.accent,
    fontSize: mobileTheme.type.caption,
    fontWeight: "600",
  },
  projectSection: {
    backgroundColor: mobileTheme.colors.sidebar,
    borderRadius: mobileTheme.radius.medium,
    overflow: "hidden",
    padding: 6,
  },
  projectGroup: { gap: 1 },
  projectRow: {
    alignItems: "center",
    borderRadius: mobileTheme.radius.small,
    flexDirection: "row",
    gap: 9,
    minHeight: 46,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  projectPressed: { opacity: 0.72 },
  projectMark: {
    alignItems: "center",
    backgroundColor: mobileTheme.colors.surfaceStrong,
    borderRadius: mobileTheme.radius.small,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  folderIcon: { height: 14, position: "relative", width: 16 },
  folderTab: {
    backgroundColor: mobileTheme.colors.inkSecondary,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    height: 4,
    left: 1,
    position: "absolute",
    top: 0,
    width: 7,
  },
  folderBody: {
    backgroundColor: mobileTheme.colors.inkSecondary,
    borderRadius: 2,
    bottom: 0,
    height: 11,
    left: 0,
    position: "absolute",
    width: 16,
  },
  projectCopy: { flex: 1, gap: 1 },
  projectName: { color: mobileTheme.colors.ink, fontSize: 13, fontWeight: "700" },
  projectMeta: { color: mobileTheme.colors.inkTertiary, fontSize: 10 },
  disclosure: { color: mobileTheme.colors.inkTertiary, fontSize: 19, marginLeft: 4, width: 18 },
  sessionList: {
    borderLeftColor: mobileTheme.colors.lineStrong,
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: 1,
    marginBottom: 6,
    marginLeft: 23,
    paddingLeft: 7,
  },
  emptySessions: {
    color: mobileTheme.colors.inkTertiary,
    fontSize: mobileTheme.type.caption,
    padding: 9,
  },
  sessionRow: {
    alignItems: "center",
    borderRadius: mobileTheme.radius.small,
    flexDirection: "row",
    minHeight: 38,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  sessionCopy: { flex: 1, gap: 2 },
  sessionTitle: {
    color: mobileTheme.colors.inkSecondary,
    fontSize: mobileTheme.type.small,
    fontWeight: "500",
  },
  sessionMeta: { color: mobileTheme.colors.inkTertiary, fontSize: 9 },
  sessionDisclosure: { color: mobileTheme.colors.inkTertiary, fontSize: 17, marginLeft: 8 },
  emptyState: { alignItems: "center", gap: 5, paddingHorizontal: 20, paddingVertical: 40 },
  emptyTitle: { color: mobileTheme.colors.ink, fontSize: mobileTheme.type.body, fontWeight: "600" },
  emptyText: {
    color: mobileTheme.colors.inkTertiary,
    fontSize: mobileTheme.type.small,
    textAlign: "center",
  },
});
