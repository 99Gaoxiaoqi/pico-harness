// shouldContinueAfterStop 续接机制测试(ROADMAP 3.7)。
//
// 模型跑完一轮没调工具(toolCalls.length === 0)→ 正常是 onFinish + break 退出。
// host 可借此回调让 Agent 继续:{continue:true} 则不退出,append 续接消息继续下一轮。
//
// 覆盖:
// 1. 回调返回 {continue:false} → 正常 break(回归)
// 2. 回调返回 {continue:true, continuePrompt:"继续"} → session 多一条 user,循环继续,
//    下一轮模型调工具则正常跑(非停止分支)
// 3. 回调返回 void(undefined)→ 正常 break(兼容)
// 4. 连续续接后再停止不再续接(防无限循环:host 回调内部计数限制)
// 5. 不传回调时行为完全不变(回归)

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import type { BaseTool, Registry } from "../../src/tools/registry.js";

/** 可编程的 Mock Provider:按预设的响应序列依次返回 */
class ScriptedProvider implements LLMProvider {
  readonly seenMessages: Message[][] = [];
  constructor(private readonly responses: Message[]) {}
  private i = 0;
  async generate(msgs: Message[]): Promise<Message> {
    this.seenMessages.push(msgs.map((m) => ({ ...m })));
    const r = this.responses[this.i];
    if (!r) throw new Error("ScriptedProvider: 响应序列耗尽");
    this.i++;
    return r;
  }
}

class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "bash",
        description: "run a bash command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.executed.push(call);
    return { toolCallId: call.id, output: `result-of-${call.name}`, isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return false;
  }
}

function newSession(prompt: string): Session {
  const sess = new Session("continue-stop-test", "/tmp");
  sess.append({ role: "user", content: prompt });
  return sess;
}

describe("AgentEngine + shouldContinueAfterStop", () => {
  it("回调返回 {continue:false} → 正常 break,不续接(回归)", async () => {
    const provider = new ScriptedProvider([{ role: "assistant", content: "完成" }]);
    const registry = new MockRegistry();
    let called = 0;
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      shouldContinueAfterStop: async () => {
        called++;
        return { continue: false };
      },
    });

    const session = newSession("任务");
    const returned = await engine.run(session);

    // 回调被调用一次(第一次停止)
    expect(called).toBe(1);
    // 无工具执行(模型直接停)
    expect(registry.executed).toHaveLength(0);
    // 续接消息未注入:session 只有最初的 user + assistant
    expect(returned.at(-1)?.content).toBe("完成");
    // 没有"请继续推进任务"这种续接 prompt
    expect(
      session.getHistory().some((m) => m.content.includes("请继续推进任务")),
    ).toBe(false);
  });

  it("回调返回 {continue:true, continuePrompt} → session 多一条 user,循环继续,下一轮调工具正常跑", async () => {
    // 第一轮:模型不调工具(停止)→ 回调续接
    // 第二轮:模型调工具(非停止分支,正常执行)
    // 第三轮:模型不调工具 → 回调返回 false 正常退出
    const provider = new ScriptedProvider([
      { role: "assistant", content: "我先报告一下" }, // 第 1 轮:停止
      {
        role: "assistant",
        content: "好,继续干",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }], // 第 2 轮:调工具
      },
      { role: "assistant", content: "全部完成" }, // 第 3 轮:停止
    ]);
    const registry = new MockRegistry();
    let stopCount = 0;
    const seenPrompts: string[] = [];
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      shouldContinueAfterStop: async ({ lastMessage }) => {
        stopCount++;
        seenPrompts.push(lastMessage.content);
        // 第一次停止 → 续接;第二次停止 → 正常退出
        if (stopCount === 1) {
          return { continue: true, continuePrompt: "继续推进任务" };
        }
        return { continue: false };
      },
    });

    const session = newSession("主任务");
    await engine.run(session);

    // 回调被调用两次
    expect(stopCount).toBe(2);
    expect(seenPrompts).toEqual(["我先报告一下", "全部完成"]);
    // 续接 prompt 注入了 session
    expect(
      session.getHistory().some((m) => m.role === "user" && m.content === "继续推进任务"),
    ).toBe(true);
    // 第二轮调了工具(证明续接后循环真的继续跑了)
    expect(registry.executed).toHaveLength(1);
  });

  it("回调返回 void(undefined)→ 正常 break(兼容)", async () => {
    const provider = new ScriptedProvider([{ role: "assistant", content: "完成" }]);
    const registry = new MockRegistry();
    let called = 0;
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      shouldContinueAfterStop: () => {
        called++;
        // 返回 void
      },
    });

    const session = newSession("任务");
    await engine.run(session);

    // 回调被调用,但 void = 正常退出
    expect(called).toBe(1);
    expect(registry.executed).toHaveLength(0);
  });

  it("连续续接后再停止不再续接(防无限循环:host 回调内部计数限制)", async () => {
    // 三轮都停止:前两次续接,第三次正常退出。host 用计数防无限循环。
    const provider = new ScriptedProvider([
      { role: "assistant", content: "停止1" },
      { role: "assistant", content: "停止2" },
      { role: "assistant", content: "停止3" },
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      maxTurns: 50,
      enableThinking: false,
      shouldContinueAfterStop: (() => {
        let continues = 0;
        const MAX_CONTINUES = 2; // host 自己的限制
        return async () => {
          if (continues < MAX_CONTINUES) {
            continues++;
            return { continue: true, continuePrompt: "继续" };
          }
          return { continue: false };
        };
      })(),
    });

    const session = newSession("任务");
    await engine.run(session);

    // 续接两次后正常退出,provider 序列恰好耗尽(3 轮)
    expect(provider.seenMessages).toHaveLength(3);
    // 续接消息注入两次
    const continueMsgs = session
      .getHistory()
      .filter((m) => m.role === "user" && m.content === "继续");
    expect(continueMsgs).toHaveLength(2);
  });

  it("不传 shouldContinueAfterStop 时行为完全不变(回归)", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "调工具",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "完成" },
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      // 故意不传 shouldContinueAfterStop
    });

    const session = newSession("普通任务");
    const returned = await engine.run(session);

    // 工具调用一次,最终答案正确
    expect(registry.executed).toHaveLength(1);
    expect(returned.at(-1)?.content).toBe("完成");
    // 无续接消息注入
    expect(
      session.getHistory().some((m) => m.content.includes("请继续推进任务")),
    ).toBe(false);
  });

  it("不传 continuePrompt 时使用默认续接消息", async () => {
    // 第一轮停止 → 续接(不传 continuePrompt)→ 第二轮停止 → 退出
    const provider = new ScriptedProvider([
      { role: "assistant", content: "停1" },
      { role: "assistant", content: "停2" },
    ]);
    const registry = new MockRegistry();
    let stopCount = 0;
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      shouldContinueAfterStop: async () => {
        stopCount++;
        if (stopCount === 1) return { continue: true }; // 无 continuePrompt
        return { continue: false };
      },
    });

    const session = newSession("任务");
    await engine.run(session);

    // 默认续接消息注入
    expect(
      session.getHistory().some((m) => m.role === "user" && m.content === "请继续推进任务。"),
    ).toBe(true);
  });

  it("回调接收到正确的 turn 计数与 lastMessage", async () => {
    const provider = new ScriptedProvider([{ role: "assistant", content: "首次停止" }]);
    const registry = new MockRegistry();
    const infos: { turn: number; lastMessage: Message }[] = [];
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
      shouldContinueAfterStop: async (info) => {
        infos.push(info);
        return { continue: false };
      },
    });

    await engine.run(newSession("任务"));

    // 第 1 轮就停止,turn=1,lastMessage 是模型回复
    expect(infos).toHaveLength(1);
    expect(infos[0]!.turn).toBe(1);
    expect(infos[0]!.lastMessage.content).toBe("首次停止");
  });
});
