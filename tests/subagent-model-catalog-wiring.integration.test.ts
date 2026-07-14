import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../src/approval/manager.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { globalSessionManager } from "../src/engine/session.js";
import { resetSessionSettingsForTests } from "../src/input/session-settings.js";
import type { LLMProvider } from "../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../src/provider/model-router.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { SubagentModelCatalog } from "../src/runtime/subagent-model-catalog.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import type { AgentRunner } from "../src/tools/subagent.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";

describe("子代理模型目录接线", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("顶层 delegate_task 披露完整 Runtime 注入的可用模型目录", async () => {
    const parentRoute = modelRoute("deepseek/deepseek-v4-pro", "deepseek-v4-pro", "PARENT_KEY");
    const childRoute = modelRoute("zhipu/glm-5.2", "glm-5.2", "CHILD_KEY");
    const modelRouter = new ModelRouter(
      [parentRoute, childRoute],
      { PARENT_KEY: "parent-secret", CHILD_KEY: "child-secret" },
      parentRoute.id,
    );
    const provider = new CapturingProvider();

    await new AgentRuntime().execute(
      {
        prompt: "使用 GLM-5.2 创建审查子代理",
        dir: await mkdtemp(join(tmpdir(), "pico-subagent-model-catalog-wiring-")),
        provider: parentRoute.provider,
        baseURL: parentRoute.baseURL,
        apiKey: "parent-secret",
        model: parentRoute.model,
        modelRouteId: parentRoute.id,
        modelCapabilities: parentRoute.capabilities,
        allowModelFallback: false,
      },
      {
        reporter: new SilentReporter(),
        modelRouter,
        providerFactory: () => provider,
      },
    );

    expect(provider.tools.find((tool) => tool.name === "delegate_task")?.inputSchema).toMatchObject(
      {
        properties: {
          agent: {
            properties: {
              model_route: {
                enum: ["inherit", parentRoute.id, childRoute.id],
              },
            },
          },
        },
      },
    );
  });

  it("递归 orchestrator 继续披露父会话的同一模型目录", () => {
    const modelCatalog = Object.freeze({
      routes: Object.freeze([
        Object.freeze({
          id: "zhipu/glm-5.2",
          model: "glm-5.2",
          aliases: Object.freeze(["review"]),
          reasoning: true,
        }),
      ]),
      parentRouteId: "zhipu/glm-5.2",
      allowRouteOverride: true,
      totalSelectableRoutes: 1,
      truncated: false,
    }) satisfies SubagentModelCatalog;
    const runner: AgentRunner = {
      async runSub() {
        return { summary: "ok", artifacts: [] };
      },
    };
    const factory = createSubagentRegistryFactory({
      workDir: process.cwd(),
      runner,
      manager: new DelegationManager(),
      modelCatalog,
    });

    const registry = factory({
      mode: "explore",
      role: "orchestrator",
      depth: 0,
      maxSpawnDepth: 2,
    }) as ToolRegistry;

    expect(registry.getTool("delegate_task")?.definition()).toMatchObject({
      inputSchema: {
        properties: {
          agent: {
            properties: {
              model_route: {
                enum: ["inherit", "zhipu/glm-5.2"],
              },
            },
          },
          tasks: {
            items: {
              properties: {
                agent: {
                  properties: {
                    model_route: {
                      enum: ["inherit", "zhipu/glm-5.2"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it.each([true, false])(
    "宿主注入固定 Provider 时只向 delegate_task 披露 inherit（注入 ModelRouter=%s）",
    async (injectModelRouter) => {
      const parentRoute = modelRoute("deepseek/deepseek-v4-pro", "deepseek-v4-pro", "PARENT_KEY");
      const childRoute = modelRoute("zhipu/glm-5.2", "glm-5.2", "CHILD_KEY");
      const modelRouter = new ModelRouter(
        [parentRoute, childRoute],
        { PARENT_KEY: "parent-secret", CHILD_KEY: "child-secret" },
        parentRoute.id,
      );
      const provider = new CapturingProvider();

      await new AgentRuntime().execute(
        {
          prompt: "使用 GLM-5.2 创建审查子代理",
          dir: await mkdtemp(join(tmpdir(), "pico-subagent-fixed-provider-catalog-")),
          provider: parentRoute.provider,
          baseURL: parentRoute.baseURL,
          apiKey: "parent-secret",
          model: parentRoute.model,
          modelRouteId: parentRoute.id,
          modelCapabilities: parentRoute.capabilities,
          allowModelFallback: false,
        },
        {
          provider,
          reporter: new SilentReporter(),
          ...(injectModelRouter ? { modelRouter } : {}),
        },
      );

      expect(
        provider.tools.find((tool) => tool.name === "delegate_task")?.inputSchema,
      ).toMatchObject({
        properties: {
          agent: {
            properties: {
              model_route: {
                enum: ["inherit"],
              },
            },
          },
        },
      });
    },
  );
});

class CapturingProvider implements LLMProvider {
  tools: readonly ToolDefinition[] = [];

  async generate(_messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.tools = [...tools];
    return {
      role: "assistant",
      content: "done",
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }
}

function modelRoute(id: string, model: string, apiKeyEnv: string): ModelRoute {
  return {
    id,
    providerId: id.split("/", 1)[0]!,
    provider: "openai",
    model,
    baseURL: "https://example.test/v1",
    apiKeyEnv,
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model, undefined),
  };
}
