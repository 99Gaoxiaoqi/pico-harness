import React, { useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s } from "../ui";

export function Capabilities({ section }: { section: "Skills" | "Hooks" | "插件" }) {
  const pico = usePico();
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}:${section}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
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
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const isCurrent = () => version === readVersion.current && readScope === currentScope.current;
    if (section === "Skills") {
      const skills = [
        ...(skillsScope === "用户列表"
          ? (await pico.request("skills.user.list", {})).skills
          : (await pico.request("skills.effective.list", {})).skills),
      ];
      if (isCurrent()) setData(skills);
      return;
    }
    const x =
      section === "Hooks"
        ? (await pico.request("hooks.manage", { action: "list" })).result
        : (await pico.request("plugin.manage", { action: "list" })).result;
    const list = Object.values(x).find(Array.isArray);
    if (!isCurrent()) return;
    setData(Array.isArray(list) ? (list as Record<string, unknown>[]) : []);
    setDetail(x);
  }
  useEffect(() => {
    setData([]);
    setId("");
    setDetail(undefined);
    setProposal(undefined);
  }, [section, pico.generation, skillsScope]);
  useEffect(() => {
    if (pico.connected !== false) void pico.perform(refresh);
    return () => {
      ++readVersion.current;
    };
  }, [section, skillsScope, pico.generation, pico.connected, pico.syncRevision]);
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
          values={
            pico.reason("skills.user.list")
              ? (["生效列表"] as const)
              : (["生效列表", "用户列表"] as const)
          }
          value={skillsScope}
          onChange={setSkillsScope}
        />
      )}
      {(!id || section === "Skills") &&
        data.map((item, i) => {
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
      {section !== "Skills" && id && (
        <Card>
          <Button
            title="返回扩展列表"
            secondary
            onPress={() => {
              setId("");
              setProposal(undefined);
            }}
          />
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
                labels={{ user: "全局用户", project: "项目共享", local: "项目本机" }}
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
      <Detail title="原始管理结果" value={detail} />
    </>
  );
}
