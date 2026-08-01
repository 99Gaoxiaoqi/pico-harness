/// <reference lib="dom" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseStrictRuntimeParams } from "../../src/daemon/protocol.js";

test("模型设置是全局路由且侧边栏不会附加工作区", async () => {
  const source = await rendererSource("App.tsx");
  assert.match(source, /<Route path="providers" element=\{<ProviderPageRoute \/>\} \/>/u);
  assert.match(source, /\{ to: "\/providers", label: "模型", icon: BrainCircuit \}/u);
  assert.doesNotMatch(source, /to: "\/providers"[^\n]+scoped: true/u);

  const providerRouteStart = source.indexOf('<Route path="providers"');
  const nextRouteStart = source.indexOf("<Route", providerRouteStart + 1);
  assert.ok(providerRouteStart >= 0 && nextRouteStart > providerRouteStart);
  assert.doesNotMatch(source.slice(providerRouteStart, nextRouteStart), /WorkspaceRoute/u);
});

test("全局 Provider 加载与工作区 effective config 保持独立", async () => {
  const source = await rendererSource("runtime.ts");
  const globalLoader = sourceSection(
    source,
    "const loadGlobalProviderConfig",
    "const loadScopedCapabilities",
  );
  const workspaceLoader = sourceSection(
    source,
    "const loadWorkspace = useCallback",
    "const loadConversation",
  );
  const providerParser = sourceSection(
    source,
    "function parseProviderConfig",
    "function parseCatalogAgents",
  );
  const workspaceMerge = sourceSection(
    source,
    "function mergeLoadedData",
    "export interface RuntimeActions",
  );
  const bootstrap = sourceSection(source, "const bootstrap", "useEffect(() =>");
  const focusRefresh = sourceSection(
    source,
    "const refreshOnFocus",
    'window.addEventListener("focus"',
  );

  assert.match(globalLoader, /"provider\.list", \{\}/u);
  assert.match(globalLoader, /"config\.user\.get", \{\}/u);
  assert.doesNotMatch(globalLoader, /config\.effective\.get|workspacePath/u);
  assert.doesNotMatch(workspaceLoader, /provider\.list|config\.user\.get/u);
  assert.doesNotMatch(workspaceLoader, /providerConfig:/u);
  assert.match(workspaceLoader, /config\.effective\.get/u);
  assert.doesNotMatch(workspaceMerge, /providerConfig:/u);
  assert.match(
    workspaceMerge,
    /modelRoutes:[\s\S]+results\.effectiveConfig[\s\S]+parseModelRoutes[\s\S]+base\.modelRoutes/u,
  );
  assert.match(providerParser, /results\.providerRegistry/u);
  assert.match(providerParser, /results\.userConfig/u);
  assert.match(providerParser, /providers: registryProviders\.map\(parseProviderProfile\)/u);
  assert.doesNotMatch(providerParser, /effectiveConfig|effectiveProviders/u);
  assert.match(bootstrap, /loadGlobalProviderConfig\(bridge\)/u);
  assert.match(focusRefresh, /loadGlobalProviderConfig\(bridge\)/u);

  for (const [start, end] of [
    ["async upsertProvider", "async deleteProvider"],
    ["async deleteProvider", "async setDefaultModelRoute"],
    ["async setDefaultModelRoute", "async setProviderCredential"],
    ["async setProviderCredential", "async deleteProviderCredential"],
    ["async deleteProviderCredential", "async refreshMemory"],
  ] as const) {
    const action = sourceSection(source, start, end);
    assert.match(action, /await loadGlobalProviderConfig\(bridge\)/u, `${start} 必须刷新全局配置`);
    const globalRefresh = action.indexOf("await loadGlobalProviderConfig(bridge)");
    const workspaceRefresh = action.indexOf("await loadWorkspace(bridge");
    assert.ok(
      workspaceRefresh < 0 || globalRefresh < workspaceRefresh,
      `${start} 必须先恢复全局编辑状态，再刷新可选工作区路由`,
    );
  }
});

test("Provider 和用户默认配置协议只接受全局参数", () => {
  assert.deepEqual(parseStrictRuntimeParams("provider.list", {}), {});
  assert.deepEqual(parseStrictRuntimeParams("config.user.get", {}), {});
  assert.throws(
    () => parseStrictRuntimeParams("provider.list", { workspacePath: "/workspace" }),
    /workspacePath/u,
  );
  assert.throws(
    () => parseStrictRuntimeParams("config.user.get", { workspacePath: "/workspace" }),
    /workspacePath/u,
  );

  const provider = {
    id: "fixture",
    protocol: "openai" as const,
    baseURL: "https://example.test/v1",
    apiKeyEnv: "FIXTURE_KEY",
    models: ["fixture-model"],
    discoverModels: false,
  };
  assert.deepEqual(
    parseStrictRuntimeParams("provider.upsert", {
      provider,
      expectedRevision: "revision",
    }),
    { provider, expectedRevision: "revision" },
  );
  assert.deepEqual(
    parseStrictRuntimeParams("config.user.update", {
      defaults: { modelRouteId: "fixture/fixture-model" },
      expectedRevision: "revision",
    }),
    {
      defaults: { modelRouteId: "fixture/fixture-model" },
      expectedRevision: "revision",
    },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("provider.upsert", {
        workspacePath: "/workspace",
        provider,
        expectedRevision: "revision",
      } as never),
    /workspacePath/u,
  );
});

test("已移除的 Gemini 原生协议继续在公共协议边界被拒绝", () => {
  assert.throws(
    () =>
      parseStrictRuntimeParams("provider.upsert", {
        provider: {
          id: "removed-gemini",
          protocol: "gemini",
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          apiKeyEnv: "REMOVED_GEMINI_KEY",
          models: ["gemini-model"],
          discoverModels: false,
        },
        expectedRevision: "revision",
      } as never),
    /protocol/u,
  );
});

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const markerIndex = source.indexOf(startMarker);
  assert.ok(markerIndex >= 0, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, markerIndex + startMarker.length);
  assert.ok(end > markerIndex, `missing source marker: ${endMarker}`);
  return source.slice(markerIndex, end);
}

async function rendererSource(fileName: string): Promise<string> {
  return readFile(new URL(`../../apps/desktop/src/renderer/${fileName}`, import.meta.url), "utf8");
}
