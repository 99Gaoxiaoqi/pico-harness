import { describe, expect, it } from "vitest";
import { resolveModelRouteCapabilities } from "../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../src/provider/model-router.js";
import {
  resolveCompatibleModelRoute,
  resolveSubagentModelSelection,
} from "../src/runtime/subagent-model-selection.js";

describe("子代理模型选择集成", () => {
  const parent = route("volcengine/deepseek-v4-pro", "deepseek-v4-pro");
  const child = route("volcengine/glm-5.2", "glm-5.2");
  const router = new ModelRouter([parent, child], {}, parent.id);

  it("按临时 Agent、Profile、父会话顺序解析 route 与思考档位", () => {
    const selected = resolveSubagentModelSelection({
      router,
      parentRouteId: parent.id,
      ephemeralRouteId: child.id,
      profileRouteId: parent.id,
      ephemeralThinkingEffort: "high",
      profileThinkingEffort: "max",
      parentThinkingEffort: "off",
      allowRouteOverride: true,
    });

    expect(selected).toMatchObject({
      route: { id: child.id },
      source: "ephemeral",
      inheritsParentRoute: false,
      thinking: { level: "high", reason: "requested" },
    });

    const inherited = resolveSubagentModelSelection({
      router,
      parentRouteId: parent.id,
      ephemeralRouteId: "inherit",
      profileRouteId: child.id,
      parentThinkingEffort: "max",
      allowRouteOverride: true,
    });
    expect(inherited).toMatchObject({
      route: { id: parent.id },
      source: "ephemeral",
      inheritsParentRoute: true,
      thinking: { level: "max" },
    });
  });

  it("在后台单路由授权边界拒绝子代理切换 route", () => {
    expect(() =>
      resolveSubagentModelSelection({
        router,
        parentRouteId: parent.id,
        ephemeralRouteId: child.id,
        allowRouteOverride: false,
      }),
    ).toThrow(`只允许子代理继承父模型路由 ${parent.id}`);
  });

  it("通过显式配置或唯一 family 匹配解析 Claude Agent 模型别名", () => {
    const sonnet = route("anthropic/claude-sonnet-4-5", "claude-sonnet-4-5");
    const aliasRouter = new ModelRouter([parent, child, sonnet], {}, parent.id);

    expect(resolveCompatibleModelRoute(aliasRouter, "sonnet").id).toBe(sonnet.id);
    expect(
      resolveCompatibleModelRoute(aliasRouter, "review-model", {
        "review-model": child.id,
      }).id,
    ).toBe(child.id);
  });

  it("Claude family 匹配多个路由时保持 fail-closed", () => {
    const aliasRouter = new ModelRouter(
      [
        parent,
        route("anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"),
        route("gateway/claude-sonnet-4", "claude-sonnet-4"),
      ],
      {},
      parent.id,
    );

    expect(() => resolveCompatibleModelRoute(aliasRouter, "sonnet")).toThrow("匹配多个 Pico 路由");
  });
});

function route(id: string, model: string): ModelRoute {
  return {
    id,
    providerId: "volcengine",
    provider: "openai",
    model,
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_API_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model, undefined),
  };
}
