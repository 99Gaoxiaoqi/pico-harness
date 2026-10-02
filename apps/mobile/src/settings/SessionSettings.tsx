import React, { useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import type { RuntimeSessionSettings, RuntimeUserDefaults } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s } from "../ui";

export function SessionSettings({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [route, setRoute] = useState("");
  const [effort, setEffort] = useState("");
  async function load() {
    const x = await pico.request("session.settings.get", { sessionId });
    setSettings(x.settings);
    setRoute(x.settings.modelRouteId);
    setEffort(x.settings.thinkingEffort);
  }
  useEffect(() => {
    void pico.perform(load);
  }, [sessionId, pico.generation]);
  async function update(patch: Partial<RuntimeUserDefaults>) {
    const x = await pico.request("session.settings.update", { sessionId, ...patch });
    setSettings(x.settings);
  }
  return (
    <Card>
      <Text style={s.text}>会话设置</Text>
      <Field label="模型路由 ID" value={route} onChange={setRoute} />
      <Field label="思考等级" value={effort} onChange={setEffort} />
      {settings?.reasoningLevels && <Label>可选：{settings.reasoningLevels.join("、")}</Label>}
      <Button
        title="保存模型与思考等级"
        reason={pico.reason("session.settings.update")}
        onPress={() =>
          void pico.perform(() => update({ modelRouteId: route, thinkingEffort: effort }))
        }
      />
      <Label>协作模式</Label>
      <Chips
        values={["agent", "plan", "research"] as const}
        value={settings?.collaborationMode ?? "agent"}
        onChange={(collaborationMode) => void pico.perform(() => update({ collaborationMode }))}
      />
      <Label>编排模式</Label>
      <Chips
        values={["graph", "swarm"] as const}
        value={settings?.orchestrationMode === "swarm" ? "swarm" : "graph"}
        onChange={(orchestrationMode) => void pico.perform(() => update({ orchestrationMode }))}
      />
      <Label>权限模式</Label>
      <Chips
        values={["ask", "auto", "full-access"] as const}
        value={settings?.permissionMode ?? "ask"}
        onChange={(permissionMode) =>
          Alert.alert("修改会话权限？", permissionMode, [
            { text: "返回" },
            { text: "确认", onPress: () => void pico.perform(() => update({ permissionMode })) },
          ])
        }
      />
      <Detail value={settings} />
    </Card>
  );
}
