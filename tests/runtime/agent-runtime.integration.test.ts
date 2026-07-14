import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { ModelRouter, type ModelRoute } from "../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: readonly Message[]; tools: readonly ToolDefinition[] }> = [];

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    const next = this.responses.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

describe("AgentRuntime integration", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("runs through a non-TUI host and emits lifecycle events", async () => {
    const runtime = new AgentRuntime();
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "runtime completed",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const events: string[] = [];

    const result = await runtime.execute(
      { prompt: "say done", dir: await mkdtemp(join(tmpdir(), "pico-runtime-success-")) },
      {
        provider,
        reporter: new SilentReporter(),
        onEvent: (event) => events.push(event.type),
      },
    );

    expect(result.finalMessage).toBe("runtime completed");
    expect(events).toEqual(["run.started", "run.finished"]);
  });

  it("fails closed when a dangerous tool has no approval host", async () => {
    const runtime = new AgentRuntime();
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "dangerous-bash",
            name: "bash",
            arguments: JSON.stringify({ command: "echo blocked" }),
          },
        ],
      },
      { role: "assistant", content: "approval was denied" },
    ]);

    const result = await runtime.execute(
      { prompt: "run a command", dir: await mkdtemp(join(tmpdir(), "pico-runtime-deny-")) },
      { provider, reporter: new SilentReporter() },
    );

    expect(result.finalMessage).toBe("approval was denied");
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("blocked");
  });

  it("routes a natural-language ephemeral agent to its isolated child model", async () => {
    const parentRoute = modelRoute("volcengine/deepseek-v4-pro", "deepseek-v4-pro", "DEEPSEEK_KEY");
    const childRoute = modelRoute("volcengine/glm-5.2", "glm-5.2", "GLM_KEY");
    const modelRouter = new ModelRouter(
      [parentRoute, childRoute],
      { DEEPSEEK_KEY: "parent-secret", GLM_KEY: "child-secret" },
      parentRoute.id,
    );
    const mainProvider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "delegate-natural-agent",
            name: "delegate_task",
            arguments: JSON.stringify({
              goal: "审查认证模块",
              agent: {
                name: "临时安全审查员",
                instructions: "只报告高风险问题。",
                model_route: childRoute.id,
                thinking_effort: "high",
                max_turns: 3,
              },
            }),
          },
        ],
        usage: { promptTokens: 2, completionTokens: 2 },
      },
      {
        role: "assistant",
        content: "临时子代理已完成审查。",
        usage: { promptTokens: 2, completionTokens: 2 },
      },
    ]);
    const childProvider = new ScriptedProvider([
      {
        role: "assistant",
        content: `结论：未发现高风险问题。${"证据充分。".repeat(40)}`,
        usage: { promptTokens: 3, completionTokens: 3 },
      },
    ]);
    const createdConfigs: Array<{ model: string; apiKey: string; thinkingEffort?: string }> = [];
    const workDir = await mkdtemp(join(tmpdir(), "pico-runtime-subagent-route-"));

    const result = await new AgentRuntime().execute(
      {
        prompt: "创建一个使用 GLM 5.2 的临时安全审查子代理，审查认证模块。",
        dir: workDir,
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
        providerFactory: (_kind, config) => {
          createdConfigs.push({
            model: config.model,
            apiKey: config.apiKey,
            ...(config.thinkingEffort ? { thinkingEffort: config.thinkingEffort } : {}),
          });
          if (config.model === parentRoute.model) return mainProvider;
          if (config.model === childRoute.model) return childProvider;
          throw new Error(`unexpected model ${config.model}`);
        },
      },
    );

    expect(result.finalMessage).toBe("临时子代理已完成审查。");
    expect(mainProvider.calls).toHaveLength(2);
    expect(childProvider.calls).toHaveLength(1);
    expect(childProvider.calls[0]?.messages[0]?.content).toContain("只报告高风险问题");
    expect(createdConfigs).toEqual([
      { model: parentRoute.model, apiKey: "parent-secret" },
      { model: childRoute.model, apiKey: "child-secret", thinkingEffort: "high" },
    ]);
  });
});

function modelRoute(id: string, model: string, apiKeyEnv: string): ModelRoute {
  return {
    id,
    providerId: "volcengine",
    provider: "openai",
    model,
    baseURL: "https://example.test/v1",
    apiKeyEnv,
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model, undefined),
  };
}
