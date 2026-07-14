import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../src/provider/model-router.js";
import { createSubagentModelRuntime } from "../src/runtime/subagent-model-runtime.js";
import { resolveSubagentModelSelection } from "../src/runtime/subagent-model-selection.js";

describe("子代理模型 Runtime 集成", () => {
  it("为不同 route 构造隔离的 Provider、Compactor 与 reasoning 配置", () => {
    const parent = route("volcengine/deepseek-v4-pro", "deepseek-v4-pro");
    const child = route("volcengine/glm-5.2", "glm-5.2");
    const router = new ModelRouter(
      [parent, child],
      { DEEPSEEK_KEY: "parent-secret", GLM_KEY: "child-secret" },
      parent.id,
    );
    const providerFactory = vi.fn((_kind, config) => fakeProvider(config.model));

    const parentRuntime = createSubagentModelRuntime({
      router,
      selection: resolveSubagentModelSelection({
        router,
        parentRouteId: parent.id,
        allowRouteOverride: true,
      }),
      providerFactory,
    });
    const childRuntime = createSubagentModelRuntime({
      router,
      selection: resolveSubagentModelSelection({
        router,
        parentRouteId: parent.id,
        ephemeralRouteId: child.id,
        ephemeralThinkingEffort: "high",
        allowRouteOverride: true,
      }),
      providerFactory,
    });

    expect(parentRuntime.provider).not.toBe(childRuntime.provider);
    expect(parentRuntime.compactor).not.toBe(childRuntime.compactor);
    expect(parentRuntime.route.id).toBe(parent.id);
    expect(childRuntime.route.id).toBe(child.id);
    expect(childRuntime.thinkingEffort).toBe("high");
    expect(providerFactory).toHaveBeenNthCalledWith(
      1,
      "openai",
      expect.objectContaining({ model: parent.model, apiKey: "parent-secret" }),
    );
    expect(providerFactory).toHaveBeenNthCalledWith(
      2,
      "openai",
      expect.objectContaining({
        model: child.model,
        apiKey: "child-secret",
        thinkingEffort: "high",
      }),
    );
  });

  it("在构造 Provider 前拒绝缺少凭证的 route", () => {
    const child = route("volcengine/glm-5.2", "glm-5.2");
    const router = new ModelRouter([child], {}, child.id);
    const providerFactory = vi.fn(() => fakeProvider(child.model));
    const selection = resolveSubagentModelSelection({
      router,
      parentRouteId: child.id,
      allowRouteOverride: true,
    });

    expect(() => createSubagentModelRuntime({ router, selection, providerFactory })).toThrow(
      `模型路由 ${child.id} 缺少凭证环境变量 GLM_KEY`,
    );
    expect(providerFactory).not.toHaveBeenCalled();
  });
});

function route(id: string, model: string): ModelRoute {
  return {
    id,
    providerId: "volcengine",
    provider: "openai",
    model,
    baseURL: "https://example.test/v1",
    apiKeyEnv: model.startsWith("glm") ? "GLM_KEY" : "DEEPSEEK_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model, undefined),
  };
}

function fakeProvider(model: string): LLMProvider {
  return {
    modelName: model,
    async generate() {
      return { role: "assistant", content: "ok" };
    },
  };
}
