import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SilentReporter, type SubagentActivityEvent } from "../../src/engine/reporter.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../../src/provider/model-router.js";

describe("real model natural-language subagent routing", () => {
  it("creates an ephemeral agent from natural language and resolves its requested route", async () => {
    const parentModel = process.env.LLM_MODEL!;
    const childModel = process.env.SUBAGENT_LLM_MODEL ?? parentModel;
    const parentRoute = route(`e2e-parent/${parentModel}`, parentModel);
    const childRoute = route(`e2e-child/${childModel}`, childModel);
    const modelRouter = new ModelRouter(
      [parentRoute, childRoute],
      { LLM_API_KEY: process.env.LLM_API_KEY },
      parentRoute.id,
    );
    const reporter = new RecordingReporter();
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-model-e2e-"));
    const result = await new AgentRuntime().execute(
      {
        prompt:
          "这是一次真实模型验收。你必须调用且只调用一次 delegate_task，使用单任务 goal。" +
          `同时根据自然语言创建一次性子代理：agent.name=route-reviewer，` +
          `agent.instructions=只返回 PICO_CHILD_ROUTE_OK，agent.model_route=${childRoute.id}，` +
          "agent.max_turns=2。不要使用 agent_name，不要调用其他工具。" +
          "子代理完成后，最终回复必须包含 PICO_NATURAL_AGENT_OK。",
        provider: "openai",
        baseURL: process.env.LLM_BASE_URL!,
        apiKey: process.env.LLM_API_KEY!,
        model: parentModel,
        modelRouteId: parentRoute.id,
        modelCapabilities: parentRoute.capabilities,
        allowModelFallback: false,
        dir: workDir,
        session: `subagent-model-routing-e2e-${Date.now()}`,
      },
      { reporter, modelRouter },
    );

    expect(result.finalMessage).toContain("PICO_NATURAL_AGENT_OK");
    expect(reporter.activities.some((event) => event.agentName === "route-reviewer")).toBe(true);
    expect(
      reporter.activities.some(
        (event) =>
          event.requestedModelRoute === childRoute.id && event.resolvedModelRoute === childRoute.id,
      ),
    ).toBe(true);
  }, 120_000);
});

function route(id: string, model: string): ModelRoute {
  return {
    id,
    providerId: id.split("/", 1)[0]!,
    provider: "openai",
    model,
    baseURL: process.env.LLM_BASE_URL!,
    apiKeyEnv: "LLM_API_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model, undefined),
  };
}

class RecordingReporter extends SilentReporter {
  readonly activities: SubagentActivityEvent[] = [];

  override onSubagentActivity(event: SubagentActivityEvent): void {
    this.activities.push(event);
  }
}
