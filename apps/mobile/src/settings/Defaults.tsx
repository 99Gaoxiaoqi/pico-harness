import React, { useEffect, useRef, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Label, s, switchColors } from "../ui";
import { Choices } from "./SettingsNavigation";
import { modelChoices, saveUserDefaults } from "./management";

export function Defaults() {
  const pico = usePico();
  const [data, setData] = useState<RuntimeResult<"config.user.get">>();
  const [providers, setProviders] = useState<RuntimeResult<"provider.list">["providers"]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [search, setSearch] = useState(false);
  const [searchSource, setSearchSource] = useState<"model" | "external">("model");
  const [saving, setSaving] = useState(false);
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const currentGeneration = useRef(pico.generation);
  currentGeneration.current = pico.generation;
  const draft = useRef<RuntimeResult<"config.user.get"> | undefined>(undefined);
  function edit(change: () => void) {
    draft.current ??= data;
    change();
  }
  async function refresh() {
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const [config, connections] = await Promise.all([
      pico.request("config.user.get", {}),
      pico.request("provider.list", {}),
    ]);
    if (version !== readVersion.current || readScope !== currentScope.current) return;
    setData(config);
    setProviders(connections.providers);
    if (draft.current) return;
    setModel(config.config.defaults.modelRouteId ?? "");
    setEffort(config.config.defaults.thinkingEffort ?? "");
    setSearch(config.config.defaults.webSearch?.enabled ?? false);
    setSearchSource(config.config.defaults.webSearch?.source ?? "model");
  }
  useEffect(() => {
    setData(undefined);
    setProviders([]);
    draft.current = undefined;
    setModel("");
    setEffort("");
    setSearch(false);
    setSearchSource("model");
    setSaving(false);
  }, [pico.generation]);
  useEffect(() => {
    if (
      pico.connected !== false &&
      !pico.reason("config.user.get") &&
      !pico.reason("provider.list")
    )
      void pico.perform(refresh);
    return () => {
      ++readVersion.current;
    };
  }, [pico.generation, pico.connected, pico.syncRevision]);
  const choices = modelChoices(providers),
    levels = choices.find((item) => item.id === model)?.reasoningLevels ?? [];
  const unavailable = model && !choices.some((item) => item.id === model);
  const invalidEffort = !!model && !!effort && !levels.includes(effort);
  return (
    <Card>
      <Text style={s.text}>新对话默认行为</Text>
      <Label>保存在所连接电脑，供后续新对话使用；当前对话不随此改变。</Label>
      <Button
        title="刷新电脑配置"
        secondary
        reason={saving ? "正在保存" : pico.reason("config.user.get")}
        onPress={() => void pico.perform(refresh)}
      />
      <Choices
        label="默认模型"
        value={model}
        disabled={saving}
        options={[
          { value: "", label: "使用电脑默认选择" },
          ...choices.map((item) => ({ value: item.id, label: item.label })),
        ]}
        onChange={(value) => {
          edit(() => {
            setModel(value);
            setEffort("");
          });
        }}
      />
      {unavailable && <Label>原默认路由 {model} 当前不可选，请重新选择或在电脑检查配置。</Label>}
      <Chips
        values={["", ...(!model && effort ? [effort] : levels)]}
        value={effort}
        labels={{ "": "模型默认等级" }}
        onChange={(value) => edit(() => setEffort(value))}
      />
      {invalidEffort && <Label>原思考等级 {effort} 当前不可用，请重新选择。</Label>}
      <View style={[s.row, { minHeight: 44 }]}>
        <Text style={s.text}>联网搜索</Text>
        <Switch
          {...switchColors}
          hitSlop={8}
          accessibilityLabel="新对话默认联网搜索"
          value={search}
          disabled={saving || !!pico.reason("config.user.update")}
          onValueChange={(value) => edit(() => setSearch(value))}
        />
      </View>
      {search && (
        <Chips
          values={["model", "external"] as const}
          value={searchSource}
          labels={{ model: "模型搜索", external: "外部搜索" }}
          onChange={(value) => edit(() => setSearchSource(value))}
        />
      )}
      <Label>搜索可用性仍由所选模型与电脑配置决定。</Label>
      <Button
        title={saving ? "正在保存…" : "保存默认行为"}
        reason={
          saving
            ? "正在保存"
            : !data
              ? "等待读取电脑配置"
              : unavailable
                ? "请选择当前可用的模型"
                : invalidEffort
                  ? "请选择有效思考等级"
                  : pico.reason("config.user.update")
        }
        onPress={() =>
          void pico.perform(async () => {
            if (!data) return;
            const generation = pico.generation;
            ++readVersion.current;
            setSaving(true);
            try {
              const next = await saveUserDefaults(pico, draft.current ?? data, {
                modelRouteId: model || undefined,
                thinkingEffort: effort || undefined,
                webSearch: { enabled: search, source: searchSource },
              });
              if (generation !== currentGeneration.current) return;
              ++readVersion.current;
              draft.current = undefined;
              setData(next);
            } finally {
              if (generation === currentGeneration.current) setSaving(false);
            }
          })
        }
      />
      <Detail title="原始默认配置" value={data?.config.defaults} />
    </Card>
  );
}
