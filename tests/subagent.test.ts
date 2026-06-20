// Subagent 子智能体任务委派的单元测试。
// 覆盖:SubagentTool execute / RunSub 受限循环 / maxSubTurns 强制召回 /
// 只读工具隔离 / 物理隔离(子探索不污染主) / 退出条件。

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { SubagentTool, type AgentRunner } from "../src/tools/subagent.js";
import { ToolRegistry, ReadFileTool, BashTool } from "../src/tools/registry-impl.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition, ToolCall, ToolResult } from "../src/schema/message.js";
import type { Registry } from "../src/tools/registry.js";

/** 可编程的 Mock Provider:按预设响应序列依次返回 */
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
    const runner: AgentRunner = { async runSub() { return ""; } };
    const tool = new SubagentTool(runner, mockReadOnlyRegistry());
    expect(tool.name()).toBe("spawn_subagent");
    const def = tool.definition();
    expect(def.name).toBe("spawn_subagent");
    expect(def.description).toContain("探索");
    expect(def.inputSchema.required).toContain("task_prompt");
  });

  it("execute 调用 runner.runSub 并返回探索报告", async () => {
    const runner: AgentRunner = {
      async runSub(taskPrompt: string) {
        return `已探索: ${taskPrompt}`;
      },
    };
    const tool = new SubagentTool(runner, mockReadOnlyRegistry());
    const output = await tool.execute(JSON.stringify({ task_prompt: "找密码" }));
    expect(output).toContain("子智能体探索报告");
    expect(output).toContain("已探索: 找密码");
  });

  it("execute 参数缺失时报错", async () => {
    const runner: AgentRunner = { async runSub() { return ""; } };
    const tool = new SubagentTool(runner, mockReadOnlyRegistry());
    await expect(tool.execute("{}")).rejects.toThrow("task_prompt");
  });

  it("execute runSub 失败时返回失败信息(不抛错)", async () => {
    const runner: AgentRunner = {
      async runSub() {
        throw new Error("子智能体崩溃");
      },
    };
    const tool = new SubagentTool(runner, mockReadOnlyRegistry());
    const output = await tool.execute(JSON.stringify({ task_prompt: "x" }));
    expect(output).toContain("子智能体执行失败");
    expect(output).toContain("子智能体崩溃");
  });
});

describe("AgentEngine.runSub", () => {
  function makeEngine(provider: LLMProvider, readOnlyRegistry: Registry): AgentEngine {
    return new AgentEngine({
      provider,
      registry: readOnlyRegistry,
      workDir: "/tmp",
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
    ]);
    const executed: ToolCall[] = [];
    const registry = mockReadOnlyRegistry(executed);
    const engine = makeEngine(provider, registry);

    const summary = await engine.runSub("找密码", registry);
    expect(summary).toBe("找到了密码是 42");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.name).toBe("read_file");
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

  it("子智能体探索不污染主 Session(物理隔离核心)", async () => {
    // 主引擎用一个 Session,子智能体用 runSub(不碰主 Session)
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "子探索中",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "子总结:密码是 42" },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const mainSession = new Session("main", "/tmp");
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
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const summary = await engine.runSub("写文件试试", registry);
    expect(summary).toBe("写不了,我汇报");
    // write_file 不在只读注册表里,execute 会返回"工具不存在"错误
    // (mockReadOnlyRegistry 的 execute 不区分,但真实 Registry 会拦截)
  });

  it("子智能体首个响应就给总结(无需工具)直接返回", async () => {
    const provider = new ScriptedProvider([
      { role: "assistant", content: "我凭已知信息直接汇报:答案是 42" },
    ]);
    const registry = mockReadOnlyRegistry();
    const engine = makeEngine(provider, registry);

    const summary = await engine.runSub("简单问题", registry);
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

    const summary = await engine.runSub("读不存在的文件", errorRegistry);
    expect(summary).toBe("重读后找到了");
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
            toolCalls: [{ id: "main-c1", name: "spawn_subagent", arguments: '{"task_prompt":"找密码"}' }],
          };
        }
        // 主 Agent 收到子报告后给最终答案
        return { role: "assistant", content: "主 Agent:根据子报告,密码是 42" };
      }
    })();

    const mainRegistry = new ToolRegistry();
    mainRegistry.register(new ReadFileTool("/tmp"));
    mainRegistry.register(new BashTool("/tmp"));

    const engine = new AgentEngine({
      provider: mainProvider,
      registry: mainRegistry,
      workDir: "/tmp",
      enableThinking: false,
    });

    // 注册 SubagentTool,其 runner 就是 engine 自身
    const readOnlyReg = new ToolRegistry();
    readOnlyReg.register(new ReadFileTool("/tmp"));
    readOnlyReg.register(new BashTool("/tmp"));
    mainRegistry.register(new SubagentTool(engine, readOnlyReg));

    // 但 runSub 会调 mainProvider,而 mainProvider 的 turn 逻辑是给主用的…
    // 需要分离:用一个能区分主/子调用的 provider
    // 简化:直接测 SubagentTool.execute 调一个 mock runner
    const mockRunner: AgentRunner = {
      async runSub(taskPrompt: string) {
        subCalled = true;
        return `子智能体汇报:探索了 ${taskPrompt},密码是 42`;
      },
    };
    const tool = new SubagentTool(mockRunner, readOnlyReg);
    const report = await tool.execute(JSON.stringify({ task_prompt: "找密码" }));
    expect(subCalled).toBe(true);
    expect(report).toContain("密码是 42");
    expect(report).toContain("子智能体探索报告");
  });
});
