import React, { useEffect, useRef, useState } from "react";
import { Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  MAX_SUBAGENT_PRESETS,
  SUBAGENT_PROFILES,
  isSafeSubagentPresetId,
  type RuntimeSubagentPreset,
  type RuntimeSubagentSettingsSnapshot,
} from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s, switchColors } from "../ui";
import { Choices } from "./SettingsNavigation";
import { saveSubagentPresets, subagentForWrite } from "./management";
import { confirmDelete } from "./confirmDelete";

const profiles = { local_read: "代码阅读", web_research: "网络研究", implementation: "实现代码" };
export function Subagents() {
  const pico = usePico();
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const [snapshot, setSnapshot] = useState<RuntimeSubagentSettingsSnapshot>();
  const [editor, setEditor] = useState<{
    preset: RuntimeSubagentPreset;
    revision: string;
    existing: boolean;
  }>();
  const [saving, setSaving] = useState(false);
  async function refresh() {
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const result = await pico.request("subagents.get", {});
    if (version !== readVersion.current || readScope !== currentScope.current) return;
    setSnapshot(result);
  }
  useEffect(() => {
    setSnapshot(undefined);
    setEditor(undefined);
  }, [pico.generation]);
  useEffect(() => {
    if (pico.connected !== false && !pico.reason("subagents.get")) void pico.perform(refresh);
    return () => {
      ++readVersion.current;
    };
  }, [pico.generation, pico.connected, pico.syncRevision]);
  function open(preset?: RuntimeSubagentPreset) {
    if (!snapshot) return;
    const connection = snapshot.connections.find(
      (item) => item.enabled && !item.retired && item.models.some((model) => model.offerable),
    );
    setEditor({
      revision: snapshot.revision,
      existing: !!preset,
      preset: preset
        ? subagentForWrite(preset)
        : {
            id: `agent-${Crypto.randomUUID()}`,
            name: "",
            description: "",
            profile: "local_read",
            connectionSlug: connection?.id ?? "",
            model: connection?.models.find((model) => model.offerable)?.id ?? "",
            enabled: true,
          },
    });
  }
  async function persist(presets: readonly RuntimeSubagentPreset[], revision: string) {
    if (saving) return;
    setSaving(true);
    try {
      setSnapshot(await saveSubagentPresets(pico, presets, revision));
    } finally {
      setSaving(false);
    }
  }
  function patch(
    value: Partial<
      Pick<
        RuntimeSubagentPreset,
        | "name"
        | "description"
        | "profile"
        | "connectionSlug"
        | "model"
        | "thinkingLevel"
        | "enabled"
      >
    >,
  ) {
    if (editor) setEditor({ ...editor, preset: { ...editor.preset, ...value } });
  }
  if (editor && snapshot) {
    const preset = editor.preset;
    const connections = snapshot.connections.filter(
      (connection) => connection.enabled && !connection.retired,
    );
    const connection = connections.find((item) => item.id === preset.connectionSlug);
    const models = connection?.models.filter((item) => item.offerable) ?? [];
    const model = models.find((item) => item.id === preset.model);
    const levels = model?.thinkingLevels ?? [];
    const reason = !isSafeSubagentPresetId(preset.id)
      ? "预设 ID 只能含字母、数字、点、冒号、下划线和短横线"
      : !preset.name.trim()
        ? "填写名称"
        : preset.name.trim().length > 128
          ? "名称最多 128 个字符"
          : preset.description.trim().length > 1000
            ? "描述最多 1000 个字符"
            : preset.enabled && !model
              ? "请选择可用连接与模型"
              : preset.thinkingLevel && !levels.includes(preset.thinkingLevel)
                ? "请选择所选模型的有效思考等级"
                : undefined;
    return (
      <Card>
        <Text style={s.text}>{editor.existing ? "编辑子 Agent" : "新建子 Agent"}</Text>
        <Label>预设保存在这台电脑，供对话选择使用。</Label>
        <Field label="名称" value={preset.name} onChange={(name) => patch({ name })} />
        <Field
          label="描述"
          value={preset.description}
          onChange={(description) => patch({ description })}
          multiline
        />
        <Label>角色</Label>
        <Chips
          values={SUBAGENT_PROFILES}
          value={preset.profile}
          labels={profiles}
          onChange={(profile) => patch({ profile })}
        />
        <Choices
          label="模型连接"
          options={connections.map((item) => ({ value: item.id, label: item.name || item.id }))}
          value={preset.connectionSlug}
          disabled={saving}
          onChange={(connectionSlug) => {
            const next = connections.find((item) => item.id === connectionSlug);
            patch({
              connectionSlug,
              model: next?.models.find((item) => item.offerable)?.id ?? "",
              thinkingLevel: undefined,
            });
          }}
        />
        {!connection && <Label>原连接不可用，请重新选择。</Label>}
        <Choices
          label="模型"
          options={models.map((item) => ({ value: item.id, label: item.id }))}
          value={preset.model}
          disabled={saving}
          onChange={(value) => patch({ model: value, thinkingLevel: undefined })}
        />
        <Label>思考等级</Label>
        <Chips
          values={["", ...levels]}
          value={preset.thinkingLevel ?? ""}
          labels={{ "": "模型默认" }}
          onChange={(thinkingLevel) => patch({ thinkingLevel: thinkingLevel || undefined })}
        />
        <View style={[s.row, { minHeight: 44 }]}>
          <Text style={s.text}>启用此预设</Text>
          <Switch
            {...switchColors}
            hitSlop={8}
            accessibilityLabel="启用子 Agent 预设"
            value={preset.enabled}
            disabled={saving}
            onValueChange={(enabled) => patch({ enabled })}
          />
        </View>
        <Button
          title={saving ? "正在保存…" : "保存预设"}
          reason={saving ? "正在保存" : (reason ?? pico.reason("subagents.update"))}
          onPress={() =>
            void pico.perform(async () => {
              const clean = {
                ...preset,
                name: preset.name.trim(),
                description: preset.description.trim(),
              };
              const next = editor.existing
                ? snapshot.presets.map((item) => (item.id === clean.id ? clean : item))
                : [...snapshot.presets, clean];
              await persist(next, editor.revision);
              setEditor(undefined);
            })
          }
        />
        <Label>按打开时的电脑版本保存；版本冲突时请返回列表、刷新再编辑。</Label>
        <Detail title="预设 ID 与版本" value={{ id: preset.id, revision: editor.revision }} />
        <Button
          title="返回预设列表"
          secondary
          reason={saving ? "正在保存" : undefined}
          onPress={() => setEditor(undefined)}
        />
      </Card>
    );
  }
  return (
    <>
      <Card>
        <Text style={s.text}>子 Agent 预设</Text>
        <Label>管理需要电脑授予配置管理权限。聊天中的 Agent 选择仍可使用普通目录权限。</Label>
        <View style={s.row}>
          <Button
            title="新建预设"
            reason={
              saving
                ? "正在保存"
                : !snapshot
                  ? "等待读取电脑配置"
                  : snapshot.presets.length >= MAX_SUBAGENT_PRESETS
                    ? "最多 64 个预设"
                    : pico.reason("subagents.update")
            }
            onPress={() => open()}
          />
          <Button
            title="刷新"
            secondary
            reason={saving ? "正在保存" : pico.reason("subagents.get")}
            onPress={() => void pico.perform(refresh)}
          />
        </View>
      </Card>
      {snapshot?.presets.length === 0 && <Label>尚未保存子 Agent 预设。</Label>}
      {snapshot?.presets.map((preset) => (
        <Card key={preset.id}>
          <Text style={s.text}>{preset.name}</Text>
          <Label>
            {profiles[preset.profile]} · {preset.connectionSlug}/{preset.model}
          </Label>
          <Text style={s.text}>{preset.description}</Text>
          <Label>
            {preset.enabled ? "已启用" : "已停用"}
            {preset.availability.status === "unavailable" ? ` · ${preset.availability.reason}` : ""}
          </Label>
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              reason={saving ? "正在保存" : pico.reason("subagents.update")}
              onPress={() => open(preset)}
            />
            <Button
              title={preset.enabled ? "停用" : "启用"}
              secondary
              reason={saving ? "正在保存" : pico.reason("subagents.update")}
              onPress={() =>
                void pico.perform(() =>
                  persist(
                    snapshot.presets.map((item) =>
                      item.id === preset.id ? { ...item, enabled: !item.enabled } : item,
                    ),
                    snapshot.revision,
                  ),
                )
              }
            />
            <Button
              title="删除"
              secondary
              reason={saving ? "正在保存" : pico.reason("subagents.update")}
              onPress={() =>
                confirmDelete(
                  preset.name,
                  () =>
                    void pico.perform(() =>
                      persist(
                        snapshot.presets.filter((item) => item.id !== preset.id),
                        snapshot.revision,
                      ),
                    ),
                )
              }
            />
          </View>
        </Card>
      ))}
    </>
  );
}
