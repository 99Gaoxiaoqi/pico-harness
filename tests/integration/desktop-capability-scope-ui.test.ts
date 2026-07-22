/// <reference lib="dom" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityList } from "../../apps/desktop/src/renderer/components.js";
import type { CapabilityView } from "../../apps/desktop/src/renderer/model.js";

Object.assign(globalThis, { React });

test("Skills 和 MCP 是全局路由，不会继承侧边栏工作区", async () => {
  const source = await rendererSource("App.tsx");
  assert.match(source, /<Route path="skills" element=\{<CapabilityPage kind="skills" \/>\} \/>/u);
  assert.match(source, /<Route path="mcp" element=\{<CapabilityPage kind="mcp" \/>\} \/>/u);
  assert.match(source, /\{ to: "\/skills", label: "Skills", icon: WandSparkles \}/u);
  assert.match(source, /\{ to: "\/mcp", label: "MCP", icon: Network \}/u);
  assert.doesNotMatch(source, /to: "\/(?:skills|mcp)"[^\n]+scoped: true/u);
});

test("启动只加载用户级能力，显式选择项目后才读取有效列表", async () => {
  const source = await rendererSource("runtime.ts");
  const workspaceLoader = source.slice(
    source.indexOf("const loadWorkspace = useCallback"),
    source.indexOf("const loadConversation = useCallback"),
  );
  const bootstrap = source.slice(
    source.indexOf("const bootstrap = useCallback"),
    source.indexOf("useEffect(() =>", source.indexOf("const bootstrap = useCallback")),
  );
  assert.match(source, /optionalInvoke\(bridge, "skills\.user\.list", \{\}\)/u);
  assert.match(source, /optionalInvoke\(bridge, "mcp\.user\.list", \{\}\)/u);
  assert.match(bootstrap, /await loadUserCapabilities\(bridge\)/u);
  assert.doesNotMatch(workspaceLoader, /config\.(?:skills|mcpServers)/u);
  assert.match(source, /invoke\(bridge, "skills\.effective\.list", \{ workspacePath \}\)/u);
  assert.match(source, /invoke\(bridge, "mcp\.effective\.list", \{ workspacePath \}\)/u);
  assert.match(source, /该项目尚未信任[\s\S]*已继续显示用户级列表/u);

  const appSource = await rendererSource("App.tsx");
  assert.match(appSource, /<option value="">仅用户级<\/option>/u);
  assert.match(
    appSource,
    /actions\.loadCapabilityScope\(kind, event\.target\.value \|\| undefined\)/u,
  );
  const capabilityPage = appSource.slice(
    appSource.indexOf("export function CapabilityPage"),
    appSource.indexOf("function UsagePage"),
  );
  assert.doesNotMatch(capabilityPage, /actions\.selectWorkspace/u);
});

test("能力列表展示来源、只读、生效与遮蔽状态", () => {
  const items: readonly CapabilityView[] = [
    capability("user", "用户配置", false, true),
    capability("project", "项目配置", true, true),
    capability("plugin", "Plugin 配置", true, false, "user:mcp"),
  ];
  const html = renderToStaticMarkup(
    React.createElement(CapabilityList, {
      items,
      emptyTitle: "empty",
      emptyDetail: "empty",
      onDelete: () => undefined,
    }),
  );
  assert.match(html, />用户级</u);
  assert.match(html, />项目级</u);
  assert.match(html, />Plugin</u);
  assert.match(html, />可管理</u);
  assert.match(html, />只读</u);
  assert.match(html, />已生效</u);
  assert.match(html, />未生效</u);
  assert.match(html, /被 user:mcp 覆盖/u);
  assert.equal(html.match(/>删除<\/button>/gu)?.length, 1);
});

test("MCP 用户级增删使用 CAS 与幂等键，冲突后只刷新列表", async () => {
  const source = await rendererSource("runtime.ts");
  const actions = source.slice(
    source.indexOf("async addUserMcp"),
    source.indexOf("async upsertProvider"),
  );
  assert.match(actions, /"mcp\.user\.upsert"/u);
  assert.match(actions, /"mcp\.user\.delete"/u);
  assert.equal(actions.match(/expectedRevision: revision/gu)?.length, 2);
  assert.equal(actions.match(/idempotencyKey: globalThis\.crypto\.randomUUID\(\)/gu)?.length, 2);
  assert.match(actions, /userItems\.some\(\(item\) => item\.name === server\.name\)/u);
  assert.match(actions, /不会覆盖现有配置，以避免丢失密钥/u);
  assert.match(
    source,
    /label\.startsWith\("mcp-user-"\)[\s\S]+await loadUserCapabilities\(bridge\)/u,
  );

  const appSource = await rendererSource("App.tsx");
  assert.match(appSource, /只新增配置，不会连接或启动服务/u);
  assert.doesNotMatch(appSource, /envKeys|headerKeys|headers\s*:|env\s*:/u);
});

function capability(
  scope: "user" | "project" | "plugin",
  sourceLabel: string,
  readOnly: boolean,
  effective: boolean,
  shadowedBy?: string,
): CapabilityView {
  return {
    id: scope,
    name: scope,
    description: `${scope} capability`,
    state: effective ? "ready" : "disabled",
    source: {
      scope,
      sourceId: `${scope}:source`,
      sourceLabel,
      readOnly,
      effective,
      ...(shadowedBy ? { shadowedBy } : {}),
    },
  };
}

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
