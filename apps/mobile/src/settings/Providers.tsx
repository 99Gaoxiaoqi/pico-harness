import React, { useEffect, useRef, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import type { RuntimeResult, RuntimeProviderInput } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s } from "../ui";
import { confirmDelete } from "./confirmDelete";
import { availableProviderModels, providerInput } from "./management";

type Provider = RuntimeResult<"provider.list">["providers"][number];
export function Providers() {
  const pico = usePico();
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const [data, setData] = useState<RuntimeResult<"provider.list">>();
  const [editor, setEditor] = useState<{
    value: RuntimeProviderInput;
    revision: string;
    isNew: boolean;
    available: string[];
    modelsText: string;
  }>();
  const [secret, setSecret] = useState("");
  const [selected, setSelected] = useState<{ id: string; revision: string }>();
  const [saving, setSaving] = useState(false);
  async function refresh() {
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const result = await pico.request("provider.list", {});
    if (version !== readVersion.current || readScope !== currentScope.current) return;
    setData(result);
  }
  useEffect(() => {
    setData(undefined);
    setEditor(undefined);
    setSelected(undefined);
    setSecret("");
  }, [pico.generation]);
  useEffect(() => {
    if (pico.connected !== false && !pico.reason("provider.list")) void pico.perform(refresh);
    return () => {
      ++readVersion.current;
    };
  }, [pico.generation, pico.connected, pico.syncRevision]);
  function open(provider?: Provider) {
    if (!data) return;
    setSelected(undefined);
    setSecret("");
    setEditor({
      revision: data.revision,
      isNew: !provider,
      available: provider ? availableProviderModels(provider) : [],
      modelsText: provider?.models.join(", ") ?? "",
      value: provider
        ? providerInput(provider)
        : {
            id: "",
            protocol: "openai",
            baseURL: "",
            apiKeyEnv: "",
            models: [],
            discoverModels: false,
          },
    });
  }
  function patch(
    value: Partial<
      Pick<
        RuntimeProviderInput,
        "id" | "protocol" | "baseURL" | "apiKeyEnv" | "models" | "disabledModels" | "discoverModels"
      >
    >,
  ) {
    if (editor) setEditor({ ...editor, value: { ...editor.value, ...value } });
  }
  async function mutate(task: () => Promise<unknown>) {
    if (saving) return;
    setSaving(true);
    try {
      await task();
      await refresh();
    } finally {
      setSaving(false);
    }
  }
  if (selected)
    return (
      <Card>
        <Text style={s.text}>设置 {selected.id} 新密钥</Text>
        <Field label="新密钥（仅写入）" value={secret} onChange={setSecret} secret />
        <Label>手机不读取已有密钥。提交后清空输入，取消也会清空。</Label>
        <Button
          title={saving ? "正在提交…" : "提交密钥"}
          reason={
            saving ? "正在保存" : !secret ? "请输入新密钥" : pico.reason("provider.credential.set")
          }
          onPress={() =>
            void pico.perform(() =>
              mutate(async () => {
                const value = secret;
                setSecret("");
                try {
                  await pico.request("provider.credential.set", {
                    providerId: selected.id,
                    secret: value,
                    expectedRevision: selected.revision,
                  });
                  setSelected(undefined);
                } finally {
                  setSecret("");
                }
              }),
            )
          }
        />
        <Button
          title="取消并返回连接列表"
          secondary
          reason={saving ? "正在保存" : undefined}
          onPress={() => {
            setSecret("");
            setSelected(undefined);
          }}
        />
      </Card>
    );
  if (editor) {
    const value = editor.value,
      models = [...new Set([...editor.available, ...value.models])];
    return (
      <Card>
        <Text style={s.text}>{editor.isNew ? "新建模型连接" : `编辑 ${value.id}`}</Text>
        {editor.isNew ? (
          <Field label="连接 ID" value={value.id} onChange={(id) => patch({ id })} />
        ) : (
          <Label>连接 ID：{value.id}</Label>
        )}
        <Label>协议</Label>
        <Chips
          values={["openai", "claude", "responses"] as const}
          value={value.protocol}
          labels={{ openai: "OpenAI 兼容", claude: "Anthropic", responses: "Responses" }}
          onChange={(protocol) => patch({ protocol })}
        />
        <Field label="API 地址" value={value.baseURL} onChange={(baseURL) => patch({ baseURL })} />
        <Field
          label="手动模型（逗号分隔）"
          value={editor.modelsText}
          onChange={(text) =>
            setEditor({
              ...editor,
              modelsText: text,
              value: {
                ...value,
                models: text
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              },
            })
          }
        />
        <Field
          label="密钥环境变量名"
          value={value.apiKeyEnv}
          onChange={(apiKeyEnv) => patch({ apiKeyEnv })}
        />
        <View style={[s.row, { minHeight: 44 }]}>
          <Text style={s.text}>由电脑发现模型目录</Text>
          <Switch
            hitSlop={8}
            accessibilityLabel="发现模型目录"
            value={value.discoverModels}
            disabled={saving}
            onValueChange={(discoverModels) => patch({ discoverModels })}
          />
        </View>
        <Label>模型启用状态</Label>
        {models.length === 0 && <Label>先填写模型；发现目录需保存后刷新。</Label>}
        {models.map((model) => (
          <View key={model} style={[s.row, { minHeight: 44, justifyContent: "space-between" }]}>
            <Text style={[s.text, { flex: 1 }]}>{model}</Text>
            <Switch
              hitSlop={8}
              accessibilityLabel={`启用模型 ${model}`}
              disabled={saving}
              value={!value.disabledModels?.includes(model)}
              onValueChange={(enabled) =>
                patch({
                  disabledModels: enabled
                    ? (value.disabledModels ?? []).filter((item) => item !== model)
                    : [...new Set([...(value.disabledModels ?? []), model])],
                })
              }
            />
          </View>
        ))}
        <Button
          title={saving ? "正在保存…" : "保存连接"}
          reason={
            saving
              ? "正在保存"
              : !value.id.trim() || !value.baseURL.trim()
                ? "填写连接 ID 和 API 地址"
                : pico.reason("provider.upsert")
          }
          onPress={() =>
            void pico.perform(() =>
              mutate(async () => {
                await pico.request("provider.upsert", {
                  provider: value,
                  expectedRevision: editor.revision,
                });
                setEditor(undefined);
              }),
            )
          }
        />
        <Label>未修改的授权方式、模型能力和分模型协议保留。版本冲突时返回列表刷新后再编辑。</Label>
        <Button
          title="返回连接列表"
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
        <Text style={s.text}>模型连接</Text>
        <Label>配置保存在电脑；目录和密钥管理需要配置管理权限。</Label>
        <View style={s.row}>
          <Button
            title="新增连接"
            reason={!data ? "等待读取配置" : pico.reason("provider.upsert")}
            onPress={() => open()}
          />
          <Button
            title="刷新"
            secondary
            reason={saving ? "正在保存" : pico.reason("provider.list")}
            onPress={() => void pico.perform(refresh)}
          />
        </View>
      </Card>
      {data?.providers.length === 0 && <Label>暂无用户模型连接。</Label>}
      {data?.providers.map((provider) => (
        <Card key={provider.id}>
          <Text style={s.text}>
            {provider.id} · {provider.protocol}
          </Text>
          <Label>
            {provider.credentialStatus} ·{" "}
            {
              availableProviderModels(provider).filter(
                (model) => !provider.disabledModels?.includes(model),
              ).length
            }{" "}
            个已启用模型
          </Label>
          <Label>{provider.models.join("、") || "由电脑发现模型"}</Label>
          <Detail title="连接与模型详情" value={provider} />
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              reason={saving ? "正在保存" : pico.reason("provider.upsert")}
              onPress={() => open(provider)}
            />
            <Button
              title="连接测试"
              secondary
              reason={saving ? "正在保存" : pico.reason("provider.test")}
              onPress={() =>
                void pico.perform(async () => {
                  const model = availableProviderModels(provider).find(
                    (item) => !provider.disabledModels?.includes(item),
                  );
                  if (!model) throw new Error("先启用至少一个模型");
                  const result = await pico.request("provider.test", {
                    providerId: provider.id,
                    model,
                  });
                  Alert.alert(result.ok ? "测试成功" : "测试失败", result.message);
                })
              }
            />
            <Button
              title="设置新密钥"
              reason={saving ? "正在保存" : pico.reason("provider.credential.set")}
              onPress={() => {
                setSelected({ id: provider.id, revision: data.revision });
                setSecret("");
              }}
            />
            <Button
              title="删除密钥"
              secondary
              reason={saving ? "正在保存" : pico.reason("provider.credential.delete")}
              onPress={() =>
                confirmDelete(
                  `${provider.id} 密钥`,
                  () =>
                    void pico.perform(() =>
                      mutate(() =>
                        pico.request("provider.credential.delete", {
                          providerId: provider.id,
                          expectedRevision: data.revision,
                        }),
                      ),
                    ),
                )
              }
            />
            <Button
              title="删除连接"
              secondary
              reason={saving ? "正在保存" : pico.reason("provider.delete")}
              onPress={() =>
                confirmDelete(
                  provider.id,
                  () =>
                    void pico.perform(() =>
                      mutate(() =>
                        pico.request("provider.delete", {
                          providerId: provider.id,
                          expectedRevision: data.revision,
                        }),
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
