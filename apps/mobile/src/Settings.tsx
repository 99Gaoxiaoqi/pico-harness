import React, { useEffect, useState } from "react";
import { Alert, Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type {
  RuntimeResult,
  RuntimeSessionSettings,
  RuntimeUserDefaults,
  RuntimeProviderInput,
} from "@pico/protocol/mobile";
import type { RemoteSecretEdits, RemoteMcpServerInput } from "@pico/protocol/remote";
import { usePico } from "./store";
import { Button, Card, Chips, Detail, Field, Label, s } from "./ui";
const sections = [
  "自动化",
  "记忆",
  "Provider",
  "MCP",
  "Skills",
  "Hooks",
  "插件",
  "默认设置",
] as const;
export function SettingsPanel() {
  const [section, setSection] = useState<(typeof sections)[number]>("自动化");
  return (
    <View style={{ gap: 14 }}>
      <Chips values={sections} value={section} onChange={setSection} />
      {section === "自动化" ? (
        <Jobs />
      ) : section === "记忆" ? (
        <Memory />
      ) : section === "Provider" ? (
        <Providers />
      ) : section === "MCP" ? (
        <Mcp />
      ) : section === "默认设置" ? (
        <Defaults />
      ) : (
        <Capabilities key={section} section={section} />
      )}
    </View>
  );
}
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
function Jobs() {
  const pico = usePico();
  const [jobs, setJobs] = useState<RuntimeResult<"jobs.list">["jobs"]>([]);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [history, setHistory] = useState<RuntimeResult<"jobs.history">["runs"]>();
  async function refresh() {
    setJobs((await pico.request("jobs.list", {})).jobs);
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [pico.generation]);
  return (
    <>
      <Card>
        <Text style={s.text}>{editing ? "编辑自动化" : "新建自动化"}</Text>
        <Field label="名称" value={name} onChange={setName} />
        <Field label="任务说明" value={prompt} onChange={setPrompt} multiline />
        <Field label="Cron 日程" value={schedule} onChange={setSchedule} placeholder="0 9 * * *" />
        <Button
          title="保存"
          reason={
            !name || !prompt || !schedule
              ? "填写名称、任务和日程"
              : pico.reason(editing ? "jobs.update" : "jobs.create")
          }
          onPress={() =>
            void pico.perform(async () => {
              if (editing)
                await pico.request("jobs.update", { jobId: editing, name, prompt, schedule });
              else await pico.request("jobs.create", { name, prompt, schedule, enabled: false });
              setEditing(undefined);
              setName("");
              setPrompt("");
              setSchedule("");
              await refresh();
            })
          }
        />
        <Label>新任务默认关闭；电脑会重新检查后台执行授权与凭据。</Label>
      </Card>
      {jobs.map((job) => (
        <Card key={job.jobId}>
          <Text style={s.text}>{job.name}</Text>
          <Label>
            {job.schedule} · {job.status}
          </Label>
          <Text style={s.text}>{job.prompt}</Text>
          <View style={s.row}>
            <Label>启用</Label>
            <Switch
              value={job.enabled}
              disabled={!!pico.reason("jobs.setEnabled")}
              onValueChange={(enabled) =>
                void pico.perform(async () => {
                  await pico.request("jobs.setEnabled", { jobId: job.jobId, enabled });
                  await refresh();
                })
              }
            />
            <Button
              title="编辑"
              secondary
              onPress={() => {
                setEditing(job.jobId);
                setName(job.name);
                setPrompt(job.prompt);
                setSchedule(job.schedule);
              }}
            />
            <Button
              title="立即运行"
              reason={pico.reason("jobs.runNow")}
              onPress={() =>
                void pico.perform(() => pico.request("jobs.runNow", { jobId: job.jobId }))
              }
            />
            <Button
              title="历史"
              secondary
              onPress={() =>
                void pico.perform(async () =>
                  setHistory(
                    (await pico.request("jobs.history", { jobId: job.jobId, limit: 20 })).runs,
                  ),
                )
              }
            />
            <Button
              title="删除"
              secondary
              reason={pico.reason("jobs.delete")}
              onPress={() =>
                confirmDelete(
                  job.name,
                  () =>
                    void pico.perform(async () => {
                      await pico.request("jobs.delete", { jobId: job.jobId });
                      await refresh();
                    }),
                )
              }
            />
          </View>
        </Card>
      ))}
      {history && (
        <Card>
          <Text style={s.text}>执行历史</Text>
          {history.map((run) => (
            <Text key={run.runId} style={s.text}>
              {run.description} · {run.status}
            </Text>
          ))}
        </Card>
      )}
    </>
  );
}
function Memory() {
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
function Providers() {
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
function Mcp() {
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
function Defaults() {
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
function Capabilities({ section }: { section: "Skills" | "Hooks" | "插件" }) {
  const pico = usePico();
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [detail, setDetail] = useState<unknown>();
  const [id, setId] = useState("");
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  const [skillsScope, setSkillsScope] = useState<"生效列表" | "用户列表">("生效列表");
  const [proposal, setProposal] = useState<{
    confirmId: string;
    fingerprint: string;
    pluginId: string;
    scope: "user" | "project" | "local";
  }>();
  async function refresh() {
    if (section === "Skills") {
      setData([
        ...(skillsScope === "用户列表"
          ? (await pico.request("skills.user.list", {})).skills
          : (await pico.request("skills.effective.list", {})).skills),
      ]);
      return;
    }
    const x =
      section === "Hooks"
        ? (await pico.request("hooks.manage", { action: "list" })).result
        : (await pico.request("plugin.manage", { action: "list" })).result;
    const list = Object.values(x).find(Array.isArray);
    setData(Array.isArray(list) ? (list as Record<string, unknown>[]) : []);
    setDetail(x);
  }
  useEffect(() => {
    setData([]);
    setProposal(undefined);
    void pico.perform(refresh);
  }, [section, pico.generation, skillsScope]);
  function select(item: Record<string, unknown>) {
    const installed =
      typeof item.installed === "object" && item.installed
        ? (item.installed as Record<string, unknown>)
        : item;
    setId(String(installed.id ?? item.handlerId ?? ""));
    if (["user", "project", "local"].includes(String(installed.scope)))
      setScope(installed.scope as "user" | "project" | "local");
    setProposal(undefined);
  }
  return (
    <>
      <Button title="刷新" secondary onPress={() => void pico.perform(refresh)} />
      {section === "Skills" && (
        <Chips
          values={["生效列表", "用户列表"] as const}
          value={skillsScope}
          onChange={setSkillsScope}
        />
      )}
      {data.map((item, i) => {
        const installed =
          typeof item.installed === "object" && item.installed
            ? (item.installed as Record<string, unknown>)
            : item;
        return (
          <Card key={i}>
            <Text style={s.text}>
              {String(item.name ?? installed.id ?? item.handlerId ?? `项目 ${i + 1}`)}
            </Text>
            <Label>
              {String(item.description ?? item.status ?? item.trust ?? "")} ·{" "}
              {String(installed.scope ?? "")}
            </Label>
            <Detail value={item} />
            {section !== "Skills" && (
              <Button title="选择管理" secondary onPress={() => select(item)} />
            )}
          </Card>
        );
      })}
      {section !== "Skills" && (
        <Card>
          <Field
            label={section === "Hooks" ? "Handler ID" : "插件 ID"}
            value={id}
            onChange={(value) => {
              setId(value);
              setProposal(undefined);
            }}
          />
          {section === "插件" && (
            <>
              <Label>插件范围</Label>
              <Chips
                values={["user", "project", "local"] as const}
                value={scope}
                onChange={(value) => {
                  setScope(value);
                  setProposal(undefined);
                }}
              />
            </>
          )}
          <View style={s.row}>
            {(["enable", "disable"] as const).map((action) => (
              <Button
                key={action}
                title={action === "enable" ? "启用" : "停用"}
                reason={
                  !id
                    ? "先选择条目"
                    : pico.reason(section === "Hooks" ? "hooks.manage" : "plugin.manage")
                }
                onPress={() =>
                  void pico.perform(async () => {
                    setDetail(
                      section === "Hooks"
                        ? (await pico.request("hooks.manage", { action, handlerId: id })).result
                        : (await pico.request("plugin.manage", { action, id, scope })).result,
                    );
                    await refresh();
                  })
                }
              />
            ))}
            <Button
              title="检查"
              secondary
              reason={!id ? "先选择条目" : undefined}
              onPress={() =>
                void pico.perform(async () => {
                  setDetail(
                    section === "Hooks"
                      ? (await pico.request("hooks.manage", { action: "review", handlerId: id }))
                          .result
                      : (await pico.request("plugin.manage", { action: "inspect", id, scope }))
                          .result,
                  );
                })
              }
            />
            {section === "Hooks" ? (
              <>
                <Button
                  title="信任此 Hook"
                  reason={!id ? "先选择条目" : pico.reason("hooks.manage")}
                  onPress={() =>
                    Alert.alert("信任这个 Hook？", `电脑将信任 ${id} 的当前内容。请先检查配置。`, [
                      { text: "返回" },
                      {
                        text: "确认信任",
                        onPress: () =>
                          void pico.perform(async () => {
                            setDetail(
                              (
                                await pico.request("hooks.manage", {
                                  action: "trust",
                                  handlerId: id,
                                })
                              ).result,
                            );
                            await refresh();
                          }),
                      },
                    ])
                  }
                />
                <Button
                  title="重新加载"
                  secondary
                  reason={pico.reason("hooks.manage")}
                  onPress={() =>
                    void pico.perform(async () =>
                      setDetail((await pico.request("hooks.manage", { action: "reload" })).result),
                    )
                  }
                />
              </>
            ) : (
              <Button
                title="准备信任"
                reason={!id ? "先选择插件" : pico.reason("plugin.manage")}
                onPress={() =>
                  void pico.perform(async () => {
                    const result = (
                      await pico.request("plugin.manage", { action: "trust.prepare", id, scope })
                    ).result;
                    setDetail(result);
                    const value = result.proposal;
                    if (!value || typeof value !== "object" || Array.isArray(value))
                      throw new Error("信任提案无效");
                    const proposal = value as Record<string, unknown>;
                    if (
                      typeof proposal.id !== "string" ||
                      typeof proposal.resourceDigest !== "string"
                    )
                      throw new Error("信任指纹缺失");
                    setProposal({
                      confirmId: proposal.id,
                      fingerprint: proposal.resourceDigest,
                      pluginId: id,
                      scope,
                    });
                  })
                }
              />
            )}
          </View>
          {proposal && section === "插件" && (
            <>
              <Label>当前内容指纹：{proposal.fingerprint}</Label>
              <Button
                title="确认信任当前插件内容"
                reason={pico.reason("plugin.manage")}
                onPress={() =>
                  Alert.alert(
                    "确认插件信任？",
                    `${proposal.pluginId} · ${proposal.scope}\n${proposal.fingerprint}`,
                    [
                      { text: "返回" },
                      {
                        text: "信任",
                        onPress: () =>
                          void pico.perform(async () => {
                            await pico.request("plugin.manage", {
                              action: "trust.confirm",
                              id: proposal.pluginId,
                              scope: proposal.scope,
                              confirmId: proposal.confirmId,
                              fingerprint: proposal.fingerprint,
                            });
                            setProposal(undefined);
                            await refresh();
                          }),
                      },
                    ],
                  )
                }
              />
            </>
          )}
        </Card>
      )}
      <Detail value={detail} />
    </>
  );
}
function confirmDelete(name: string, action: () => void) {
  Alert.alert(`删除 ${name}？`, "此操作会修改电脑上的数据。", [
    { text: "返回" },
    { text: "删除", style: "destructive", onPress: action },
  ]);
}
