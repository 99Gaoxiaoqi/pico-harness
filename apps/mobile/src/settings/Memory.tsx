import React, { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Field, Label, s } from "../ui";
import { confirmDelete } from "./confirmDelete";

export function Memory() {
  const pico = usePico();
  const [items, setItems] = useState<RuntimeResult<"memory.list">["items"]>([]);
  const [settings, setSettings] = useState<RuntimeResult<"memory.settings.get">["settings"]>();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<RuntimeResult<"memory.list">["items"][number]>();
  async function refresh() {
    const [a, b] = await Promise.all([
      pico.request("memory.list", { limit: 50, lifecycleStates: ["active", "archived"] }),
      pico.request("memory.settings.get", {}),
    ]);
    setItems(a.items);
    setSettings(b.settings);
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [pico.generation]);
  return (
    <>
      <Card>
        <Text style={s.text}>记忆设置</Text>
        {settings &&
          (["enabled", "autoExtract", "recallEnabled"] as const).map((key) => (
            <View key={key} style={s.row}>
              <Label>
                {{ enabled: "启用", autoExtract: "自动提取", recallEnabled: "召回" }[key]}
              </Label>
              <Switch
                value={settings[key]}
                disabled={!!pico.reason("memory.settings.update")}
                onValueChange={(value) =>
                  void pico.perform(async () => {
                    await pico.request("memory.settings.update", {
                      [key]: value,
                      expectedVersion: settings.version,
                      idempotencyKey: Crypto.randomUUID(),
                    });
                    await refresh();
                  })
                }
              />
            </View>
          ))}
        <Field
          label={editing ? "编辑记忆" : "新增工作区记忆"}
          value={text}
          onChange={setText}
          multiline
        />
        <Button
          title="保存记忆"
          reason={
            !text.trim() ? "请输入内容" : pico.reason(editing ? "memory.update" : "memory.create")
          }
          onPress={() =>
            void pico.perform(async () => {
              if (editing)
                await pico.request("memory.update", {
                  itemId: editing.itemId,
                  content: text,
                  expectedVersion: editing.version,
                  idempotencyKey: Crypto.randomUUID(),
                });
              else await pico.request("memory.create", { text });
              setText("");
              setEditing(undefined);
              await refresh();
            })
          }
        />
      </Card>
      {items.map((item) => (
        <Card key={item.itemId}>
          <Text style={s.text}>{item.content}</Text>
          <Label>
            {item.kind} · {item.scopeType} · {item.lifecycleState}
          </Label>
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              onPress={() => {
                setEditing(item);
                setText(item.content);
              }}
            />
            <Button
              title={item.lifecycleState === "active" ? "归档" : "恢复"}
              secondary
              reason={pico.reason("memory.update")}
              onPress={() =>
                void pico.perform(async () => {
                  await pico.request("memory.update", {
                    itemId: item.itemId,
                    expectedVersion: item.version,
                    lifecycleState: item.lifecycleState === "active" ? "archived" : "active",
                    idempotencyKey: Crypto.randomUUID(),
                  });
                  await refresh();
                })
              }
            />
            <Button
              title="删除"
              secondary
              reason={pico.reason("memory.delete")}
              onPress={() =>
                confirmDelete(
                  "记忆",
                  () =>
                    void pico.perform(async () => {
                      await pico.request("memory.delete", {
                        itemId: item.itemId,
                        expectedVersion: item.version,
                        idempotencyKey: Crypto.randomUUID(),
                      });
                      await refresh();
                    }),
                )
              }
            />
          </View>
        </Card>
      ))}
    </>
  );
}
