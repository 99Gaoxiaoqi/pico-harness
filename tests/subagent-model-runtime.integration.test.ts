import { describe, expect, it, vi } from "vitest";
import { AgentEngine, type SubagentExecutionRuntime } from "../src/engine/loop.js";
import type { LLMProvider } from "../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../src/provider/model-router.js";
import { createSubagentModelRuntime } from "../src/runtime/subagent-model-runtime.js";
import { resolveSubagentModelSelection } from "../src/runtime/subagent-model-selection.js";
import type { Registry } from "../src/tools/registry.js";
import type { Reporter, SubagentActivityEvent } from "../src/engine/reporter.js";
import { ScopedSubagentActivityReporter } from "../src/tools/subagent-activity-reporter.js";

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

  it("AgentEngine 并发子代理各自使用请求级 Provider 和 Compactor", async () => {
    const parent = route("volcengine/deepseek-v4-pro", "deepseek-v4-pro");
    const child = route("volcengine/glm-5.2", "glm-5.2");
    const router = new ModelRouter(
      [parent, child],
      { DEEPSEEK_KEY: "parent-secret", GLM_KEY: "child-secret" },
      parent.id,
    );
    const providers: LLMProvider[] = [];
    const providerFactory = vi.fn((_kind, config) => {
      const provider = fakeProvider(`${config.model}:${"完成".repeat(120)}`);
      providers.push(provider);
      return provider;
    });
    const resolveRuntime = (request?: {
      ephemeralRouteId?: string;
      ephemeralThinkingEffort?: string;
    }): SubagentExecutionRuntime => {
      const selection = resolveSubagentModelSelection({
        router,
        parentRouteId: parent.id,
        ...(request?.ephemeralRouteId ? { ephemeralRouteId: request.ephemeralRouteId } : {}),
        ...(request?.ephemeralThinkingEffort
          ? { ephemeralThinkingEffort: request.ephemeralThinkingEffort }
          : {}),
        allowRouteOverride: true,
      });
      const runtime = createSubagentModelRuntime({
        router,
        selection,
        providerFactory,
      });
      return {
        provider: runtime.provider,
        compactor: runtime.compactor,
        thinkingEffort: runtime.thinkingEffort ?? "off",
        resolvedModelRoute: runtime.route.id,
        source: selection.source,
      };
    };
    const engine = new AgentEngine({
      provider: fakeProvider("主 Provider 不应被子代理调用"),
      registry: emptyRegistry(),
      workDir: "/tmp",
      modelRouteId: parent.id,
      resolveSubagentModelRuntime: resolveRuntime,
    });
    const activities: SubagentActivityEvent[] = [];
    const childReporter = new ScopedSubagentActivityReporter(recordingReporter(activities), {
      activityId: "child-route",
      task: "子路由任务",
      mode: "explore",
      completionPolicy: "required",
      requestedModelRoute: child.id,
    });

    const [parentResult, childResult] = await Promise.all([
      engine.runSub("父路由任务", emptyRegistry()),
      engine.runSub("子路由任务", emptyRegistry(), childReporter, {
        modelSelection: {
          ephemeralRouteId: child.id,
          ephemeralThinkingEffort: "high",
        },
      }),
    ]);

    expect(parentResult.summary).toContain(parent.model);
    expect(childResult.summary).toContain(child.model);
    expect(providers).toHaveLength(2);
    expect(providers[0]).not.toBe(providers[1]);
    expect(activities.at(-1)).toMatchObject({
      requestedModelRoute: child.id,
      resolvedModelRoute: child.id,
      thinkingEffort: "high",
      modelSelectionSource: "ephemeral",
    });
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

function fakeProvider(content: string): LLMProvider {
  return {
    modelName: content.split(":", 1)[0],
    async generate() {
      return { role: "assistant", content };
    },
  };
}

function emptyRegistry(): Registry {
  return {
    register() {},
    use() {},
    getAvailableTools() {
      return [];
    },
    async execute(call) {
      return { toolCallId: call.id, output: "unused", isError: true };
    },
    isReadOnlyTool() {
      return true;
    },
  };
}

function recordingReporter(events: SubagentActivityEvent[]): Reporter {
  return {
    onThinking() {},
    onToolCall() {},
    onToolResult() {},
    onMessage() {},
    onStart() {},
    onTurnStart() {},
    onFinish() {},
    onSubagentActivity(event) {
      events.push(event);
    },
  };
}
