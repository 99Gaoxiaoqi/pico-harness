import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskRegistry } from "../src/tasks/task-registry.js";
import {
  aggregateDelegationStatus,
  DelegationManager,
  type DelegationCompletionEnvelope,
} from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { DelegateTaskTool, type AgentRunner, type SubagentResult } from "../src/tools/subagent.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";
import {
  createDelegationCompletionMessage,
  DelegationCompletionWakeQueue,
  DelegationWakeCoordinator,
} from "../src/tui/runtime-state.js";
import { runTuiAgentPrompt } from "../src/tui/repl.js";

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

  it("按 children 聚合 mixed/full-failure 并同步 Manager 与 TaskRegistry", async () => {
    expect(
      aggregateDelegationStatus([
        { taskIndex: 0, status: "completed", durationMs: 1 },
        { taskIndex: 1, status: "error", durationMs: 1 },
      ]),
    ).toBe("partial");
    expect(
      aggregateDelegationStatus([
        { taskIndex: 0, status: "timed_out", durationMs: 1 },
        { taskIndex: 1, status: "timed_out", durationMs: 1 },
      ]),
    ).toBe("timed_out");
    expect(
      aggregateDelegationStatus([
        { taskIndex: 0, status: "cancelled", durationMs: 1 },
        { taskIndex: 1, status: "cancelled", durationMs: 1 },
      ]),
    ).toBe("cancelled");

    const taskRegistry = new TaskRegistry({ generateId: () => "a_aggregate" });
    const manager = new DelegationManager({ taskRegistry });
    const dispatched = manager.dispatch(async () => ({
      // 即使 runner 错填 completed，Manager 也必须按 children 重算。
      status: "completed",
      results: [
        { taskIndex: 0, status: "completed", summary: "kept", durationMs: 1 },
        { taskIndex: 1, status: "error", error: "broken", durationMs: 1 },
      ],
      totalDurationMs: 2,
    }));

    await manager.wait(dispatched.delegationId!);

    expect(manager.snapshot(dispatched.delegationId!)).toMatchObject({
      status: "partial",
      taskStatus: "partial",
      result: { status: "partial", results: [{ status: "completed" }, { status: "error" }] },
    });
    expect(taskRegistry.get(dispatched.taskId!)).toMatchObject({
      status: "failed",
      data: { aggregateStatus: "partial", result: { status: "partial" } },
    });

    const runner: AgentRunner = {
      async runSub() {
        throw new Error("all failed");
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry());
    const required = JSON.parse(
      await tool.execute(JSON.stringify({ tasks: [{ goal: "one" }, { goal: "two" }] })),
    ) as { status: string; results: Array<{ status: string }> };
    expect(required).toMatchObject({
      status: "error",
      results: [{ status: "error" }, { status: "error" }],
    });
  });

  it("optional 与 detached 失败写隐藏 completion，并在空闲时合并续跑一次", async () => {
    const envelopes: DelegationCompletionEnvelope[] = [];
    const hiddenMessages: ReturnType<typeof createDelegationCompletionMessage>[] = [];
    const queue = new DelegationCompletionWakeQueue({
      deliver: (completion) => {
        hiddenMessages.push(createDelegationCompletionMessage(completion));
      },
    });
    let idle = false;
    const resumed: Array<readonly number[]> = [];
    const deliveredActivityIds: string[][] = [];
    const coordinator = new DelegationWakeCoordinator({
      queue,
      isIdle: () => idle,
      resume: async (completionSeqs, deliverCompletions) => {
        resumed.push(completionSeqs);
        deliveredActivityIds.push(
          deliverCompletions().flatMap((completion) => completion.activityIds),
        );
      },
    });
    const manager = new DelegationManager({
      onCompletion: (completion) => {
        envelopes.push(completion);
        queue.enqueue(completion);
      },
    });
    const runner: AgentRunner = {
      async runSub(taskPrompt): Promise<SubagentResult> {
        if (taskPrompt === "detached-success") {
          return { summary: "silent success", artifacts: [] };
        }
        throw new Error(`failed:${taskPrompt}`);
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), manager);

    await tool.execute(JSON.stringify({ goal: "optional-failure", completion_policy: "optional" }));
    await tool.execute(JSON.stringify({ goal: "detached-failure", completion_policy: "detached" }));
    await tool.execute(JSON.stringify({ goal: "detached-success", completion_policy: "detached" }));
    await waitUntil(() => envelopes.length === 2);

    expect(resumed).toEqual([]);
    // 主 Agent 仍运行时不写入 Session，避免当前 run 消费后 idle 再重复续跑。
    expect(hiddenMessages).toEqual([]);
    expect(queue.hasPending).toBe(true);
    expect(queue.enqueue(envelopes[0]!)).toBe(false);

    idle = true;
    coordinator.notifyIdle();
    await waitUntil(() => resumed.length === 1 && hiddenMessages.length === 2);
    expect(hiddenMessages.map((message) => message.providerData?.picoKind)).toEqual([
      "subagent_completion",
      "subagent_completion",
    ]);
    expect(hiddenMessages[0]?.content).toContain("最多重新委派一次");
    expect(hiddenMessages[0]?.content).toContain("不要重做已完成范围");
    expect(envelopes.map((completion) => [completion.completionPolicy, completion.status])).toEqual(
      [
        ["optional", "error"],
        ["detached", "error"],
      ],
    );
    expect(resumed[0]).toEqual(envelopes.map((completion) => completion.completionSeq));
    expect(deliveredActivityIds[0]).toEqual(
      envelopes.flatMap((completion) => completion.activityIds),
    );
    expect(queue.hasPending).toBe(false);
    coordinator.dispose();
  });

  it("将有界任务契约与可信 workDir 传给子代理", async () => {
    const seenPrompts: string[] = [];
    let seenWorkDir: string | undefined;
    const runner: AgentRunner = {
      async runSub(taskPrompt, _registry, _reporter, options) {
        seenPrompts.push(taskPrompt);
        seenWorkDir = options?.workDir;
        return { summary: "bounded", artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), new DelegationManager(), {
      workDir: "/trusted/project",
    });
    const definition = tool.definition();

    expect(definition.description).toContain("禁止下达");
    expect(definition.inputSchema.properties).toMatchObject({
      roots: { type: "array" },
      max_files: { maximum: 100 },
      stopping_condition: { type: "string" },
      expected_output: { type: "string" },
    });

    await tool.execute(JSON.stringify({ goal: "默认边界" }));
    await tool.execute(
      JSON.stringify({
        goal: "检查认证边界",
        roots: ["src/auth", "/stale/project/src", "../escape", "tests\\auth"],
        max_files: 999,
        stopping_condition: "确认入口与失败路径后停止",
        expected_output: "列出证据文件和风险",
      }),
    );

    expect(seenPrompts[0]).toContain("允许根: .");
    expect(seenPrompts[0]).toContain("最多检查文件: 30");
    const seenPrompt = seenPrompts[1]!;
    expect(seenPrompt).toContain("[有界任务契约]");
    expect(seenPrompt).toContain("允许根: src/auth, tests/auth");
    expect(seenPrompt).toContain("最多检查文件: 100");
    expect(seenPrompt).toContain("停止条件: 确认入口与失败路径后停止");
    expect(seenPrompt).toContain("期望输出: 列出证据文件和风险");
    expect(seenWorkDir).toBe("/trusted/project");
  });

  it("递归委派继续继承当前子代理的可信 workDir", async () => {
    const runtimeWorkDir = await mkdtemp(join(tmpdir(), "pico-recursive-delegation-"));
    let seenWorkDir: string | undefined;
    const runner: AgentRunner = {
      async runSub(_taskPrompt, _registry, _reporter, options) {
        seenWorkDir = options?.workDir;
        return { summary: "nested result", artifacts: [] };
      },
    };

    try {
      const manager = new DelegationManager();
      const factory = createSubagentRegistryFactory({
        workDir: tmpdir(),
        runner,
        manager,
      });
      const registry = factory({
        mode: "explore",
        role: "orchestrator",
        depth: 0,
        maxSpawnDepth: 2,
        workDir: runtimeWorkDir,
      }) as ToolRegistry;

      const nestedDelegate = registry.getTool("delegate_task");
      expect(nestedDelegate).toBeDefined();
      const result = JSON.parse(
        await nestedDelegate!.execute(JSON.stringify({ goal: "继续排查" })),
      ) as {
        status: string;
      };

      expect(result.status).toBe("completed");
      expect(seenWorkDir).toBe(runtimeWorkDir);
    } finally {
      await rm(runtimeWorkDir, { recursive: true, force: true });
    }
  });

  it("TUI 内部续跑只透传 resume 标记，不追加可见用户输入", async () => {
    const reporter = new TuiReporter(() => undefined);
    let resumeExistingSession = false;

    await runTuiAgentPrompt(
      { prompt: "" },
      {
        reporter,
        resumeExistingSession: true,
        runAgent: async (options, dependencies) => {
          expect(options.prompt).toBe("");
          resumeExistingSession =
            (dependencies as typeof dependencies & { resumeExistingSession?: boolean })
              .resumeExistingSession === true;
          return {
            sessionId: "resume-session",
            sessionSelection: { mode: "new", sessionId: "resume-session" },
            workDir: "/tmp",
            finalMessage: "resumed",
            usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
            messages: [],
          };
        },
      },
    );

    expect(resumeExistingSession).toBe(true);
    expect(reporter.getProjection().entries.some((entry) => entry.entry.kind === "user")).toBe(
      false,
    );
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待委派状态超时");
}
