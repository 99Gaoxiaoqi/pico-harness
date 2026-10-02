import React, { useEffect, useState } from "react";
import {
  Alert,
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { RuntimeSession } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { Button, Card, Chips, Field, Label, s, color } from "./ui";
import { Conversation } from "./Conversation";
import { Workbar, type WorkbarTab } from "./Workbar";
import { SettingsPanel } from "./Settings";
export default function App() {
  const pico = usePico();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);
  const [screen, setScreen] = useState<
    "computers" | "sessions" | "conversation" | "workbar" | "settings"
  >("computers");
  const [sessionId, setSessionId] = useState<string>();
  const [sideParent, setSideParent] = useState<string>();
  const [workbarTab, setWorkbarTab] = useState<WorkbarTab>("任务");
  useEffect(() => {
    setSessionId(undefined);
    setSideParent(undefined);
    if (pico.workspace) setScreen("sessions");
  }, [pico.host?.id, pico.workspace?.id]);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen === "computers") return false;
      setScreen(
        screen === "workbar" && sessionId
          ? "conversation"
          : screen === "conversation"
            ? "sessions"
            : "computers",
      );
      return true;
    });
    return () => back.remove();
  }, [screen, sessionId]);
  const goSession = (id: string, parentSessionId?: string) => {
    if (parentSessionId) setSideParent(parentSessionId);
    else if (id !== sessionId) setSideParent(undefined);
    setSessionId(id);
    setScreen("conversation");
  };
  const inSession = !!sessionId && (screen === "conversation" || screen === "workbar");
  return (
    <SafeAreaView style={s.page}>
      <StatusBar style="dark" />
      <View
        style={[s.body, styles.header, inSession && styles.compactHeader]}
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      >
        {inSession ? (
          <View style={styles.chatHeader}>
            <Button
              title={screen === "workbar" ? "返回对话" : "会话"}
              quiet
              onPress={() => setScreen(screen === "workbar" ? "conversation" : "sessions")}
            />
            <View style={styles.chatHeading}>
              <Text style={styles.brand}>pico</Text>
              <Text numberOfLines={1} style={s.muted}>
                {pico.phase === "connected"
                  ? pico.workspace?.label
                  : {
                      offline: "未连接",
                      connecting: "连接中",
                      syncing: "同步中",
                      connected: "已连接",
                      background: "后台暂停",
                      blocked: "需要处理",
                    }[pico.phase]}
              </Text>
            </View>
            <Button title="电脑" quiet onPress={() => setScreen("computers")} />
          </View>
        ) : (
          <View style={[s.row, { justifyContent: "space-between" }]}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setScreen("computers")}
              style={styles.brandTarget}
            >
              <Text style={styles.brand}>pico</Text>
            </Pressable>
            <View style={[s.row, { gap: 6 }]}>
              <View
                style={[
                  styles.connectionDot,
                  { backgroundColor: pico.phase === "connected" ? color.accent : color.muted },
                ]}
              />
              <Label>
                {
                  {
                    offline: "未连接",
                    connecting: "连接中",
                    syncing: "同步中",
                    connected: "已连接",
                    background: "后台暂停",
                    blocked: "需要处理",
                  }[pico.phase]
                }
              </Label>
            </View>
          </View>
        )}
        {!inSession && (
          <Text numberOfLines={1} style={s.muted}>
            {pico.host?.name ?? "连接你的电脑，继续你的工作"}
          </Text>
        )}
        {pico.workspace && screen !== "computers" && !inSession && (
          <View style={styles.navigation}>
            {(
              [
                ["sessions", "会话"],
                ["computers", "工作区"],
                ["settings", "电脑设置"],
              ] as const
            ).map(([target, label]) => {
              const selected =
                screen === target ||
                (target === "sessions" && (screen === "conversation" || screen === "workbar"));
              return (
                <Pressable
                  key={target}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setScreen(target)}
                  style={[styles.navigationItem, selected && styles.navigationItemSelected]}
                >
                  <Text style={[styles.navigationText, selected && { color: color.text }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
            {sessionId && screen === "workbar" && (
              <Button title="返回对话" quiet onPress={() => setScreen("conversation")} />
            )}
          </View>
        )}
        {pico.error && (
          <Card>
            <Text style={{ color: color.danger }}>{pico.error}</Text>
            {pico.host && (
              <Button title="重新连接" quiet onPress={() => void pico.connect(pico.host!)} />
            )}
          </Card>
        )}
      </View>
      {screen === "computers" ? (
        <ScrollView contentContainerStyle={s.body}>
          <Computers />
        </ScrollView>
      ) : screen === "sessions" ? (
        <Sessions onSession={goSession} />
      ) : inSession && sessionId ? (
        <View style={{ flex: 1 }}>
          <View
            style={[styles.conversationPage, { opacity: screen === "conversation" ? 1 : 0 }]}
            pointerEvents={screen === "conversation" ? "auto" : "none"}
            accessibilityElementsHidden={screen !== "conversation"}
            importantForAccessibility={screen === "conversation" ? "auto" : "no-hide-descendants"}
          >
            <Conversation
              key={`${pico.host?.id}/${pico.workspace?.id}/${sessionId}`}
              sessionId={sessionId}
              keyboardOffset={insets.top + headerHeight}
              sideParentSessionId={sideParent}
              onSession={goSession}
              onPanel={(tab = "任务") => {
                setWorkbarTab(tab);
                setScreen("workbar");
              }}
            />
          </View>
          {screen === "workbar" && (
            <View style={{ flex: 1, backgroundColor: color.bg }}>
              <Workbar
                key={`${pico.host?.id}/${pico.workspace?.id}/${sessionId}/${workbarTab}`}
                sessionId={sessionId}
                initialTab={workbarTab}
              />
            </View>
          )}
        </View>
      ) : screen === "settings" ? (
        <ScrollView contentContainerStyle={s.body}>
          <SettingsPanel key={`${pico.host?.id}/${pico.workspace?.id}`} />
        </ScrollView>
      ) : (
        <View style={s.body}>
          <Label>选择工作区和会话开始。</Label>
        </View>
      )}
    </SafeAreaView>
  );
}
function Computers() {
  const pico = usePico();
  const [pairing, setPairing] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("我的手机");
  const [busy, setBusy] = useState(false);
  async function pair(value: string) {
    if (busy) return;
    setBusy(true);
    setScanner(false);
    try {
      await pico.pair(value, name);
      setPairing(false);
      setRaw("");
    } catch (e) {
      pico.report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Text style={styles.sectionTitle}>我的电脑</Text>
      {pico.hosts.map((host) => (
        <Card key={host.id}>
          <Text style={s.text}>{host.name}</Text>
          <Label>{host.baseUrl}</Label>
          <View style={s.row}>
            <Button
              title={pico.host?.id === host.id ? "重新连接" : "连接"}
              onPress={() => void pico.connect(host)}
            />
            <Button
              title="解除配对"
              quiet
              onPress={() =>
                Alert.alert(
                  "解除这台电脑的配对？",
                  "手机将移除凭据，并尝试撤销电脑上的设备授权。",
                  [
                    { text: "返回" },
                    {
                      text: "解除",
                      style: "destructive",
                      onPress: () => void pico.perform(() => pico.remove(host)),
                    },
                  ],
                )
              }
            />
          </View>
        </Card>
      ))}
      {!pico.hosts.length && (
        <Card>
          <Text style={s.text}>把电脑上的 Pico 带到手机</Text>
          <Label>在电脑启动网关并运行 pico remote pair，扫描二维码。手机可使用蜂窝网络。</Label>
        </Card>
      )}
      <Button title="配对新电脑" onPress={() => setPairing(!pairing)} />
      {pairing && (
        <Card>
          <Field label="手机名称" value={name} onChange={setName} />
          <Button
            title="扫描电脑二维码"
            reason={busy ? "等待电脑批准" : undefined}
            onPress={() => {
              if (!permission?.granted) void requestPermission().then((x) => setScanner(x.granted));
              else setScanner(true);
            }}
          />
          {scanner && (
            <CameraView
              style={{ height: 280, borderRadius: 14 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => void pair(data)}
            />
          )}
          <Field
            label="或粘贴配对内容"
            value={raw}
            onChange={setRaw}
            multiline
            placeholder="电脑配对命令输出的 JSON"
          />
          <Button
            title={busy ? "等待电脑批准…" : "提交配对"}
            reason={busy ? "请在电脑确认" : !raw ? "扫描或粘贴配对内容" : undefined}
            onPress={() => void pair(raw)}
          />
          <Label>使用系统信任的 HTTPS 证书。配对有效期 5 分钟。</Label>
        </Card>
      )}
      {pico.host && (
        <Card>
          <Text style={s.text}>已授权工作区</Text>
          {pico.workspaces.map((w) => (
            <Button key={w.id} title={w.label} secondary onPress={() => pico.chooseWorkspace(w)} />
          ))}
          {!pico.workspaces.length && <Label>电脑尚未授权工作区，请在电脑调整设备授权。</Label>}
          <Button title="断开电脑" quiet onPress={pico.disconnect} />
        </Card>
      )}
    </>
  );
}
function Sessions({ onSession }: { onSession: (id: string) => void }) {
  const pico = usePico();
  const [sessions, setSessions] = useState<readonly RuntimeSession[]>([]);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<"活跃" | "全部">("活跃");
  const [title, setTitle] = useState("");
  const [renameId, setRenameId] = useState<string>();
  const [actionSessionId, setActionSessionId] = useState<string>();
  const [visible, setVisible] = useState(30);
  async function refresh() {
    if (!pico.connected) return;
    const x = await pico.request("session.list", { includeArchived: archived === "全部" });
    setSessions(x.sessions);
  }
  useEffect(() => {
    setSessions([]);
    setVisible(30);
    void pico.perform(refresh);
  }, [pico.generation, pico.connected, archived]);
  const list = sessions
    .filter(
      (x) =>
        (archived === "全部" || x.status !== "archived") &&
        x.title.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return (
    <FlatList
      data={list.slice(0, visible)}
      keyExtractor={(x) => x.sessionId}
      contentContainerStyle={s.body}
      onRefresh={() => void pico.perform(refresh)}
      refreshing={false}
      ListHeaderComponent={
        <View style={{ gap: 10, paddingBottom: 14 }}>
          <Text style={styles.sectionTitle}>{pico.workspace?.label}</Text>
          <Field
            label="搜索会话"
            placeholder="搜索会话"
            value={query}
            onChange={setQuery}
            compact
          />
          <Chips values={["活跃", "全部"] as const} value={archived} onChange={setArchived} />
          <View style={styles.sessionComposer}>
            <Field
              label={renameId ? "会话新名称" : "新会话名称（可选）"}
              placeholder={renameId ? "会话新名称" : "新会话名称（可选）"}
              value={title}
              onChange={setTitle}
              compact
            />
            <Button
              title={renameId ? "保存名称" : "新建会话"}
              reason={pico.reason(renameId ? "session.rename" : "session.create")}
              onPress={() =>
                void pico.perform(async () => {
                  if (renameId) {
                    await pico.request("session.rename", { sessionId: renameId, title });
                    setRenameId(undefined);
                    setTitle("");
                    await refresh();
                  } else {
                    const x = await pico.request("session.create", title ? { title } : {});
                    setTitle("");
                    onSession(x.session.sessionId);
                  }
                })
              }
            />
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.sessionItem}>
          <View style={[s.row, { flexWrap: "nowrap", alignItems: "flex-start" }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`打开会话：${item.title || "未命名会话"}`}
              onPress={() => onSession(item.sessionId)}
              style={{ flex: 1, gap: 3, paddingVertical: 5 }}
            >
              <Text numberOfLines={2} style={[s.text, { fontWeight: "600" }]}>
                {item.pinned ? "★ " : ""}
                {item.title || "未命名会话"}
              </Text>
              <Label>
                {item.status === "archived" ? "已归档" : item.status} ·{" "}
                {new Date(item.updatedAt).toLocaleString()}
              </Label>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`管理会话：${item.title || "未命名会话"}`}
              accessibilityState={{ expanded: actionSessionId === item.sessionId }}
              onPress={() =>
                setActionSessionId(actionSessionId === item.sessionId ? undefined : item.sessionId)
              }
              style={styles.sessionManage}
            >
              <Text style={styles.navigationText}>
                {actionSessionId === item.sessionId ? "收起" : "管理"}
              </Text>
            </Pressable>
          </View>
          {actionSessionId === item.sessionId && (
            <View style={s.row}>
              <Button
                title="改名"
                quiet
                onPress={() => {
                  setRenameId(item.sessionId);
                  setTitle(item.title);
                }}
              />
              <Button
                title={item.pinned ? "取消固定" : "固定"}
                quiet
                reason={pico.reason(item.pinned ? "session.unpin" : "session.pin")}
                onPress={() =>
                  void pico.perform(async () => {
                    await pico.request(item.pinned ? "session.unpin" : "session.pin", {
                      sessionId: item.sessionId,
                    });
                    await refresh();
                  })
                }
              />
              <Button
                title={item.status === "archived" ? "恢复" : "归档"}
                quiet
                reason={pico.reason(
                  item.status === "archived" ? "session.restore" : "session.archive",
                )}
                onPress={() =>
                  void pico.perform(async () => {
                    await pico.request(
                      item.status === "archived" ? "session.restore" : "session.archive",
                      { sessionId: item.sessionId },
                    );
                    await refresh();
                  })
                }
              />
              <Button
                title="删除"
                quiet
                reason={pico.reason("session.delete")}
                onPress={() =>
                  Alert.alert("删除会话？", item.title, [
                    { text: "返回" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: () =>
                        void pico.perform(async () => {
                          await pico.request("session.delete", { sessionId: item.sessionId });
                          await refresh();
                        }),
                    },
                  ])
                }
              />
            </View>
          )}
        </View>
      )}
      ListFooterComponent={
        visible < list.length ? (
          <Button title="更多会话" quiet onPress={() => setVisible((x) => x + 30)} />
        ) : null
      }
      ListEmptyComponent={<Label>没有匹配的会话。</Label>}
    />
  );
}

const styles = StyleSheet.create({
  header: { paddingVertical: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: color.line },
  compactHeader: { paddingHorizontal: 12, paddingVertical: 4 },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatHeading: { flex: 1, alignItems: "center", gap: 0 },
  conversationPage: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
  brand: { color: color.text, fontSize: 21, fontWeight: "700", letterSpacing: -0.7 },
  brandTarget: { minHeight: 44, minWidth: 44, justifyContent: "center" },
  connectionDot: { width: 6, height: 6, borderRadius: 3 },
  navigation: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 3,
    padding: 3,
    marginTop: 4,
    backgroundColor: color.sidebar,
    borderRadius: 10,
  },
  navigationItem: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 7,
  },
  navigationItemSelected: { backgroundColor: color.bg },
  navigationText: { color: color.muted, fontSize: 13, fontWeight: "500" },
  sectionTitle: { color: color.text, fontSize: 20, fontWeight: "600", letterSpacing: -0.3 },
  sessionComposer: { padding: 12, gap: 10, borderRadius: 12, backgroundColor: color.surface },
  sessionItem: { paddingVertical: 12, gap: 6, borderTopWidth: 1, borderTopColor: color.line },
  sessionManage: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
});
