// 自定义子代理角色(agent_name)的集成测试。
//
// 验证完整的 .claw/agents.yaml → delegate_task(agent_name) → factory + runSub 链路:
// 1. delegate_task 传 agent_name 时,registryFactory 收到 agentName(选对工具集)
// 2. runSub 收到 profile 的 systemPrompt/maxTurns(而非 Tool 级默认)
// 3. 未传 agent_name 时行为不变(回归)

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegateTaskTool,
  type AgentRunner,
  type SubagentRunOptions,
  type SubagentResult,
} from "../src/tools/subagent.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { type AgentProfile } from "../src/tools/agent-profile.js";
import type { Registry } from "../src/tools/registry.js";
import type { ToolDefinition, ToolCall, ToolResult } from "../src/schema/message.js";

function subResult(summary: string): SubagentResult {
  return { summary, artifacts: [] };
}

/** 记录型 mock runner + 捕获 factory 收到的 request */
function setup(): {
  runner: AgentRunner;
  manager: DelegationManager;
  seenOpts: SubagentRunOptions[];
  seenRequests: Array<{ mode: string; agentName?: string }>;
  factory: (req: {
    mode: string;
    role: string;
    depth: number;
    maxSpawnDepth: number;
    agentName?: string;
  }) => Registry;
} {
  const seenOpts: SubagentRunOptions[] = [];
  const seenRequests: Array<{ mode: string; agentName?: string }> = [];

  const runner: AgentRunner = {
    async runSub(_task, _reg, _rep, opts) {
      seenOpts.push(opts ?? {});
      return subResult("ok");
    },
  };
  const manager = new DelegationManager();

  // 用一个简化的 factory:记录 request,返回 mock registry
  const factory = (req: { mode: string; agentName?: string }) => {
    seenRequests.push(req);
    return mockRegistry();
  };
  return { runner, manager, seenOpts, seenRequests, factory };
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

const PROFILES: AgentProfile[] = [
  {
    name: "auditor",
    description: "审查员",
    systemPrompt: "你是安全审查员,只读不修改。",
    systemPromptOverride: true,
    maxTurns: 5,
    tools: ["read_file", "bash"],
  },
  {
    name: "tester",
    description: "测试员",
    systemPrompt: "你是测试工程师。",
    maxTurns: 15,
    tools: ["read_file", "write_file"],
  },
];

describe("delegate_task 的 agent_name 自定义角色(集成)", () => {
  it("传 agent_name 时,registryFactory 收到 agentName", async () => {
    const { runner, manager, seenRequests, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(JSON.stringify({ goal: "审查代码", agent_name: "auditor" }));

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]!.agentName).toBe("auditor");
  });

  it("传 agent_name 时,runSub 收到 profile 的 systemPrompt/maxTurns/override", async () => {
    const { runner, manager, seenOpts, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(JSON.stringify({ goal: "审查", agent_name: "auditor" }));

    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0]!.systemPrompt).toBe("你是安全审查员,只读不修改。");
    expect(seenOpts[0]!.systemPromptOverride).toBe(true);
    expect(seenOpts[0]!.maxTurns).toBe(5);
  });

  it("传 agent_name=tester 时,用 tester 的 prompt 和 maxTurns", async () => {
    const { runner, manager, seenOpts, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(JSON.stringify({ goal: "写测试", agent_name: "tester" }));

    expect(seenOpts[0]!.systemPrompt).toBe("你是测试工程师。");
    expect(seenOpts[0]!.systemPromptOverride).toBeUndefined();
    expect(seenOpts[0]!.maxTurns).toBe(15);
  });

  it("未传 agent_name 时,行为不变(回归)", async () => {
    const { runner, manager, seenOpts, seenRequests, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(JSON.stringify({ goal: "探索", mode: "explore" }));

    expect(seenRequests[0]!.agentName).toBeUndefined();
    // 未命中 profile → 透传 Tool 级 options(这里没传,所以全 undefined)
    expect(seenOpts[0]!.systemPrompt).toBeUndefined();
    expect(seenOpts[0]!.maxTurns).toBeUndefined();
  });

  it("传了不存在的 agent_name,回落到默认(忽略 profile)", async () => {
    const { runner, manager, seenOpts, seenRequests, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(JSON.stringify({ goal: "任务", agent_name: "nonexistent" }));

    // agentName 仍透传给 factory(factory 内部会回落到 explore/worker)
    expect(seenRequests[0]!.agentName).toBe("nonexistent");
    // 但 profile 未命中 → 不注入 profile 的 prompt/maxTurns
    expect(seenOpts[0]!.systemPrompt).toBeUndefined();
    expect(seenOpts[0]!.maxTurns).toBeUndefined();
  });

  it("tasks 数组里的每个任务可独立指定 agent_name", async () => {
    const { runner, manager, seenOpts, factory } = setup();
    const tool = new DelegateTaskTool(runner, factory as never, manager, { profiles: PROFILES });

    await tool.execute(
      JSON.stringify({
        tasks: [
          { goal: "审查", agent_name: "auditor" },
          { goal: "测试", agent_name: "tester" },
        ],
      }),
    );

    expect(seenOpts).toHaveLength(2);
    expect(seenOpts[0]!.systemPrompt).toBe("你是安全审查员,只读不修改。");
    expect(seenOpts[1]!.systemPrompt).toBe("你是测试工程师。");
  });

  it("createSubagentRegistryFactory 带 profiles 时,agent_name 命中返回 profile 的工具集", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-factory-profile-"));
    try {
      const { runner, manager } = setup();
      const factory = createSubagentRegistryFactory({
        workDir,
        runner,
        manager,
        profiles: PROFILES,
      });

      // agent_name=auditor 命中 profile
      const registry = factory({
        mode: "explore",
        role: "leaf",
        depth: 1,
        maxSpawnDepth: 2,
        agentName: "auditor",
      });

      const toolNames = registry
        .getAvailableTools()
        .map((t) => t.name)
        .sort();
      // auditor profile 声明了 [read_file, bash],外加 delegate_status
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("bash");
      // 不含 worker 才有的 write/edit(auditor 没声明)
      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("edit_file");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
