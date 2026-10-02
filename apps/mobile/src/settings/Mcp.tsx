import React, { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { RuntimeResult } from "@pico/protocol/mobile";
import type { RemoteSecretEdits, RemoteMcpServerInput } from "@pico/protocol/remote";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s } from "../ui";
import { confirmDelete } from "./confirmDelete";

export function Mcp() {
  const pico = usePico();
  const [data, setData] = useState<RuntimeResult<"mcp.user.list">>();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("http");
  const [endpoint, setEndpoint] = useState("");
  const [connectionAction, setConnectionAction] = useState<"keep" | "set" | "remove">("set");
  const [args, setArgs] = useState("");
  const [replaceArgs, setReplaceArgs] = useState(false);
  const [secretKey, setSecretKey] = useState("");
  const [secret, setSecret] = useState("");
  const [secretAction, setSecretAction] = useState<"keep" | "set" | "remove">("keep");
  async function refresh() {
    setData(await pico.request("mcp.user.list", {}));
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [pico.generation]);
  function reset() {
    setEditing(false);
    setName("");
    setEndpoint("");
    setArgs("");
    setReplaceArgs(false);
    setConnectionAction("set");
    setSecret("");
    setSecretKey("");
    setSecretAction("keep");
  }
  async function save() {
    if (!data) throw new Error("先读取配置");
    if (!name.trim()) throw new Error("请输入服务器名称");
    if (!editing && !endpoint.trim()) throw new Error("新服务器需要完整连接地址或命令");
    if (connectionAction === "set" && !endpoint.trim())
      throw new Error("替换连接信息需要输入完整值");
    const server: RemoteMcpServerInput =
      transport === "stdio"
        ? {
            name,
            transport,
            ...(connectionAction === "set" ? { command: endpoint } : {}),
            ...(!editing || replaceArgs ? { args: args.split("\n").filter(Boolean) } : {}),
          }
        : { name, transport, ...(!editing ? { url: endpoint } : {}) };
    const edit =
      secretAction === "set" ? { action: "set" as const, value: secret } : { action: secretAction };
    const edits: RemoteSecretEdits = {
      ...(secretKey ? { [transport === "stdio" ? "env" : "headers"]: { [secretKey]: edit } } : {}),
      ...(editing && transport !== "stdio"
        ? {
            url:
              connectionAction === "set"
                ? { action: "set" as const, value: endpoint }
                : { action: connectionAction },
          }
        : {}),
    };
    setSecret("");
    try {
      await pico.requestWithSecrets(
        "mcp.user.upsert",
        { server, expectedRevision: data.revision, idempotencyKey: Crypto.randomUUID() },
        edits,
      );
      reset();
      await refresh();
    } finally {
      setSecret("");
    }
  }
  return (
    <>
      <Card>
        <Text style={s.text}>{editing ? "编辑现有 MCP（未修改字段保留）" : "新建 MCP"}</Text>
        {editing ? (
          <Label>
            服务器：{name} · {transport}
          </Label>
        ) : (
          <>
            <Field label="名称" value={name} onChange={setName} />
            <Chips
              values={["stdio", "http", "sse"] as const}
              value={transport}
              onChange={setTransport}
            />
          </>
        )}
        {editing && (
          <>
            <Label>连接信息：保留 / 替换 / 删除 URL 中的凭据</Label>
            <Chips
              values={
                transport === "stdio"
                  ? (["keep", "set"] as const)
                  : (["keep", "set", "remove"] as const)
              }
              value={connectionAction}
              onChange={setConnectionAction}
            />
          </>
        )}
        {connectionAction === "set" && (
          <Field
            label={transport === "stdio" ? "完整可执行命令" : "完整服务器 URL（仅写入）"}
            value={endpoint}
            onChange={setEndpoint}
            secret={transport !== "stdio"}
          />
        )}
        {editing && connectionAction === "keep" && (
          <Label>完整命令、参数和 URL 保留在电脑，不用脱敏显示值覆盖。</Label>
        )}
        {transport === "stdio" && (
          <>
            {editing && (
              <View style={s.row}>
                <Label>替换参数列表</Label>
                <Switch value={replaceArgs} onValueChange={setReplaceArgs} />
              </View>
            )}
            {(!editing || replaceArgs) && (
              <Field
                label="参数（每行一个，留空清空参数）"
                value={args}
                onChange={setArgs}
                multiline
              />
            )}
          </>
        )}
        <Field
          label={transport === "stdio" ? "环境变量名称（可选）" : "Header 名称（可选）"}
          value={secretKey}
          onChange={setSecretKey}
        />
        <Chips
          values={["keep", "set", "remove"] as const}
          value={secretAction}
          onChange={setSecretAction}
        />
        <Label>keep 保留；set 替换；remove 删除。已有秘密不返回手机。</Label>
        {secretAction === "set" && (
          <Field label="新秘密值" secret value={secret} onChange={setSecret} />
        )}
        <Button
          title="保存 MCP"
          reason={pico.reason("mcp.user.upsert")}
          onPress={() => void pico.perform(save)}
        />
        <Button title="取消 / 新建" secondary onPress={reset} />
      </Card>
      {data?.servers.map((server) => (
        <Card key={server.name}>
          <Text style={s.text}>
            {server.name} · {server.transport}
          </Text>
          <Label>
            {String("endpointLabel" in server ? server.endpointLabel : server.commandLabel)}
          </Label>
          <Detail value={server} />
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              reason={pico.reason("mcp.user.upsert")}
              onPress={() => {
                setEditing(true);
                setName(server.name);
                setTransport(server.transport);
                setConnectionAction("keep");
                setEndpoint("");
                setArgs("");
                setReplaceArgs(false);
                setSecretKey("");
                setSecret("");
                setSecretAction("keep");
              }}
            />
            <Button
              title={server.enabled === false ? "启用" : "停用"}
              secondary
              reason={pico.reason("mcp.user.setEnabled")}
              onPress={() =>
                void pico.perform(async () => {
                  await pico.request("mcp.user.setEnabled", {
                    serverName: server.name,
                    enabled: server.enabled === false,
                    expectedRevision: data.revision,
                    idempotencyKey: Crypto.randomUUID(),
                  });
                  await refresh();
                })
              }
            />
            <Button
              title="删除"
              secondary
              reason={pico.reason("mcp.user.delete")}
              onPress={() =>
                confirmDelete(
                  server.name,
                  () =>
                    void pico.perform(async () => {
                      await pico.request("mcp.user.delete", {
                        serverName: server.name,
                        expectedRevision: data.revision,
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
