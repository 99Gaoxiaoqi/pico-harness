import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import type {
  RuntimeCatalogModel,
  RuntimeSessionSettings,
  RuntimeUserDefaults,
} from "@pico/protocol/mobile";
import { usePico } from "../store";
import { ActionsSheet } from "../ActionsSheet";
import { Button, Chips, Detail, Label, s, color } from "../ui";

export function SessionSettings({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [settings, setSettings] = useState<RuntimeSessionSettings>();
  const [models, setModels] = useState<readonly RuntimeCatalogModel[]>([]);
  const [modelError, setModelError] = useState<string>();
  const [active, setActive] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [selector, setSelector] = useState(false);
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const lock = useRef(false);
  const loadVersion = useRef(0);
  async function load(token = epoch.current) {
    const version = ++loadVersion.current;
    const [x, runs] = await Promise.all([
      pico.request("session.settings.get", { sessionId }),
      pico.request("runs.list", { sessionId }),
    ]);
    if (epoch.current !== token || version !== loadVersion.current) return;
    setSettings(x.settings);
    setActive(runs.runs.some((run) => !["succeeded", "failed", "cancelled"].includes(run.status)));
  }
  useEffect(() => {
    const token = ++epoch.current;
    setSettings(undefined);
    setActive(undefined);
    setModels([]);
    setModelError(undefined);
    setSelector(false);
    void pico.perform(() => load(token));
    const off = pico.onNotification((event) => {
      if (
        event.scope.sessionId === sessionId &&
        ["run.started", "run.updated", "run.finished", "session.settingsUpdated"].includes(
          event.topic,
        )
      )
        void pico.perform(() => load(token));
    });
    const unavailable = pico.reason("catalog.models");
    if (unavailable)
      setModelError(
        unavailable.includes("权限") ? unavailable : "电脑尚未提供模型目录，请更新电脑端。",
      );
    else
      void pico
        .request("catalog.models", {})
        .then((x) => {
          if (epoch.current === token) setModels(x.routes);
        })
        .catch((e) => {
          if (epoch.current === token)
            setModelError(e instanceof Error ? e.message : "模型目录读取失败");
        });
    return () => {
      ++epoch.current;
      off();
    };
  }, [sessionId, pico.generation]);
  const reason = busy
    ? "正在保存"
    : active === undefined
      ? "正在确认会话状态"
      : active
        ? "任务运行中，会话设置只读"
        : pico.reason("session.settings.update");
  async function update(patch: Partial<RuntimeUserDefaults>) {
    if (reason || lock.current) return;
    lock.current = true;
    ++loadVersion.current;
    setBusy(true);
    const token = epoch.current;
    try {
      const x = await pico.request("session.settings.update", { sessionId, ...patch });
      if (token !== epoch.current) return;
      setSettings(x.settings);
      setSelector(false);
      setNotice("已保存电脑返回的会话设置。");
      await load(token);
    } finally {
      lock.current = false;
      if (token === epoch.current) setBusy(false);
    }
  }
  const permissionReason =
    reason ??
    (pico.capabilities?.permissions.includes("host.admin")
      ? undefined
      : "修改权限模式需要电脑管理员授权");
  return (
    <View style={{ gap: 14 }}>
      {reason && <Label>{reason}</Label>}
      <Text accessibilityRole="header" style={s.text}>
        模型
      </Text>
      <Button
        title={settings ? `${settings.model} · ${settings.provider} ▾` : "读取当前模型…"}
        secondary
        reason={reason ?? modelError ?? (!models.length ? "当前项目没有可用模型路由" : undefined)}
        onPress={() => setSelector(true)}
      />
      {settings && <Label>当前路由：{settings.modelRouteId}</Label>}
      {modelError && <Label>{modelError}</Label>}
      <Text style={s.text}>思考等级</Text>
      {settings?.reasoningLevels.length ? (
        <Chips
          values={settings.reasoningLevels}
          value={settings.thinkingEffort}
          disabled={!!reason}
          onChange={(thinkingEffort) => void pico.perform(() => update({ thinkingEffort }))}
        />
      ) : (
        <Label>{settings?.thinkingEffort || "此模型未提供可选等级"}</Label>
      )}
      <Text style={s.text}>协作模式</Text>
      <Chips
        values={["agent", "plan", "research"] as const}
        labels={{ agent: "普通", plan: "计划", research: "研究" }}
        value={settings?.collaborationMode ?? "agent"}
        disabled={!!reason}
        onChange={(collaborationMode) =>
          void pico.perform(() =>
            update({
              collaborationMode,
              ...(collaborationMode === "research" ? { orchestrationMode: "default" } : {}),
            }),
          )
        }
      />
      <Text style={s.text}>编排方式</Text>
      <Chips
        values={["default", "graph", "swarm"] as const}
        labels={{ default: "普通", graph: "任务图", swarm: "协作群" }}
        value={settings?.orchestrationMode ?? "default"}
        disabled={!!reason || settings?.collaborationMode === "research"}
        onChange={(orchestrationMode) => void pico.perform(() => update({ orchestrationMode }))}
      />
      {settings?.collaborationMode === "research" && (
        <Label>研究模式使用普通编排；报告与实施会话分别管理。</Label>
      )}
      <Text style={s.text}>权限模式</Text>
      <Chips
        values={["ask", "auto", "full-access"] as const}
        labels={{ ask: "询问", auto: "自动", "full-access": "完整访问" }}
        value={settings?.permissionMode ?? "ask"}
        disabled={!!permissionReason}
        onChange={(permissionMode) =>
          Alert.alert(
            "修改会话权限？",
            permissionMode === "full-access"
              ? "完整访问将允许电脑执行更多操作，请确认当前项目可信。"
              : permissionMode,
            [
              { text: "返回" },
              { text: "确认", onPress: () => void pico.perform(() => update({ permissionMode })) },
            ],
          )
        }
      />
      {permissionReason && permissionReason !== reason && <Label>{permissionReason}</Label>}
      {!!notice && (
        <Text accessibilityRole="alert" style={s.muted}>
          {notice}
        </Text>
      )}
      <Detail title="会话高级详情" value={settings} />
      <ActionsSheet title="选择模型" open={selector} onClose={() => setSelector(false)}>
        {models.map((model) => (
          <Pressable
            key={model.id}
            accessibilityRole="radio"
            accessibilityState={{
              checked: model.id === settings?.modelRouteId,
              disabled: !!reason,
            }}
            disabled={!!reason}
            onPress={() => void pico.perform(() => update({ modelRouteId: model.id }))}
            style={{
              minHeight: 64,
              gap: 4,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: color.line,
            }}
          >
            <Text style={s.text}>
              {model.displayName ?? model.model}
              {model.id === settings?.modelRouteId ? " · 当前" : ""}
            </Text>
            <Label>
              {model.providerId} · {model.id}
            </Label>
          </Pressable>
        ))}
      </ActionsSheet>
    </View>
  );
}
