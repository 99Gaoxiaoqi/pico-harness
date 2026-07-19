import { Stack } from "expo-router";
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
import type { MobileProject } from "@pico/protocol";
import { MobileGatewayClient } from "../lib/mobile-gateway-client";

const GATEWAY_ORIGIN_KEY = "pico.mobile.gatewayOrigin";
const GATEWAY_TOKEN_KEY = "pico.mobile.gatewayToken";
const DEFAULT_GATEWAY_ORIGIN =
  Platform.OS === "android" ? "http://10.0.2.2:47831" : "http://127.0.0.1:47831";

type ConnectionPhase = "idle" | "connecting" | "connected" | "error";

export default function ProjectsScreen() {
  const [origin, setOrigin] = useState(DEFAULT_GATEWAY_ORIGIN);
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<readonly MobileProject[]>([]);
  const [phase, setPhase] = useState<ConnectionPhase>("idle");
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
      setPhase("connected");
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

  return (
    <>
      <Stack.Screen options={{ title: "项目" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.intro}>
          <Text style={styles.eyebrow}>PICO MOBILE</Text>
          <Text selectable style={styles.title}>
            从手机继续你的项目
          </Text>
          <Text selectable style={styles.subtitle}>
            Gateway 仅在本机回环地址运行，手机端不会获取 Desktop Runtime 凭证。
          </Text>
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeading}>
            <Text style={styles.panelTitle}>连接 Desktop</Text>
            <View style={[styles.statusDot, styles[`status_${phase}`]]} />
          </View>
          <Text style={styles.label}>Gateway 地址</Text>
          <TextInput
            accessibilityLabel="Gateway 地址"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setOrigin}
            placeholder={DEFAULT_GATEWAY_ORIGIN}
            style={styles.input}
            value={origin}
          />
          <Text style={styles.label}>临时 Token</Text>
          <TextInput
            accessibilityLabel="Gateway 临时 Token"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setToken}
            onSubmitEditing={() => void connect()}
            placeholder="从 Mobile Gateway 运行输出中复制"
            returnKeyType="go"
            secureTextEntry
            style={styles.input}
            value={token}
          />
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
              <ActivityIndicator color="#FFFFFF" />
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

        {projects.length > 0 && (
          <View style={styles.projectSection}>
            <Text style={styles.sectionTitle}>项目</Text>
            {projects.map((project) => (
              <View key={project.projectId} style={styles.projectCard}>
                <View style={styles.projectMark}>
                  <Text style={styles.projectMarkText}>
                    {project.name.slice(0, 1).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.projectCopy}>
                  <Text numberOfLines={1} style={styles.projectName}>
                    {project.name}
                  </Text>
                  <Text style={styles.projectMeta}>已信任·可从手机访问</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 24,
    padding: 20,
    paddingBottom: 48,
  },
  intro: { gap: 8, paddingTop: 8 },
  eyebrow: { color: "#208AEF", fontSize: 12, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: "#17171A", fontSize: 30, fontWeight: "700", letterSpacing: -0.7 },
  subtitle: { color: "#68686E", fontSize: 15, lineHeight: 22 },
  panel: {
    backgroundColor: "#F4F4F6",
    borderColor: "#E6E6E9",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    padding: 16,
  },
  panelHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  panelTitle: { color: "#222226", fontSize: 17, fontWeight: "700" },
  statusDot: { borderRadius: 5, height: 10, width: 10 },
  status_idle: { backgroundColor: "#A1A1A8" },
  status_connecting: { backgroundColor: "#E5A530" },
  status_connected: { backgroundColor: "#35A563" },
  status_error: { backgroundColor: "#D94A4A" },
  label: { color: "#56565C", fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#DDDEE2",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    color: "#17171A",
    fontSize: 15,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 4,
    minHeight: 48,
  },
  buttonPressed: { opacity: 0.82 },
  buttonDisabled: { opacity: 0.65 },
  buttonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  message: { color: "#68686E", fontSize: 13, lineHeight: 18 },
  errorMessage: { color: "#B42323" },
  projectSection: { gap: 10 },
  sectionTitle: { color: "#29292D", fontSize: 18, fontWeight: "700" },
  projectCard: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderColor: "#E8E8EB",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  projectMark: {
    alignItems: "center",
    backgroundColor: "#E7F2FD",
    borderRadius: 12,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  projectMarkText: { color: "#176FB8", fontSize: 16, fontWeight: "800" },
  projectCopy: { flex: 1, gap: 3 },
  projectName: { color: "#202024", fontSize: 16, fontWeight: "700" },
  projectMeta: { color: "#77777D", fontSize: 13 },
});
