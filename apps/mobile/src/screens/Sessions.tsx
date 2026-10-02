import React, { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { RuntimeSession } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Chips, Field, Label, s, color } from "../ui";

export function Sessions({ onSession }: { onSession: (id: string) => void }) {
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
  sectionTitle: { color: color.text, fontSize: 20, fontWeight: "600", letterSpacing: -0.3 },
  sessionComposer: { padding: 12, gap: 10, borderRadius: 12, backgroundColor: color.surface },
  sessionItem: { paddingVertical: 12, gap: 6, borderTopWidth: 1, borderTopColor: color.line },
  sessionManage: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  navigationText: { color: color.muted, fontSize: 13, fontWeight: "500" },
});
