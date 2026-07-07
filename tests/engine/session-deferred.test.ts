// Session deferredMessages(3.4)测试:tool 调用顺序完整性保证。
//
// 验证 ROADMAP 3.4 行为:
// 1. assistant 带 toolCalls → pendingToolCallIds 登记
// 2. ToolResult 到达前,后续普通消息暂存 deferred,不入 history
// 3. 所有 ToolResult 到齐后,deferred flush 入 history,顺序保证 tool 配对完整
// 4. undo 清空 deferred 与 pending
// 5. toolCalls 消息本身不延迟(否则 ToolResult 变孤儿)

import { describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string, toolCalls?: Message["toolCalls"]): Message {
  return { role: "assistant", content, toolCalls };
}
function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

describe("Session deferredMessages(3.4 tool 顺序完整性)", () => {
  it("assistant 带 2 个 toolCalls:pendingToolCallIds 有 2 个(通过行为观察)", () => {
    const sess = new Session("defer-1", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("发起两个调用", [
        { id: "c1", name: "read", arguments: "{}" },
        { id: "c2", name: "bash", arguments: "{}" },
      ]),
    );
    // assistant + 2 个 toolCalls 已入 history(其本身不延迟)
    expect(sess.length).toBe(1);

    // 此后追加的普通消息应被暂存(因为 pending 非空)
    sess.append(userMsg("这条该被暂存"));
    expect(sess.length).toBe(1); // 仍未入 history
    expect(sess.getHistory().some((m) => m.content === "这条该被暂存")).toBe(false);
    sess.close();
  });

  it("第 1 个 ToolResult 到达:暂存的 user 消息仍在 deferred(因 pending 还有 1 个)", () => {
    const sess = new Session("defer-2", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("发起两个调用", [
        { id: "c1", name: "read", arguments: "{}" },
        { id: "c2", name: "bash", arguments: "{}" },
      ]),
    );
    sess.append(userMsg("暂存消息A"));
    // 第 1 个 ToolResult 到达:消化 c1,pending 还剩 c2
    sess.append(toolResultMsg("c1", "result-1"));

    // history 应为 [assistant, toolResult1](user 消息仍暂存)
    expect(sess.length).toBe(2);
    expect(sess.getHistory().map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(sess.getHistory()[1]!.toolCallId).toBe("c1");
    // 暂存消息仍未入 history
    expect(sess.getHistory().some((m) => m.content === "暂存消息A")).toBe(false);
    sess.close();
  });

  it("第 2 个 ToolResult 到达:pending 清空,deferred flush 入 history,顺序正确", () => {
    const sess = new Session("defer-3", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("发起两个调用", [
        { id: "c1", name: "read", arguments: "{}" },
        { id: "c2", name: "bash", arguments: "{}" },
      ]),
    );
    sess.append(userMsg("暂存消息A"));
    sess.append(userMsg("暂存消息B"));
    sess.append(toolResultMsg("c1", "result-1"));
    // 第 2 个 ToolResult 到达:pending 清空 → flush
    sess.append(toolResultMsg("c2", "result-2"));

    // 最终顺序:assistant, toolResult1, toolResult2, 暂存A, 暂存B
    // (tool 配对完整保留,deferred 在 tool 结果之后 flush)
    const roles = sess.getHistory().map((m) => m.role);
    expect(roles).toEqual(["assistant", "user", "user", "user", "user"]);
    const contents = sess.getHistory().map((m) => m.content);
    expect(contents[1]).toBe("result-1");
    expect(contents[2]).toBe("result-2");
    expect(contents[3]).toBe("暂存消息A");
    expect(contents[4]).toBe("暂存消息B");
    // toolCallId 配对完整
    expect(sess.getHistory()[1]!.toolCallId).toBe("c1");
    expect(sess.getHistory()[2]!.toolCallId).toBe("c2");
    sess.close();
  });

  it("单 toolCall:ToolResult 到达后无 deferred 时正常入 history(flush 空操作)", () => {
    const sess = new Session("defer-4", "/tmp", { persistence: false });
    sess.append(assistantMsg("call", [{ id: "s1", name: "read", arguments: "{}" }]));
    sess.append(toolResultMsg("s1", "single-result"));
    expect(sess.length).toBe(2);
    expect(sess.getHistory()[1]!.toolCallId).toBe("s1");
    sess.close();
  });

  it("toolCalls 消息本身不延迟(否则 ToolResult 变孤儿)", () => {
    // 即使前一轮有未消化的 toolCalls(不该发生,但验证防御),
    // 新的 assistant toolCalls 消息仍直接入 history
    const sess = new Session("defer-5", "/tmp", { persistence: false });
    sess.append(assistantMsg("第一轮调用", [{ id: "p1", name: "read", arguments: "{}" }]));
    // p1 还没 result,直接发第二轮 toolCalls
    sess.append(assistantMsg("第二轮调用", [{ id: "p2", name: "read", arguments: "{}" }]));
    // 两个 assistant 都应在 history(都不延迟)
    expect(sess.length).toBe(2);
    expect(sess.getHistory().every((m) => m.role === "assistant")).toBe(true);
    sess.close();
  });

  it("无 toolCalls 的普通对话不触发 deferred(向后兼容)", () => {
    const sess = new Session("defer-6", "/tmp", { persistence: false });
    sess.append(userMsg("hi"), assistantMsg("hello"), userMsg("how are you"));
    expect(sess.length).toBe(3);
    expect(sess.getWorkingMemory(10)).toHaveLength(3);
    sess.close();
  });

  it("ToolResult 在前无对应 toolCalls 时不延迟(孤儿兜底由 sanitizeToolPairs 处理)", () => {
    const sess = new Session("defer-7", "/tmp", { persistence: false });
    // 直接 append 一个 ToolResult,无 pending → 直接入 history
    sess.append(toolResultMsg("orphan", "orphan-result"));
    expect(sess.length).toBe(1);
    expect(sess.getHistory()[0]!.toolCallId).toBe("orphan");
    sess.close();
  });

  it("undo 清空 deferred 和 pending", () => {
    const sess = new Session("defer-8", "/tmp", { persistence: false });
    sess.append(userMsg("任务"));
    sess.append(
      assistantMsg("发起调用", [
        { id: "u1", name: "read", arguments: "{}" },
        { id: "u2", name: "read", arguments: "{}" },
      ]),
    );
    sess.append(userMsg("暂存消息")); // 应暂存(pending 非空)
    sess.append(toolResultMsg("u1", "r1")); // 消化 u1,pending 还剩 u2
    expect(sess.length).toBe(3); // [user任务, assistant, toolResult1]

    // undo 1 轮:删掉最后一个 user prompt 轮次
    sess.undo(1);
    // undo 清空 deferred + pending:之后追加的普通消息不再被暂存
    sess.append(userMsg("undo 后的新消息"));
    expect(sess.getHistory().some((m) => m.content === "undo 后的新消息")).toBe(true);
    expect(sess.getHistory().some((m) => m.content === "暂存消息")).toBe(false);
    sess.close();
  });

  it("deferred 不进 WorkingMemory(flush 前不可见)", () => {
    const sess = new Session("defer-9", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("call", [{ id: "w1", name: "read", arguments: "{}" }]),
    );
    sess.append(userMsg("暂存消息-should-not-appear"));
    const wm = sess.getWorkingMemory(10);
    // 只有 assistant 在 wm,暂存消息不可见
    expect(wm).toHaveLength(1);
    expect(wm.some((m) => m.content === "暂存消息-should-not-appear")).toBe(false);
    sess.close();
  });

  it("多轮 tool 调用:每轮独立 deferred,互不干扰", () => {
    const sess = new Session("defer-10", "/tmp", { persistence: false });
    // 第一轮
    sess.append(
      assistantMsg("第一轮", [{ id: "r1c1", name: "read", arguments: "{}" }]),
      toolResultMsg("r1c1", "r1-result"),
    );
    // 第一轮已消化,普通消息直接入 history
    sess.append(userMsg("第一轮后的闲聊"));
    // 第二轮
    sess.append(
      assistantMsg("第二轮", [
        { id: "r2c1", name: "read", arguments: "{}" },
        { id: "r2c2", name: "read", arguments: "{}" },
      ]),
    );
    sess.append(userMsg("第二轮暂存消息")); // 应暂存
    sess.append(toolResultMsg("r2c1", "r2-result-1"));
    // 第二轮暂存消息仍不可见
    expect(sess.getHistory().some((m) => m.content === "第二轮暂存消息")).toBe(false);
    sess.append(toolResultMsg("r2c2", "r2-result-2"));
    // 第二轮暂存消息 flush 入 history
    expect(sess.getHistory().some((m) => m.content === "第二轮暂存消息")).toBe(true);
    sess.close();
  });
});
