import React, { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { RuntimeResult, RuntimeProviderInput } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Field, Label, s } from "../ui";
import { confirmDelete } from "./confirmDelete";

export function Providers() {
  const pico = usePico();
  const [data, setData] = useState<RuntimeResult<"provider.list">>();
  const [id, setId] = useState("");
  const [url, setUrl] = useState("");
  const [models, setModels] = useState("");
  const [env, setEnv] = useState("");
  const [protocol, setProtocol] = useState<RuntimeProviderInput["protocol"]>("openai");
  const [secret, setSecret] = useState("");
  const [selected, setSelected] = useState<string>();
  async function refresh() {
    setData(await pico.request("provider.list", {}));
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [pico.generation]);
  return (
    <>
      <Card>
        <Text style={s.text}>Provider 配置</Text>
        <Field label="ID" value={id} onChange={setId} />
        <Chips
          values={["openai", "claude", "responses"] as const}
          value={protocol}
          onChange={setProtocol}
        />
        <Field label="API 地址" value={url} onChange={setUrl} />
        <Field label="模型（逗号分隔）" value={models} onChange={setModels} />
        <Field label="密钥环境变量名" value={env} onChange={setEnv} />
        <Button
          title="保存 Provider"
          reason={pico.reason("provider.upsert")}
          onPress={() =>
            void pico.perform(async () => {
              if (!data) throw new Error("先读取配置");
              await pico.request("provider.upsert", {
                provider: {
                  id,
                  protocol,
                  baseURL: url,
                  apiKeyEnv: env,
                  models: models
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                  discoverModels: false,
                },
                expectedRevision: data.revision,
              });
              await refresh();
            })
          }
        />
      </Card>
      {data?.providers.map((provider) => (
        <Card key={provider.id}>
          <Text style={s.text}>
            {provider.id} · {provider.protocol}
          </Text>
          <Label>
            {provider.baseURL} · {provider.credentialStatus}
          </Label>
          <Label>{provider.models.join("、")}</Label>
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              onPress={() => {
                setId(provider.id);
                setProtocol(provider.protocol);
                setUrl(provider.baseURL);
                setEnv(provider.apiKeyEnv);
                setModels(provider.models.join(","));
              }}
            />
            <Button
              title="连接测试"
              secondary
              reason={pico.reason("provider.test")}
              onPress={() =>
                void pico.perform(async () => {
                  const x = await pico.request("provider.test", {
                    providerId: provider.id,
                    model: provider.models[0] ?? "",
                  });
                  Alert.alert(x.ok ? "测试成功" : "测试失败", x.message);
                })
              }
            />
            <Button
              title="设置新密钥"
              reason={pico.reason("provider.credential.set")}
              onPress={() => {
                setSelected(provider.id);
                setSecret("");
              }}
            />
            <Button
              title="删除密钥"
              secondary
              reason={pico.reason("provider.credential.delete")}
              onPress={() =>
                confirmDelete(
                  `${provider.id} 密钥`,
                  () =>
                    void pico.perform(async () => {
                      await pico.request("provider.credential.delete", {
                        providerId: provider.id,
                        expectedRevision: data.revision,
                      });
                      await refresh();
                    }),
                )
              }
            />
            <Button
              title="删除 Provider"
              secondary
              reason={pico.reason("provider.delete")}
              onPress={() =>
                confirmDelete(
                  provider.id,
                  () =>
                    void pico.perform(async () => {
                      await pico.request("provider.delete", {
                        providerId: provider.id,
                        expectedRevision: data.revision,
                      });
                      await refresh();
                    }),
                )
              }
            />
          </View>
        </Card>
      ))}
      {selected && (
        <Card>
          <Field
            label={`${selected} 新密钥（仅写入）`}
            value={secret}
            onChange={setSecret}
            secret
          />
          <Label>手机不读取已有密钥，提交后清空输入。</Label>
          <Button
            title="提交密钥"
            reason={!secret ? "请输入新密钥" : pico.reason("provider.credential.set")}
            onPress={() =>
              void pico.perform(async () => {
                const value = secret;
                setSecret("");
                try {
                  await pico.request("provider.credential.set", {
                    providerId: selected,
                    secret: value,
                    expectedRevision: data!.revision,
                  });
                  setSelected(undefined);
                  await refresh();
                } finally {
                  setSecret("");
                }
              })
            }
          />
          <Button
            title="取消"
            secondary
            onPress={() => {
              setSecret("");
              setSelected(undefined);
            }}
          />
        </Card>
      )}
    </>
  );
}
