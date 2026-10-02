import React, { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { usePico } from "./store";
import { Button, Card, Label, s, color } from "./ui";
import { Conversation } from "./Conversation";
import { MessageMediaProvider } from "./MessageMedia";
import { Workbar, type WorkbarTab } from "./Workbar";
import { SettingsPanel } from "./Settings";
import { Computers } from "./screens/Computers";
import { Sessions } from "./screens/Sessions";
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
            <MessageMediaProvider sessionId={sessionId} active={screen === "conversation"}>
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
            </MessageMediaProvider>
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
});
