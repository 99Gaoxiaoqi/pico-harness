import { describe, expect, it } from "vitest";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";
import { DelegateTaskTool, type AgentRunner, type SubagentResult } from "../src/tools/subagent.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";
import { createDelegationCompletionMessage } from "../src/tui/runtime-state.js";

describe("delegation completion policy integration", () => {
  it("默认等待 required，并让 optional 自动回传而 detached 保持静默", async () => {
    const releases = new Map<string, () => void>();
    const completionMessages: ReturnType<typeof createDelegationCompletionMessage>[] = [];
    const manager = new DelegationManager({
      onCompletion: (completion) => {
        if (completion.completionPolicy === "optional") {
          completionMessages.push(createDelegationCompletionMessage(completion));
        }
      },
    });
    const reporter = new TuiReporter(() => undefined);
    const runner: AgentRunner = {
      async runSub(taskPrompt): Promise<SubagentResult> {
        await new Promise<void>((resolve) => releases.set(taskPrompt, resolve));
        return { summary: `result:${taskPrompt}`, artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), manager, { reporter });

    let requiredSettled = false;
    const required = tool.execute(JSON.stringify({ goal: "required-work" })).then((result) => {
      requiredSettled = true;
      return JSON.parse(result) as { results: Array<{ summary?: string }> };
    });
    await waitUntil(() => releases.has("required-work"));
    expect(requiredSettled).toBe(false);
    releases.get("required-work")?.();
    await expect(required).resolves.toMatchObject({
      results: [{ status: "completed", summary: "result:required-work" }],
    });

    const optionalDispatch = JSON.parse(
      await tool.execute(JSON.stringify({ goal: "optional-work", completion_policy: "optional" })),
    ) as { status: string; completionPolicy: string; count: number };
    expect(optionalDispatch).toMatchObject({
      status: "dispatched",
      completionPolicy: "optional",
      count: 1,
    });
    await waitUntil(() => releases.has("optional-work"));
    releases.get("optional-work")?.();
    await waitUntil(() => completionMessages.length === 1);
    expect(completionMessages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("result:optional-work"),
      providerData: {
        picoKind: "subagent_completion",
        picoHiddenFromTranscript: true,
      },
    });

    await tool.execute(JSON.stringify({ goal: "detached-work", completion_policy: "detached" }));
    await waitUntil(() => releases.has("detached-work"));
    releases.get("detached-work")?.();
    await waitUntil(() =>
      Object.values(reporter.getProjection().subagents).some(
        (subagent) =>
          subagent.activity.task === "detached-work" && subagent.activity.status === "completed",
      ),
    );
    expect(completionMessages).toHaveLength(1);

    const policies = Object.values(reporter.getProjection().subagents).map(
      (subagent) => subagent.activity.completionPolicy,
    );
    expect(policies).toEqual(["required", "optional", "detached"]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待委派状态超时");
}
