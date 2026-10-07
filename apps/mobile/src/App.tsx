import React, { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { usePico } from "./store";
import { Button, Label, s, color } from "./ui";
import { Conversation } from "./Conversation";
import { MessageMediaProvider } from "./MessageMedia";
import { Workbar, type WorkbarTab } from "./Workbar";
import { SettingsPanel } from "./Settings";
import { ActionsSheet } from "./ActionsSheet";
import { Computers } from "./screens/Computers";
import { Sessions } from "./screens/Sessions";

const tools: readonly { tab: WorkbarTab; title: string; detail: string }[] = [
  { tab: "审查", title: "查看文件改动", detail: "查看运行或工作区差异，反馈修改意见" },
  { tab: "文件", title: "生成文件", detail: "预览、分享会话成果" },
  { tab: "执行", title: "执行记录", detail: "执行过程与追踪详情" },
  { tab: "Graph", title: "协作进度", detail: "子任务、依赖与唤醒" },
  { tab: "任务", title: "待办清单", detail: "当前会话的任务" },
  { tab: "终端", title: "终端", detail: "连接电脑上的终端" },
  { tab: "上下文", title: "上下文与用量", detail: "上下文构成和实际消耗" },
  { tab: "设置", title: "会话设置", detail: "模型、模式与权限" },
];
const phaseLabels = {
  offline: "未连接",
  connecting: "连接中",
  syncing: "同步中",
  connected: "已连接",
  background: "后台暂停",
  blocked: "需要处理",
};
type Screen = "computers" | "sessions" | "conversation" | "workbar" | "settings";

export default function App() {
  const pico = usePico();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(0);
  const [screen, setScreen] = useState<Screen>("computers");
  const [sessionId, setSessionId] = useState<string>();
  const [parentIsSideChat, setParentIsSideChat] = useState(true);
  const [sideParent, setSideParent] = useState<string>();
  const parentLinks = useRef(
    new Map<string, { parentSessionId: string; kind: "sideChat" | "child" }>(),
  );
  const [workbarTab, setWorkbarTab] = useState<WorkbarTab>("任务");
  const [drawer, setDrawer] = useState(false);
  const [toolSheet, setToolSheet] = useState(false);
  const [creatingSideChat, setCreatingSideChat] = useState(false);
  const scope = `${pico.host?.id}/${pico.workspace?.id}/${sessionId}/${pico.generation}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [sessionHeading, setSessionHeading] = useState<{ scope: string; title: string }>();
  useEffect(() => {
    setSessionHeading(undefined);
    if (!sessionId || !pico.workspace || !pico.connected) return;
    let current = true;
    let latestRead = 0;
    const refresh = async () => {
      const read = ++latestRead;
      try {
        const result = await pico.request("session.get", { sessionId });
        if (
          current &&
          read === latestRead &&
          scopeRef.current === scope &&
          result.session.sessionId === sessionId
        )
          setSessionHeading({ scope, title: result.session.title || "未命名会话" });
      } catch (error) {
        if (current && read === latestRead && scopeRef.current === scope) pico.report(error);
      }
    };
    const off = pico.onNotification((event) => {
      if (event.topic === "session.updated" && event.scope.sessionId === sessionId) void refresh();
    });
    void refresh();
    return () => {
      current = false;
      off();
    };
  }, [scope, pico.connected]);
  useEffect(() => {
    setSessionId(undefined);
    setSideParent(undefined);
    parentLinks.current.clear();
    setDrawer(false);
    setToolSheet(false);
    setScreen(pico.workspace ? "sessions" : "computers");
  }, [pico.host?.id, pico.workspace?.id]);
  function returnToChat() {
    setScreen(sessionId ? "conversation" : "sessions");
  }
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (toolSheet) {
        setToolSheet(false);
        return true;
      }
      if (drawer) {
        setDrawer(false);
        return true;
      }
      if (screen === "computers") {
        if (!sessionId) return false;
        returnToChat();
        return true;
      }
      if (screen === "workbar" || screen === "settings") returnToChat();
      else if (screen === "conversation") {
        Keyboard.dismiss();
        setDrawer(true);
      } else setScreen("computers");
      return true;
    });
    return () => back.remove();
  }, [screen, sessionId, drawer, toolSheet]);
  const goSession = (
    id: string,
    parentSessionId?: string,
    kind: "sideChat" | "child" = "sideChat",
  ) => {
    if (parentSessionId) {
      parentLinks.current.set(id, { parentSessionId, kind });
      setSideParent(parentSessionId);
      setParentIsSideChat(kind === "sideChat");
    } else if (id !== sessionId) {
      const parent = parentLinks.current.get(id);
      setSideParent(parent?.parentSessionId);
      setParentIsSideChat(parent?.kind !== "child");
    }
    setSessionId(id);
    setDrawer(false);
    setToolSheet(false);
    setScreen("conversation");
  };
  function openPanel(tab: WorkbarTab = "任务") {
    Keyboard.dismiss();
    setToolSheet(false);
    setWorkbarTab(tab);
    setScreen("workbar");
  }
  const inSession = !!sessionId && (screen === "conversation" || screen === "workbar");
  const chatActive = screen === "conversation" && !drawer && !toolSheet;
  const sessionTitle = sessionHeading?.scope === scope ? sessionHeading.title : "会话";
  return (
    <SafeAreaView style={s.page}>
      <StatusBar style="dark" />
      <View
        style={styles.header}
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      >
        <Button
          title={
            inSession && screen === "workbar"
              ? "返回"
              : sessionId && (screen === "settings" || screen === "computers")
                ? "返回会话"
                : "会话"
          }
          quiet
          onPress={() => {
            Keyboard.dismiss();
            if (
              screen === "workbar" ||
              screen === "settings" ||
              (screen === "computers" && sessionId)
            )
              returnToChat();
            else if (sessionId) setDrawer(true);
            else if (pico.workspace) setScreen("sessions");
          }}
        />
        <Pressable
          style={styles.heading}
          accessibilityRole={inSession ? "button" : undefined}
          accessibilityLabel={
            inSession
              ? `会话：${sessionTitle}，当前电脑：${pico.host?.name ?? "已连接电脑"}，项目：${pico.workspace?.label ?? "当前项目"}`
              : undefined
          }
          accessibilityHint={inSession ? "查看或切换电脑与项目" : undefined}
          disabled={!inSession}
          onPress={() => {
            Keyboard.dismiss();
            setScreen("computers");
          }}
        >
          <Text numberOfLines={1} style={styles.brand}>
            {screen === "workbar"
              ? (tools.find((t) => t.tab === workbarTab)?.title ?? workbarTab)
              : screen === "settings"
                ? "设置"
                : screen === "conversation"
                  ? sessionTitle
                  : "pico"}
          </Text>
          <Text numberOfLines={1} style={s.muted}>
            {pico.phase === "connected"
              ? inSession
                ? `${pico.workspace?.label ?? "当前项目"} ▾`
                : [pico.workspace?.label, pico.host?.name].filter(Boolean).join(" · ")
              : phaseLabels[pico.phase]}
          </Text>
        </Pressable>
        <Button
          title={inSession ? "工具" : "设置"}
          quiet
          onPress={() => {
            Keyboard.dismiss();
            if (inSession) setToolSheet(true);
            else setScreen("settings");
          }}
        />
      </View>
      {pico.error && (
        <View style={styles.error}>
          <Text accessibilityRole="alert" style={{ color: color.danger }}>
            {pico.error}
          </Text>
          <Label>{pico.errorInfo?.guidance}</Label>
          {pico.errorInfo?.action !== "none" && (
            <Button
              title={
                pico.errorInfo?.action === "reconnect"
                  ? "重新连接"
                  : pico.errorInfo?.action === "verify"
                    ? "核对当前状态"
                    : "电脑与连接"
              }
              quiet
              onPress={() => {
                if (pico.errorInfo?.action === "reconnect" && pico.host)
                  void pico.connect(pico.host);
                else if (pico.errorInfo?.action === "verify") {
                  setDrawer(false);
                  setToolSheet(false);
                  if (screen === "computers" && pico.workspace) setScreen("sessions");
                } else setScreen("computers");
              }}
            />
          )}
        </View>
      )}
      <View style={{ flex: 1 }}>
        {sessionId && pico.workspace && (
          <View
            style={[
              styles.conversationPage,
              { display: screen === "conversation" ? "flex" : "none" },
            ]}
            pointerEvents={chatActive ? "auto" : "none"}
            accessibilityElementsHidden={!chatActive}
            importantForAccessibility={chatActive ? "auto" : "no-hide-descendants"}
          >
            <MessageMediaProvider sessionId={sessionId} active={chatActive}>
              <Conversation
                key={`${pico.host?.id}/${pico.workspace?.id}/${sessionId}`}
                active={chatActive}
                sessionId={sessionId}
                keyboardOffset={insets.top + headerHeight}
                sideParentSessionId={sideParent}
                parentIsSideChat={parentIsSideChat}
                onSession={goSession}
                onPanel={openPanel}
              />
            </MessageMediaProvider>
          </View>
        )}
        {screen === "computers" && (
          <ScrollView contentContainerStyle={s.body}>
            <Computers />
          </ScrollView>
        )}
        {screen === "sessions" && <Sessions onSession={goSession} />}
        {screen === "workbar" && sessionId && (
          <Workbar
            key={`${scope}/${workbarTab}`}
            sessionId={sessionId}
            initialTab={workbarTab}
            onReturnToConversation={returnToChat}
            onSession={goSession}
          />
        )}
        {screen === "settings" && (
          <ScrollView contentContainerStyle={s.body}>
            <SettingsPanel
              key={`${pico.host?.id}/${pico.workspace?.id}`}
              onOpenComputers={() => setScreen("computers")}
            />
          </ScrollView>
        )}
      </View>
      <Modal
        visible={drawer}
        transparent
        animationType="slide"
        onRequestClose={() => setDrawer(false)}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.drawerBackdrop}>
          <Pressable
            accessibilityLabel="关闭会话列表"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={() => setDrawer(false)}
          />
          <SafeAreaView style={styles.drawer} accessibilityViewIsModal>
            <View style={[s.row, styles.drawerHeader]}>
              <Text style={[s.title, { flex: 1 }]}>会话</Text>
              <Button title="关闭" quiet onPress={() => setDrawer(false)} />
            </View>
            <Sessions onSession={goSession} />
            <View style={[s.row, styles.drawerFooter]}>
              <Button
                title="电脑与项目"
                quiet
                onPress={() => {
                  setDrawer(false);
                  setScreen("computers");
                }}
              />
              <Button
                title="设置"
                quiet
                onPress={() => {
                  setDrawer(false);
                  setScreen("settings");
                }}
              />
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
      <ActionsSheet title="工具" open={toolSheet} onClose={() => setToolSheet(false)}>
        {tools.map((tool) => (
          <Pressable
            key={tool.tab}
            accessibilityRole="button"
            onPress={() => openPanel(tool.tab)}
            style={styles.toolRow}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.text}>{tool.title}</Text>
              <Label>{tool.detail}</Label>
            </View>
            <Text style={s.muted}>›</Text>
          </Pressable>
        ))}
        <Button
          title={creatingSideChat ? "正在打开侧聊…" : "临时侧聊"}
          quiet
          reason={creatingSideChat ? "正在创建" : pico.reason("sideChat.create")}
          onPress={() =>
            void pico.perform(async () => {
              if (!sessionId || creatingSideChat) return;
              const selected = scopeRef.current;
              setCreatingSideChat(true);
              try {
                const x = await pico.request("sideChat.create", {
                  sourceSessionId: sessionId,
                  panelId: Crypto.randomUUID(),
                  idempotencyKey: Crypto.randomUUID(),
                });
                if (scopeRef.current === selected) goSession(x.session.sessionId, sessionId);
              } finally {
                setCreatingSideChat(false);
              }
            })
          }
        />
        <Button
          title="电脑设置"
          quiet
          onPress={() => {
            setToolSheet(false);
            setScreen("settings");
          }}
        />
      </ActionsSheet>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  heading: { flex: 1, minWidth: 0, minHeight: 44, alignItems: "center", justifyContent: "center" },
  brand: { color: color.text, fontSize: 19, fontWeight: "600", letterSpacing: -0.5 },
  conversationPage: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
  error: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  drawerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.22)" },
  drawer: { width: "92%", maxWidth: 480, flex: 1, backgroundColor: color.bg },
  drawerHeader: { paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: color.line },
  drawerFooter: { paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: color.line },
  toolRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
});
