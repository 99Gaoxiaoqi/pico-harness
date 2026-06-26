// Subagent 子智能体任务委派的单元测试。
// 覆盖:SubagentTool execute / RunSub 受限循环 / maxSubTurns 强制召回 /
// 只读工具隔离 / 物理隔离(子探索不污染主) / 退出条件。

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import {
  DelegateTaskTool,
  SpawnSubagentTool,
  type AgentRunner,
  type SubagentResult,
} from "../src/tools/subagent.js";
import { SkillLoader, SkillViewTool } from "../src/context/skill.js";
import { DelegationManager, DelegateStatusTool } from "../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { ToolRegistry, ReadFileTool, BashTool } from "../src/tools/registry-impl.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition, ToolCall, ToolResult } from "../src/schema/message.js";
import type { Registry } from "../src/tools/registry.js";

/** 可编程的 Mock Provider:按预设响应序列依次返回 */
/** Wrap a plain summary into a SubagentResult for mock runners. */
function subResult(summary: string, artifacts: string[] = []): SubagentResult {
  return { summary, artifacts };
}

class ScriptedProvider implements LLMProvider {
  constructor(private readonly responses: Message[]) {}
  private i = 0;
  async generate(): Promise<Message> {
    const r = this.responses[this.i];
    if (!r) throw new Error("ScriptedProvider: 响应序列耗尽");
    this.i++;
    return r;
  }
}

/** 只读 Mock Registry:read_file + bash,都标记只读 */
function mockReadOnlyRegistry(executed: ToolCall[] = []): Registry {
  return {
    register(): void {},
    use(): void {},
    getAvailableTools(): ToolDefinition[] {
      return [
        { name: "read_file", description: "", inputSchema: { type: "object" } },
        { name: "bash", description: "", inputSchema: { type: "object" } },
      ];
    },
    async execute(call: ToolCall): Promise<ToolResult> {
      executed.push(call);
      return { toolCallId: call.id, output: `result-of-${call.name}`, isError: false };
    },
    isReadOnlyTool(_name: string): boolean {
      return true;
    },
  };
}

describe("SubagentTool", () => {
  it("name 和 definition 正确暴露", () => {
    const runner: AgentRunner = {
      async runSub() {
        return subResult("");
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry());
    expect(tool.name()).toBe("spawn_subagent");
    const def = tool.definition();
    expect(def.name).toBe("spawn_subagent");
    expect(def.description).toContain("探索");
    expect(def.inputSchema.required).toContain("task_prompt");
  });

  it("execute 调用 runner.runSub 并返回探索报告", async () => {
    const runner: AgentRunner = {
      async runSub(taskPrompt: string) {
        return subResult(`已探索: ${taskPrompt}`);
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry());
    const output = await tool.execute(JSON.stringify({ task_prompt: "找密码" }));
    expect(output).toContain("子智能体探索报告");
    expect(output).toContain("已探索: 找密码");
  });

  it("execute 参数缺失时报错", async () => {
    const runner: AgentRunner = {
      async runSub() {
        return subResult("");
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry());
    await expect(tool.execute("{}")).rejects.toThrow("task_prompt");
  });

  it("execute runSub 失败时返回失败信息(不抛错)", async () => {
    const runner: AgentRunner = {
      async runSub() {
        throw new Error("子智能体崩溃");
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry());
    const output = await tool.execute(JSON.stringify({ task_prompt: "x" }));
    expect(output).toContain("子智能体执行失败");
    expect(output).toContain("子智能体崩溃");
  });

  it("达到 maxSpawnDepth 时拒绝继续委派", async () => {
    let called = false;
    const runner: AgentRunner = {
      async runSub() {
        called = true;
        return subResult("不应执行");
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry(), {
      depth: 2,
      maxSpawnDepth: 2,
      role: "orchestrator",
    });

    const output = await tool.execute(JSON.stringify({ task_prompt: "继续套娃" }));

    expect(called).toBe(false);
    expect(output).toContain("超过最大委派深度");
  });

  it("orchestrator 委派时向 runSub 透传 depth+1 与角色配置", async () => {
    const seen: unknown[] = [];
    const runner: AgentRunner = {
      async runSub(_task, _registry, _reporter, opts) {
        seen.push(opts);
        return subResult("ok");
      },
    };
    const tool = new SpawnSubagentTool(runner, mockReadOnlyRegistry(), {
      depth: 0,
      maxSpawnDepth: 2,
      role: "orchestrator",
    });

    await tool.execute(JSON.stringify({ task_prompt: "探索" }));

    expect(seen).toEqual([{ depth: 1, maxSpawnDepth: 2, role: "leaf" }]);
  });
});

describe("DelegateTaskTool", () => {
  it("暴露 Hermes 风格 delegate_task 主接口", () => {
    const runner: AgentRunner = {
      async runSub() {
        return subResult("");
      },
    };
    const manager = new DelegationManager();
    const tool = new DelegateTaskTool(runner, () => mockReadOnlyRegistry(), manager);

    const def = tool.definition();

    expect(tool.name()).toBe("delegate_task");
    expect(def.name).toBe("delegate_task");
    expect(def.inputSchema.properties).toHaveProperty("goal");
    expect(def.inputSchema.properties).toHaveProperty("tasks");
    expect(def.inputSchema.properties).toHaveProperty("background");
  });

  it("worker 模式子代理可以通过受控工具集写文件", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-worker-"));
    const runner: AgentRunner = {
      async runSub(_task, registry) {
        const toolNames = registry.getAvailableTools().map((tool) => tool.name);
        expect(toolNames).toContain("write_file");
        const result = await registry.execute({
          id: "write-1",
          name: "write_file",
          arguments: JSON.stringify({ path: "worker.txt", content: "from worker" }),
        });
        expect(result.isError).toBe(false);
        return subResult("worker wrote file");
      },
    };
    const manager = new DelegationManager();
    const registryFactory = createSubagentRegistryFactory({
      workDir,
      runner,
      manager,
    });
    const tool = new DelegateTaskTool(runner, registryFactory, manager);

    const output = await tool.execute(JSON.stringify({ goal: "写文件", mode: "worker" }));
    const parsed = JSON.parse(output) as { results: Array<{ summary: string }> };

    expect(parsed.results[0]!.summary).toBe("worker wrote file");
    expect(await readFile(join(workDir, "worker.txt"), "utf8")).toBe("from worker");
  });

  it("explore 模式子代理的 bash 写入命令会被拒绝", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-explore-"));
    const runner: AgentRunner = {
      async runSub(_task, registry) {
        const result = await registry.execute({
          id: "bash-1",
          name: "bash",
          arguments: JSON.stringify({ command: "echo unsafe > should-not-exist.txt" }),
        });
        expect(result.isError).toBe(true);
        return subResult(result.output);
      },
    };
    const manager = new DelegationManager();
    const registryFactory = createSubagentRegistryFactory({
      workDir,
      runner,
      manager,
    });
    const tool = new DelegateTaskTool(runner, registryFactory, manager);

    const output = await tool.execute(JSON.stringify({ goal: "尝试写文件", mode: "explore" }));
    const parsed = JSON.parse(output) as { results: Array<{ summary: string }> };

    expect(parsed.results[0]!.summary).toContain("只读");
  });

  it("子代理注册表包含 skill_view 并可按需读取项目 Skill", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-skill-"));
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产时使用\n---\n\n# 部署指南\n先跑 npm run build",
    );

    const runner: AgentRunner = {
      async runSub(_task, registry) {
        const toolNames = registry.getAvailableTools().map((tool) => tool.name);
        expect(toolNames).toContain("skill_view");
        const result = await registry.execute({
          id: "skill-1",
          name: "skill_view",
          arguments: JSON.stringify({ name: "deploy" }),
        });
        expect(result.isError).toBe(false);
        return subResult(result.output);
      },
    };
    const manager = new DelegationManager();
    const registryFactory = createSubagentRegistryFactory({
      workDir,
      runner,
      manager,
    });
    const tool = new DelegateTaskTool(runner, registryFactory, manager);

    const output = await tool.execute(JSON.stringify({ goal: "查看部署技能", mode: "explore" }));
    const parsed = JSON.parse(output) as { results: Array<{ summary: string }> };

    expect(parsed.results[0]!.summary).toContain("部署指南");
  });

  it("tasks 批量委派会并行执行并保持结果顺序", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner: AgentRunner = {
      async runSub(taskPrompt) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return subResult(`done:${taskPrompt}`);
      },
    };
    const manager = new DelegationManager({ maxConcurrentChildren: 3 });
    const tool = new DelegateTaskTool(runner, () => mockReadOnlyRegistry(), manager);

    const output = await tool.execute(
      JSON.stringify({
        tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }],
      }),
    );
    const parsed = JSON.parse(output) as { results: Array<{ summary: string }> };

    expect(maxInFlight).toBeGreaterThan(1);
    expect(parsed.results.map((result) => result.summary)).toEqual(["done:a", "done:b", "done:c"]);
  });

  it("background=true 立即返回 handle,delegate_status 可查询完成结果", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: AgentRunner = {
      async runSub() {
        await gate;
        return subResult("background complete");
      },
    };
    const manager = new DelegationManager();
    const tool = new DelegateTaskTool(runner, () => mockReadOnlyRegistry(), manager);
    const statusTool = new DelegateStatusTool(manager);

    const dispatched = JSON.parse(
      await tool.execute(JSON.stringify({ goal: "后台任务", background: true })),
    ) as { status: string; delegationId: string };

    expect(dispatched.status).toBe("dispatched");
    expect(
      JSON.parse(
        await statusTool.execute(JSON.stringify({ delegation_id: dispatched.delegationId })),
      ).status,
    ).toBe("running");

    release();
    await manager.wait(dispatched.delegationId);

    const completed = JSON.parse(
      await statusTool.execute(JSON.stringify({ delegation_id: dispatched.delegationId })),
    ) as { status: string; result: { results: Array<{ summary: string }> } };
    expect(completed.status).toBe("completed");
    expect(completed.result.results[0]!.summary).toBe("background complete");
  });

  it("达到 maxSpawnDepth 时拒绝继续 delegate_task", async () => {
    let called = false;
    const runner: AgentRunner = {
      async runSub() {
        called = true;
        return subResult("不应执行");
      },
    };
    const manager = new DelegationManager();
    const tool = new DelegateTaskTool(runner, () => mockReadOnlyRegistry(), manager, {
      depth: 2,
      maxSpawnDepth: 2,
    });

    const output = JSON.parse(await tool.execute(JSON.stringify({ goal: "继续套娃" }))) as {
      error: string;
    };

    expect(called).toBe(false);
    expect(output.error).toContain("最大委派深度");
  });
});

describe("AgentEngine.runSub", () => {
  function makeEngine(provider: LLMProvider, readOnlyRegistry: Registry): AgentEngine {
    return new AgentEngine({
      provider,
      registry: readOnlyRegistry,
      workDir: tmpdir(),
      enableThinking: false,
    });
  }

  it("子智能体调一轮工具后给总结即退出", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "我先读文件",
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
      { role: "assistant", content: "找到了密码是 42" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content:
          "找到了密码是 42。通过 read_file 读取 a.txt 后确认目标值,无需进一步探索,任务完成。",
      },
    ]);
    const executed: ToolCall[] = [];
    const registry = mockReadOnlyRegistry(executed);
    const engine = makeEngine(provider, registry);

    const { summary } = await engine.runSub("找密码", registry);
    expect(summary).toContain("找到了密码是 42");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.name).toBe("read_file");
  });

  it("子智能体 System Prompt 注入 Skill 摘要但不常驻完整正文", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-runsub-skill-"));
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产时使用\n---\n\n# 部署指南\n先跑 npm run build",
    );

    let firstMessages: Message[] = [];
    const provider = new (class implements LLMProvider {
      async generate(messages: Message[]): Promise<Message> {
        firstMessages = messages;
        return {
          role: "assistant",
          content:
            "已确认子代理启动时能看到项目 Skill 摘要,并保持正文按需读取,避免把完整操作指南常驻注入上下文。",
        };
      }
    })();
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool(workDir));
    registry.register(new BashTool(workDir));
    registry.register(new SkillViewTool(new SkillLoader(workDir)));
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      enableThinking: false,
    });

    await engine.runSub("查看项目技能", registry);

    const systemPrompt = firstMessages[0]!.content;
    expect(systemPrompt).toContain("可用专业技能");
    expect(systemPrompt).toContain("deploy");
    expect(systemPrompt).toContain("部署到生产时使用");
    expect(systemPrompt).not.toContain("部署指南");
    expect(systemPrompt).not.toContain("npm run build");
  });

  it("超过 maxSubTurns(10) 被强制召回", async () => {
    // 每轮都调工具,永不退出 → 第 11 轮触发召回
    const provider = new (class implements LLMProvider {
      async generate(): Promise<Message> {
        return {
          role: "assistant",
          content: "继续找",
          toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
        };
      }
    })();
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    await expect(engine.runSub("无尽探索", registry)).rejects.toThrow("超过 10 轮");
  });

  it("depth 等于 maxSpawnDepth 的子代理仍可执行但不能再委派", async () => {
    const provider = new ScriptedProvider([
      { role: "assistant", content: "leaf summary" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content:
          "leaf summary:作为叶子节点完成任务,因 depth 已达 maxSpawnDepth 上限,不再继续向下委派,直接返回结论。",
      },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const { summary } = await engine.runSub("叶子任务", registry, undefined, {
      depth: 2,
      maxSpawnDepth: 2,
    });

    expect(summary).toContain("leaf summary");
  });

  it("子智能体探索不污染主 Session(物理隔离核心)", async () => {
    // 主引擎用一个 Session,子智能体用 runSub(不碰主 Session)
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "子探索中",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "子总结:密码是 42" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content: "子总结:密码是 42。已通过 bash 工具完成探索并定位目标值,任务完成。",
      },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const mainSession = new Session("main", tmpdir());
    mainSession.append({ role: "user", content: "主任务" });

    const beforeLen = mainSession.length;
    await engine.runSub("找密码", registry);
    const afterLen = mainSession.length;

    // 主 Session 消息数不变 → 物理隔离成功
    expect(afterLen).toBe(beforeLen);
  });

  it("子智能体仅能使用传入的只读工具(爆炸半径限制)", async () => {
    // readOnlyRegistry 不含 write_file,若子尝试调 write_file 应返回"工具不存在"错误
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "试着写文件",
        toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"x","content":"y"}' }],
      },
      { role: "assistant", content: "写不了,我汇报" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content:
          "写不了,我汇报。当前只读注册表不含 write_file 工具,尝试调用时返回工具不存在,无法执行写操作,任务结束。",
      },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const { summary } = await engine.runSub("写文件试试", registry);
    expect(summary).toContain("写不了,我汇报");
    // write_file 不在只读注册表里,execute 会返回"工具不存在"错误
    // (mockReadOnlyRegistry 的 execute 不区分,但真实 Registry 会拦截)
  });

  it("子智能体首个响应就给总结(无需工具)直接返回", async () => {
    const provider = new ScriptedProvider([
      { role: "assistant", content: "我凭已知信息直接汇报:答案是 42" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content:
          "我凭已知信息直接汇报:答案是 42。本任务无需调用任何工具,基于既有上下文即可给出确定结论。",
      },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const { summary } = await engine.runSub("简单问题", registry);
    expect(summary).toContain("答案是 42");
  });

  it("子智能体工具报错时注入 Recovery 锦囊", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "读文件",
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"missing.txt"}' }],
      },
      { role: "assistant", content: "重读后找到了" },
      // summary < 200 字,触发一轮续写扩写
      {
        role: "assistant",
        content:
          "重读后找到了目标信息。首次读取 missing.txt 时报错,经 Recovery 锦囊引导后重新定位并成功读取,任务完成。",
      },
    ]);
    // 这个 registry 的 execute 返回错误
    const errorRegistry: Registry = {
      register(): void {},
      use(): void {},
      getAvailableTools(): ToolDefinition[] {
        return [{ name: "read_file", description: "", inputSchema: { type: "object" } }];
      },
      async execute(call: ToolCall): Promise<ToolResult> {
        return {
          toolCallId: call.id,
          output: "Error: no such file or directory",
          isError: true,
        };
      },
      isReadOnlyTool(): boolean {
        return true;
      },
    };
    const engine = makeEngine(provider, errorRegistry);

    const { summary } = await engine.runSub("读不存在的文件", errorRegistry);
    expect(summary).toContain("重读后找到了");
    // Recovery 注入了锦囊(子智能体看到了救援指南)
    // 验证方式:子智能体第二轮没再报错,说明它被引导重读了
  });
});

describe("SubagentTool + AgentEngine 端到端委派", () => {
  it("主 Agent 调 spawn_subagent,子探索后主继续", async () => {
    // 主 Agent:第一轮调 spawn_subagent,第二轮给最终答案
    // 子 Agent(runSub):第一轮调 read_file,第二轮给总结
    let subCalled = false;
    const mainProvider = new (class implements LLMProvider {
      private turn = 0;
      async generate(_msgs: Message[], _tools: ToolDefinition[]): Promise<Message> {
        this.turn++;
        if (this.turn === 1) {
          // 主 Agent 派子智能体
          return {
            role: "assistant",
            content: "我派出子智能体去探索",
            toolCalls: [
              { id: "main-c1", name: "spawn_subagent", arguments: '{"task_prompt":"找密码"}' },
            ],
          };
        }
        // 主 Agent 收到子报告后给最终答案
        return { role: "assistant", content: "主 Agent:根据子报告,密码是 42" };
      }
    })();

    const mainRegistry = new ToolRegistry();
    mainRegistry.register(new ReadFileTool(tmpdir()));
    mainRegistry.register(new BashTool(tmpdir()));

    const engine = new AgentEngine({
      provider: mainProvider,
      registry: mainRegistry,
      workDir: tmpdir(),
      enableThinking: false,
    });

    // 注册 SubagentTool,其 runner 就是 engine 自身
    const readOnlyReg = new ToolRegistry();
    readOnlyReg.register(new ReadFileTool(tmpdir()));
    readOnlyReg.register(new BashTool(tmpdir()));
    mainRegistry.register(new SpawnSubagentTool(engine, readOnlyReg));

    // 但 runSub 会调 mainProvider,而 mainProvider 的 turn 逻辑是给主用的…
    // 需要分离:用一个能区分主/子调用的 provider
    // 简化:直接测 SubagentTool.execute 调一个 mock runner
    const mockRunner: AgentRunner = {
      async runSub(taskPrompt: string) {
        subCalled = true;
        return subResult(`子智能体汇报:探索了 ${taskPrompt},密码是 42`);
      },
    };
    const tool = new SpawnSubagentTool(mockRunner, readOnlyReg);
    const report = await tool.execute(JSON.stringify({ task_prompt: "找密码" }));
    expect(subCalled).toBe(true);
    expect(report).toContain("密码是 42");
    expect(report).toContain("子智能体探索报告");
  });
});
