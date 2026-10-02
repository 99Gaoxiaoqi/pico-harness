import React, { useEffect, useState } from "react";
import { Alert, BackHandler, Text, View } from "react-native";
import { getRemoteMethodSpec, type RemoteMethod } from "@pico/protocol/remote";
import { Button, Card, Detail, Label, s } from "./ui";
import { usePico } from "./store";
import { clearArtifactCache } from "./artifact-cache";
import { Jobs } from "./settings/Jobs";
import { Memory } from "./settings/Memory";
import { Providers } from "./settings/Providers";
import { Mcp } from "./settings/Mcp";
import { Defaults } from "./settings/Defaults";
import { Capabilities } from "./settings/Capabilities";
import { Subagents } from "./settings/Subagents";
import { Usage } from "./settings/Usage";
import { SettingsRow } from "./settings/SettingsNavigation";

export { SessionSettings } from "./settings/SessionSettings";
export type SettingsPanelProps = { onOpenComputers?: () => void };
type Page =
  | "computers"
  | "providers"
  | "defaults"
  | "mcp"
  | "skills"
  | "hooks"
  | "plugins"
  | "subagents"
  | "memory"
  | "memoryPolicy"
  | "jobs"
  | "usage"
  | "cache";
const groups: readonly {
  title: string;
  items: readonly { id: Page; title: string; description: string; method?: RemoteMethod }[];
}[] = [
  {
    title: "电脑与连接",
    items: [{ id: "computers", title: "电脑与设备授权", description: "连接状态、配对与项目授权" }],
  },
  {
    title: "模型与默认行为",
    items: [
      {
        id: "providers",
        title: "模型连接",
        description: "Provider、模型与密钥",
        method: "provider.list",
      },
      {
        id: "defaults",
        title: "新对话默认",
        description: "模型、思考等级与联网搜索",
        method: "config.user.get",
      },
    ],
  },
  {
    title: "扩展与协作",
    items: [
      {
        id: "skills",
        title: "Skills",
        description: "查看当前项目生效技能",
        method: "skills.effective.list",
      },
      {
        id: "subagents",
        title: "子 Agent 预设",
        description: "角色、模型与思考等级",
        method: "subagents.get",
      },
      {
        id: "mcp",
        title: "MCP 服务",
        description: "用户服务、连接与凭据",
        method: "mcp.user.list",
      },
      { id: "hooks", title: "Hooks", description: "启停、检查与信任", method: "hooks.manage" },
      {
        id: "plugins",
        title: "插件",
        description: "启停、检查与内容信任",
        method: "plugin.manage",
      },
    ],
  },
  {
    title: "记忆",
    items: [
      {
        id: "memory",
        title: "记忆内容",
        description: "全局与当前项目的已保存内容",
        method: "memory.list",
      },
      {
        id: "memoryPolicy",
        title: "全局记忆策略",
        description: "对这台电脑的所有项目生效",
        method: "memory.settings.get",
      },
    ],
  },
  {
    title: "自动化",
    items: [
      {
        id: "jobs",
        title: "定时自动化",
        description: "计划规则、启停与执行历史",
        method: "jobs.list",
      },
    ],
  },
  {
    title: "用量与数据",
    items: [
      {
        id: "usage",
        title: "用量与费用",
        description: "按日期和已授权项目查看",
        method: "usage.get",
      },
      { id: "cache", title: "本机缓存与数据", description: "清理手机成果缓存与存储说明" },
    ],
  },
];
export function SettingsPanel({ onOpenComputers }: SettingsPanelProps = {}) {
  const pico = usePico();
  const [page, setPage] = useState<Page>();
  const [cacheCleared, setCacheCleared] = useState(false);
  useEffect(() => {
    if (!page) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setPage(undefined);
      return true;
    });
    return () => subscription.remove();
  }, [page]);
  const item = groups.flatMap((group) => group.items).find((candidate) => candidate.id === page);
  if (!page)
    return (
      <View style={{ gap: 20 }}>
        <View style={{ gap: 4 }}>
          <Text style={s.title}>设置</Text>
          <Label>
            {pico.host?.name ?? "尚未连接电脑"}
            {pico.workspace ? ` · ${pico.workspace.label}` : ""}
          </Label>
        </View>
        {groups.map((group) => (
          <View key={group.title} style={{ gap: 6 }}>
            <Text style={s.muted}>{group.title}</Text>
            <View>
              {group.items.map((entry) => (
                <SettingsRow
                  key={entry.id}
                  title={entry.title}
                  description={entry.description}
                  reason={
                    entry.method
                      ? (pico.reason(entry.method) ??
                        (getRemoteMethodSpec(entry.method).workspaceRequired && !pico.workspace
                          ? "请先选择已授权项目"
                          : undefined))
                      : undefined
                  }
                  onPress={() => setPage(entry.id)}
                />
              ))}
            </View>
          </View>
        ))}
      </View>
    );
  return (
    <View style={{ gap: 14 }}>
      <View style={s.row}>
        <Button title="‹ 返回设置" secondary onPress={() => setPage(undefined)} />
        <Text style={s.title}>{item?.title}</Text>
      </View>
      {page === "computers" ? (
        <Card>
          <Text style={s.text}>{pico.host?.name ?? "尚未连接电脑"}</Text>
          <Label>
            {pico.connected ? "已连接" : "连接未就绪"} · {pico.workspace?.label ?? "尚未选择项目"}
          </Label>
          <Button
            title="管理电脑与连接"
            reason={onOpenComputers ? undefined : "请从应用电脑页管理连接"}
            onPress={() => onOpenComputers?.()}
          />
          <Label>设备权限与项目授权由电脑确认。模型连接和全局配置另需管理权限。</Label>
          <Detail title="当前权限" value={pico.capabilities?.permissions} />
        </Card>
      ) : page === "providers" ? (
        <Providers />
      ) : page === "defaults" ? (
        <Defaults />
      ) : page === "mcp" ? (
        <Mcp />
      ) : page === "subagents" ? (
        <Subagents />
      ) : page === "memory" ? (
        <Memory section="content" />
      ) : page === "memoryPolicy" ? (
        <Memory section="policy" />
      ) : page === "jobs" ? (
        <Jobs />
      ) : page === "usage" ? (
        <Usage />
      ) : page === "cache" ? (
        <Card>
          <Text style={s.text}>手机成果缓存</Text>
          <Label>
            正式对话、成果和配置保存在电脑。这里清理手机已下载的成果缓存，不删除电脑数据。
          </Label>
          <Button
            title="清空文件缓存"
            secondary
            onPress={() =>
              Alert.alert("清空手机文件缓存？", "已下载成果需要重新下载，电脑原文件仍保留。", [
                { text: "返回" },
                {
                  text: "清空缓存",
                  onPress: () =>
                    void pico.perform(async () => {
                      clearArtifactCache();
                      setCacheCleared(true);
                    }),
                },
              ])
            }
          />
          {cacheCleared && <Label>手机文件缓存已清空。</Label>}
          <Label>
            电脑的数据目录、手动备份说明和启动行为请在电脑设置查看。当前没有云同步或自动备份。
          </Label>
        </Card>
      ) : (
        <Capabilities
          key={page}
          section={page === "skills" ? "Skills" : page === "hooks" ? "Hooks" : "插件"}
        />
      )}
    </View>
  );
}
