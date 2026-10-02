import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import type { RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Detail, Field, s } from "../ui";

export function Defaults() {
  const pico = usePico();
  const [data, setData] = useState<RuntimeResult<"config.user.get">>();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  useEffect(() => {
    void pico.perform(async () => {
      const x = await pico.request("config.user.get", {});
      setData(x);
      setModel(x.config.defaults.modelRouteId ?? "");
      setEffort(x.config.defaults.thinkingEffort ?? "");
    });
  }, [pico.generation]);
  return (
    <Card>
      <Text style={s.text}>电脑默认设置</Text>
      <Field label="模型路由" value={model} onChange={setModel} />
      <Field label="思考等级" value={effort} onChange={setEffort} />
      <Button
        title="保存默认设置"
        reason={pico.reason("config.user.update")}
        onPress={() =>
          void pico.perform(async () => {
            const x = await pico.request("config.user.update", {
              defaults: { ...data!.config.defaults, modelRouteId: model, thinkingEffort: effort },
              expectedRevision: data!.revision,
            });
            setData(x);
          })
        }
      />
      <Detail value={data?.config.defaults} />
    </Card>
  );
}
