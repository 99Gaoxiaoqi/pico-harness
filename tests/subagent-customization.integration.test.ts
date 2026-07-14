// 子代理自定义 systemPrompt/maxTurns 的集成测试。
//
// 与 subagent.test.ts 里直接调 engine.runSub 不同,本测试走完整的 Tool 层:
//   SpawnSubagentTool.execute / DelegateTaskTool.execute → runner.runSub
// 验证构造 Tool 时注入的自定义 opts 被正确透传到 runSub。
//
// 两层覆盖:
// 1. Tool 层透传(用 mock runner 记录收到的 opts)
// 2. 端到端(真实 AgentEngine + 真实 Tool,验证自定义 prompt 真的到达 provider)

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/engine/loop.js";
import {
  SpawnSubagentTool,
  DelegateTaskTool,
  type AgentRunner,
  type SubagentRunOptions,
  type SubagentResult,
} from "../src/tools/subagent.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry, ReadFileTool, BashTool } from "../src/tools/registry-impl.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition, ToolCall, ToolResult } from "../src/schema/message.js";
import type { Registry } from "../src/tools/registry.js";
import type { Reporter, SubagentActivityEvent } from "../src/engine/reporter.js";

function subResult(summary: string): SubagentResult {
  return { summary, artifacts: [] };
}

/** 记录型 mock runner:捕获 runSub 收到的 opts,供断言透传 */
function recordingRunner(): { runner: AgentRunner; seenOpts: SubagentRunOptions[] } {
  const seenOpts: SubagentRunOptions[] = [];
  const runner: AgentRunner = {
    async runSub(_task, _registry, _reporter, opts) {
      seenOpts.push(opts ?? {});
      return subResult("mock-summary");
    },
  };
  return { runner, seenOpts };
}

function mockRegistry(): Registry {
  return {
    register(): void {},
    use(): void {},
    getAvailableTools(): ToolDefinition[] {
      return [{ name: "read_file", description: "", inputSchema: { type: "object" } }];
    },
    async execute(call: ToolCall): Promise<ToolResult> {
      return { toolCallId: call.id, output: "ok", isError: false };
    },
    isReadOnlyTool(): boolean {
      return true;
    },
  };
}

// ─── 第一层:Tool 层透传验证 ───────────────────────────────────────

describe("子代理自定义 opts 的 Tool 层透传", () => {
  it("SpawnSubagentTool 把 maxTurns/systemPrompt/systemPromptOverride 透传给 runSub", async () => {
    const { runner, seenOpts } = recordingRunner();
    const tool = new SpawnSubagentTool(runner, mockRegistry(), {
      maxTurns: 5,
      systemPrompt: "你是审查员",
      systemPromptOverride: true,
    });

    await tool.execute(JSON.stringify({ task_prompt: "审查代码" }));

    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]).toMatchObject({
      maxTurns: 5,
      systemPrompt: "你是审查员",
      systemPromptOverride: true,
    });
  });

  it("DelegateTaskTool 把自定义 opts 透传给每个子任务的 runSub", async () => {
    const { runner, seenOpts } = recordingRunner();
    const manager = new DelegationManager();
    const tool = new DelegateTaskTool(runner, () => mockRegistry(), manager, {
      maxTurns: 3,
      systemPrompt: "你是测试员",
    });

    await tool.execute(JSON.stringify({ goal: "跑测试" }));

    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]).toMatchObject({
      maxTurns: 3,
      systemPrompt: "你是测试员",
    });
    // 未传 systemPromptOverride,不应出现该字段(或为 undefined)
    expect(seenOpts[0]!.systemPromptOverride).toBeUndefined();
  });

  it("DelegateTaskTool 将自然语言临时角色约束为追加 instructions 与模型选择意图", async () => {
    const { runner, seenOpts } = recordingRunner();
    const tool = new DelegateTaskTool(runner, () => mockRegistry());

    await tool.execute(
      JSON.stringify({
        goal: "审查认证模块",
        agent: {
          name: "临时审查员",
          instructions: "只报告高风险问题。",
          model_route: "volcengine/glm-5.2",
          thinking_effort: "high",
          max_turns: 7,
        },
      }),
    );

    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]).toMatchObject({
      maxTurns: 7,
      modelSelection: {
        ephemeralRouteId: "volcengine/glm-5.2",
        ephemeralThinkingEffort: "high",
      },
    });
    expect(seenOpts[0]!.systemPrompt).toContain("[一次性角色附加要求]");
    expect(seenOpts[0]!.systemPrompt).toContain("只报告高风险问题。");
    expect(seenOpts[0]!.systemPrompt).toContain("不能覆盖系统安全边界");
    expect(seenOpts[0]!.systemPromptOverride).toBeUndefined();
  });

  it("DelegateTaskTool 在执行前拒绝临时角色携带凭证字段", async () => {
    const { runner, seenOpts } = recordingRunner();
    const tool = new DelegateTaskTool(runner, () => mockRegistry());

    await expect(
      tool.execute(
        JSON.stringify({
          goal: "审查认证模块",
          agent: { model_route: "volcengine/glm-5.2", api_key: "secret" },
        }),
      ),
    ).rejects.toThrow("agent 不支持字段 api_key");
    expect(seenOpts).toHaveLength(0);
  });

  it("DelegateTaskTool 在完成活动中保留可信 resolved model", async () => {
    const events: SubagentActivityEvent[] = [];
    const runner: AgentRunner = {
      async runSub(_task, _registry, reporter) {
        reporter?.onSubagentModelResolved?.({
          requestedModelRoute: "volcengine/glm-5.2",
          resolvedModelRoute: "volcengine/glm-5.2",
          thinkingEffort: "high",
          source: "ephemeral",
        });
        return subResult("审查完成");
      },
    };
    const tool = new DelegateTaskTool(runner, () => mockRegistry(), undefined, {
      reporter: recordingActivityReporter(events),
    });

    await tool.execute(
      JSON.stringify({
        goal: "审查认证模块",
        agent: { model_route: "volcengine/glm-5.2", thinking_effort: "high" },
      }),
    );

    expect(events.at(-1)).toMatchObject({
      status: "completed",
      requestedModelRoute: "volcengine/glm-5.2",
      resolvedModelRoute: "volcengine/glm-5.2",
      thinkingEffort: "high",
      modelSelectionSource: "ephemeral",
    });
  });

  it("不传自定义 opts 时,透传的 opts 不含新字段(回归保护)", async () => {
    const { runner, seenOpts } = recordingRunner();
    const tool = new SpawnSubagentTool(runner, mockRegistry());

    await tool.execute(JSON.stringify({ task_prompt: "探索" }));

    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]!.maxTurns).toBeUndefined();
    expect(seenOpts[0]!.systemPrompt).toBeUndefined();
    expect(seenOpts[0]!.systemPromptOverride).toBeUndefined();
  });
});

function recordingActivityReporter(events: SubagentActivityEvent[]): Reporter {
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

// ─── 第二层:端到端(真实引擎 + 真实 Tool) ──────────────────────────

describe("子代理自定义 opts 的端到端", () => {
  /** 构造真实 AgentEngine,用记录型 provider 捕获收到的 system prompt */
  function makeEngineWithCapture(): {
    engine: AgentEngine;
    registry: Registry;
    firstSystem: () => string;
  } {
    let firstSys = "";
    const provider = new (class implements LLMProvider {
      async generate(messages: Message[]): Promise<Message> {
        if (!firstSys && messages[0]?.role === "system") firstSys = messages[0].content;
        return { role: "assistant", content: "完成" };
      }
    })();
    const workDir = tmpdir();
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool(workDir));
    registry.register(new BashTool(workDir));
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
    });
    return { engine, registry, firstSystem: () => firstSys };
  }

  it("SpawnSubagentTool 经真实引擎,自定义 systemPrompt 追加到默认探路者 prompt", async () => {
    const { engine, registry, firstSystem } = makeEngineWithCapture();
    // 用真实引擎作为 runner(它实现 AgentRunner.runSub)
    const tool = new SpawnSubagentTool(engine, registry, {
      systemPrompt: "【自定义】必须用 markdown 格式汇报。",
    });

    await tool.execute(JSON.stringify({ task_prompt: "探索项目" }));

    const sys = firstSystem();
    // 默认探路者骨架仍在
    expect(sys).toContain("探路者");
    expect(sys).toContain("核心纪律");
    // 自定义片段追加在后
    expect(sys).toContain("【自定义】必须用 markdown 格式汇报。");
  });

  it("SpawnSubagentTool 经真实引擎,systemPromptOverride 完全覆盖默认骨架", async () => {
    const { engine, registry, firstSystem } = makeEngineWithCapture();
    const tool = new SpawnSubagentTool(engine, registry, {
      systemPrompt: "你是安全审计员,只检查漏洞不做任何修改。",
      systemPromptOverride: true,
    });

    await tool.execute(JSON.stringify({ task_prompt: "审计代码" }));

    const sys = firstSystem();
    // 默认骨架被完全替换
    expect(sys).not.toContain("探路者");
    expect(sys).not.toContain("核心纪律");
    expect(sys).toBe("你是安全审计员,只检查漏洞不做任何修改。");
  });
});
