import React, { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { RuntimeSession } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { Button, Card, Chips, Field, Label, s, color } from "./ui";
import { Conversation } from "./Conversation";
import { Workbar } from "./Workbar";
import { SettingsPanel } from "./Settings";
export default function App() {
  const pico = usePico();
  const [screen, setScreen] = useState<
    "computers" | "sessions" | "conversation" | "workbar" | "settings"
  >("computers");
  const [sessionId, setSessionId] = useState<string>();
  useEffect(() => {
    setSessionId(undefined);
    if (pico.workspace) setScreen("sessions");
  }, [pico.host?.id, pico.workspace?.id]);
  const goSession = (id: string) => {
    setSessionId(id);
    setScreen("conversation");
  };
  return (
    <SafeAreaView style={s.page}>
      <StatusBar style="light" />
      <View style={[s.body, { paddingBottom: 10 }]}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Pressable onPress={() => setScreen("computers")}>
            <Text style={s.title}>
              pico<Text style={{ color: color.accent }}> · </Text>
            </Text>
          </Pressable>
          <Text style={{ color: color.accent, fontSize: 12 }}>
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
          </Text>
        </View>
        <Label>{pico.host?.name ?? "连接你的电脑，继续你的工作"}</Label>
        {pico.workspace && screen !== "computers" && (
          <View style={s.row}>
            <Button title="会话" secondary onPress={() => setScreen("sessions")} />
            <Button title="工作区" secondary onPress={() => setScreen("computers")} />
            <Button title="电脑设置" secondary onPress={() => setScreen("settings")} />
            {sessionId && screen === "workbar" && (
              <Button title="返回对话" secondary onPress={() => setScreen("conversation")} />
            )}
          </View>
        )}
        {pico.error && (
          <Card>
            <Text style={{ color: color.danger }}>{pico.error}</Text>
            {pico.host && (
              <Button title="重新连接" secondary onPress={() => void pico.connect(pico.host!)} />
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
      ) : screen === "conversation" && sessionId ? (
        <Conversation
          sessionId={sessionId}
          onSession={goSession}
          onPanel={() => setScreen("workbar")}
        />
      ) : screen === "workbar" && sessionId ? (
        <Workbar sessionId={sessionId} />
      ) : screen === "settings" ? (
        <ScrollView contentContainerStyle={s.body}>
          <SettingsPanel />
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
      <Text style={s.title}>我的电脑</Text>
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
              secondary
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
          <Button title="断开电脑" secondary onPress={pico.disconnect} />
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
    .filter((x) => x.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return (
    <FlatList
      data={list.slice(0, visible)}
      keyExtractor={(x) => x.sessionId}
      contentContainerStyle={s.body}
      onRefresh={() => void pico.perform(refresh)}
      refreshing={false}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <Text style={s.title}>{pico.workspace?.label}</Text>
          <Field label="搜索会话" value={query} onChange={setQuery} />
          <Chips values={["活跃", "全部"] as const} value={archived} onChange={setArchived} />
          <Card>
            <Field
              label={renameId ? "会话新名称" : "新会话名称（可选）"}
              value={title}
              onChange={setTitle}
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
          </Card>
        </View>
      }
      renderItem={({ item }) => (
        <View style={{ marginTop: 14 }}>
          <Card>
            <Pressable onPress={() => onSession(item.sessionId)}>
              <Text style={s.text}>
                {item.pinned ? "★ " : ""}
                {item.title || "未命名会话"}
              </Text>
              <Label>
                {item.status} · {new Date(item.updatedAt).toLocaleString()}
              </Label>
            </Pressable>
            <View style={s.row}>
              <Button title="打开" onPress={() => onSession(item.sessionId)} />
              <Button
                title="改名"
                secondary
                onPress={() => {
                  setRenameId(item.sessionId);
                  setTitle(item.title);
                }}
              />
              <Button
                title={item.pinned ? "取消固定" : "固定"}
                secondary
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
                secondary
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
                secondary
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
          </Card>
        </View>
      )}
      ListFooterComponent={
        visible < list.length ? (
          <Button title="更多会话" secondary onPress={() => setVisible((x) => x + 30)} />
        ) : null
      }
      ListEmptyComponent={<Label>没有匹配的会话。</Label>}
    />
  );
}
