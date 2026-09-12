import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../../../apps/desktop/src/renderer/pages/SettingsPage.js";
import { ConversationTranscript } from "../../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { parseProviderConfig } from "../../../apps/desktop/src/renderer/runtime-projections/configuration.js";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import { emptyData } from "../../../apps/desktop/src/renderer/model.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";

test("全局联网设置投影真实模型能力，默认关闭且仅保存搜索偏好", async (t) => {
  installReact(t);
  const defaults = { modelRouteId: "deepseek/deepseek-v4", collaborationMode: "plan" };
  const registry = {
    revision: "revision-1",
    providers: [
      {
        id: "deepseek",
        protocol: "responses",
        models: ["deepseek-v4"],
        // User overrides and a Responses protocol cannot establish native search availability.
        modelCapabilities: { "deepseek-v4": { nativeWebSearch: { available: true } } },
        resolvedModelCapabilities: {
          "deepseek-v4": {
            nativeWebSearch: {
              available: false,
              reason: "DeepSeek 官方 Responses API 未提供原生联网搜索。",
            },
          },
        },
      },
    ],
  };
  const render = (userDefaults: Record<string, unknown>, providerRegistry = registry) => {
    const config = parseProviderConfig(
      {
        userConfig: { config: { defaults: userDefaults }, revision: "revision-1" },
        providerRegistry,
      },
      true,
    );
    const store = {
      data: { ...emptyData, providerConfig: config },
      actions: {},
    } as unknown as RuntimeStore;
    return {
      config,
      html: renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(RuntimeContext.Provider, { value: store }, createElement(SettingsPage)),
        ),
      ),
    };
  };
  const initial = render(defaults);
  assert.equal(initial.config.userDefaults.webSearch, undefined);
  assert.match(initial.html, /<option value="model" selected="">当前模型原生搜索/);
  assert.doesNotMatch(initial.html, /checked=""/);
  assert.match(initial.html, /DeepSeek 官方 Responses API 未提供原生联网搜索/);
  assert.match(initial.html, /不可用/);
  assert.match(initial.html, /下一次运行生效/);
  assert.match(initial.html, /不保证每次都联网/);
  const enabled = render({ ...defaults, webSearch: { enabled: true, source: "external" } });
  assert.deepEqual(enabled.config.userDefaults.webSearch, { enabled: true, source: "external" });
  assert.match(enabled.html, /checked=""/);
  assert.match(enabled.html, /SEARCH_API_BASE 和 SEARCH_API_KEY/);
  assert.match(enabled.html, /<option value="external" selected="">外部搜索服务/);
  const unavailable = render(defaults, {
    ...registry,
    providers: [{ ...registry.providers[0], resolvedModelCapabilities: {} }],
  });
  assert.match(unavailable.html, /尚未取得原生搜索能力，当前不可用/);
  const source = await readFile(
    new URL("../../../apps/desktop/src/renderer/runtime.ts", import.meta.url),
    "utf8",
  );
  const action = source.slice(
    source.indexOf("async setWebSearch("),
    source.indexOf("async queryUsage("),
  );
  assert.match(action, /"config\.user\.update"/);
  assert.match(action, /defaults: \{ \.\.\.providerConfig\.userDefaults, webSearch \}/);
  assert.match(action, /expectedRevision: providerConfig\.revision/);
  assert.match(action, /finally[\s\S]*loadGlobalProviderConfig/);
});

test("持久会话搜索记录渲染完成和失败状态，仅安全来源可点击且普通URL不证明搜索", (t) => {
  installReact(t);
  const render = (items: readonly unknown[]) => {
    const conversation = parseConversation({ items }, "/workspace", "session");
    return renderToStaticMarkup(
      createElement(ConversationTranscript, { items: conversation.items }),
    );
  };
  const html = render([
    {
      id: "assistant",
      kind: "assistantMessage",
      content: "已查询",
      webSearch: {
        calls: [
          {
            toolCallId: "one",
            toolName: "web_search",
            input: { query: "天气" },
            status: "completed",
          },
          {
            toolCallId: "two",
            toolName: "web_search",
            input: { query: "新闻" },
            status: "error",
            error: "服务不可用",
          },
        ],
        sources: [
          { url: "https://example.com/report", title: "报告" },
          { url: "javascript:alert(1)", title: "危险" },
        ],
      },
    },
  ]);
  assert.match(html, /<details class="conversation-web-search">/);
  assert.match(html, /2 次调用/);
  assert.match(html, /搜索已完成/);
  assert.match(html, /搜索失败/);
  assert.match(html, /服务不可用/);
  assert.match(html, /href="https:\/\/example.com\/report"/);
  assert.doesNotMatch(html, /javascript:|危险/);
  const onlySource = render([
    {
      id: "source",
      kind: "assistantMessage",
      content: "",
      webSearch: {
        calls: [],
        sources: [{ url: "https://example.com", title: "来源" }],
      },
    },
  ]);
  assert.match(onlySource, /模型提供的来源/);
  assert.doesNotMatch(onlySource, /搜索已完成|次调用/);
  const plain = render([{ id: "plain", kind: "assistantMessage", content: "https://example.com" }]);
  assert.doesNotMatch(plain, /conversation-web-search|搜索已完成/);
});

function installReact(t: { after(fn: () => void): void }) {
  const globals = globalThis as typeof globalThis & { React?: typeof React };
  const previous = globals.React;
  globals.React = React;
  t.after(() => {
    if (previous) globals.React = previous;
    else Reflect.deleteProperty(globals, "React");
  });
}
