// ContextCompactor 上下文压缩器的单元测试。
// 覆盖双重降级策略的各条防线:
// 1. 未超水位线:直通(深拷贝,不修改原数组)
// 2. System Prompt:永远保留,神圣不可侵犯
// 3. 远期 ToolResult:全量掩码(保留意图,释放内存)
// 4. 保护区 ToolResult 超长:掐头去尾(前 500 + 后 500)
// 5. 远期 Assistant Thinking Trace:折叠
// 6. ToolCalls 字段绝不被触碰(维系逻辑链)
// 7. estimateLength 累加 content + toolCalls

import { describe, expect, it } from "vitest";
import { Compactor, sanitizeToolPairs } from "../src/context/compactor.js";
import type { Message } from "../src/schema/message.js";

function systemMsg(content: string): Message {
  return { role: "system", content };
}
function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string, toolCalls?: Message["toolCalls"]): Message {
  return { role: "assistant", content, toolCalls };
}
function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

describe("Compactor", () => {
  it("未超水位线时直通返回,且为深拷贝", () => {
    const c = new Compactor({ maxChars: 10000, retainLastMsgs: 6 });
    const msgs = [systemMsg("sys"), userMsg("hi"), assistantMsg("hello")];
    const out = c.compact(msgs);
    expect(out).toHaveLength(3);
    // 深拷贝:修改 out 不影响原数组
    out[1]!.content = "tampered";
    expect(msgs[1]!.content).toBe("hi");
  });

  it("estimateLength 累加 content 与 toolCalls(name+arguments)", () => {
    const c = new Compactor({ maxChars: 10000, retainLastMsgs: 6 });
    const args = '{"command":"ls"}'; // 16 字符
    const msgs: Message[] = [
      systemMsg("abc"), // 3
      assistantMsg("de", [
        { id: "x", name: "bash", arguments: args }, // name(4) + args(16) = 20
      ]), // content(2) + 20 = 22
    ];
    expect(c.estimateLength(msgs)).toBe(3 + 22);
  });

  it("System Prompt 永远保留,即使超标也不被压缩", () => {
    // 水位线设极低,强制触发压缩
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const longSystem = systemMsg("X".repeat(5000));
    const out = c.compact([longSystem, userMsg("hi")]);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.content).toBe("X".repeat(5000));
  });

  it("远期 ToolResult 超长时全量掩码,保留 toolCallId", () => {
    // retainLastMsgs=1:只有最后 1 条受保护,前面的 ToolResult 属远期
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      userMsg("task"),
      assistantMsg("call", [{ id: "c1", name: "read", arguments: "{}" }]),
      toolResultMsg("c1", bigOutput), // 远期 ToolResult,应被掩码
      userMsg("recent"), // 受保护的最近 1 条
    ];
    const out = c.compact(msgs);
    const masked = out[2]!;
    expect(masked.role).toBe("user");
    expect(masked.toolCallId).toBe("c1"); // toolCallId 保留
    expect(masked.content).toContain("早期的工具输出已被系统清理");
    expect(masked.content).toContain("5000");
    expect(masked.content.length).toBeLessThan(bigOutput.length);
  });

  it("远期 ToolResult 短于阈值(200)时保留原样", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const shortOutput = "short result"; // 12 字符 < 200
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "c1", name: "read", arguments: "{}" }]),
      toolResultMsg("c1", shortOutput), // 远期但短,不掩码
      userMsg("recent"),
    ];
    const out = c.compact(msgs);
    expect(out[1]!.content).toBe(shortOutput);
  });

  it("保护区 ToolResult 超长(>1000)时掐头去尾:保留前500+后500", () => {
    // retainLastMsgs=2:最后 2 条受保护
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 2 });
    const big = "Z".repeat(3000);
    const msgs: Message[] = [
      userMsg("task"),
      assistantMsg("call", [{ id: "c1", name: "read", arguments: "{}" }]),
      toolResultMsg("c1", big), // 倒数第 2 条,在保护区内
      userMsg("recent"), // 倒数第 1 条,在保护区
    ];
    const out = c.compact(msgs);
    const truncated = out[2]!;
    expect(truncated.toolCallId).toBe("c1");
    expect(truncated.content).toContain("内容过长");
    expect(truncated.content).toContain("已被系统截断");
    // 含前 500 个 Z
    expect(truncated.content.startsWith("Z".repeat(500))).toBe(true);
    // 含后 500 个 Z
    expect(truncated.content.endsWith("Z".repeat(500))).toBe(true);
    // 总长度远小于原 3000
    expect(truncated.content.length).toBeLessThan(1200);
  });

  it("保护区 ToolResult 未超 1000 时保留原样", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 2 });
    const medium = "M".repeat(800); // < 1000
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "c1", name: "read", arguments: "{}" }]),
      toolResultMsg("c1", medium),
      userMsg("recent"),
    ];
    const out = c.compact(msgs);
    expect(out[1]!.content).toBe(medium);
  });

  it("远期 Assistant 冗长 Thinking Trace(>200)被折叠", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const longThinking = assistantMsg("T".repeat(500));
    const msgs: Message[] = [
      userMsg("task"),
      longThinking, // 远期 assistant,应折叠
      userMsg("recent"),
    ];
    const out = c.compact(msgs);
    expect(out[1]!.content).toContain("早期的推理思考过程已折叠");
  });

  it("绝不触碰 toolCalls 字段:压缩后 ToolCall 意图完整保留", () => {
    // 这是维系逻辑链的关键:删 ToolResult 而保留 ToolCall,模型才不会死循环
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const toolCalls = [
      { id: "c1", name: "bash", arguments: '{"command":"cat large.log"}' },
      { id: "c2", name: "read", arguments: '{"path":"big.txt"}' },
    ];
    const msgs: Message[] = [
      assistantMsg("我来读大文件", toolCalls),
      toolResultMsg("c1", "R".repeat(5000)),
      userMsg("recent"),
    ];
    const out = c.compact(msgs);
    // assistant 的 toolCalls 完整保留
    expect(out[0]!.toolCalls).toEqual(toolCalls);
    // ToolResult 被掩码,但 toolCallId 保留(关联到 c1)
    expect(out[1]!.toolCallId).toBe("c1");
    expect(out[1]!.content).toContain("已被系统清理");
  });

  it("压缩后总长度显著下降,低于原长度", () => {
    const c = new Compactor({ maxChars: 100, retainLastMsgs: 2 });
    const msgs: Message[] = [
      userMsg("task"),
      assistantMsg("call", [{ id: "c1", name: "read", arguments: "{}" }]),
      toolResultMsg("c1", "X".repeat(5000)), // 远期,被掩码
      assistantMsg("call2", [{ id: "c2", name: "read", arguments: "{}" }]),
      toolResultMsg("c2", "Y".repeat(3000)), // 保护区,掐头去尾
    ];
    const before = c.estimateLength(msgs);
    const out = c.compact(msgs);
    const after = c.estimateLength(out);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(2000); // 远低于原始 8000+
  });

  it("连续多个远期孤儿 ToolResult 全部掩码", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 1 });
    const msgs: Message[] = [
      assistantMsg("call3", [
        { id: "c1", name: "r", arguments: "{}" },
        { id: "c2", name: "r", arguments: "{}" },
        { id: "c3", name: "r", arguments: "{}" },
      ]),
      toolResultMsg("c1", "A".repeat(1000)),
      toolResultMsg("c2", "B".repeat(1000)),
      toolResultMsg("c3", "C".repeat(1000)),
      userMsg("recent"), // 唯一受保护
    ];
    const out = c.compact(msgs);
    // 三个远期 ToolResult 都被掩码
    expect(out[1]!.content).toContain("已被系统清理");
    expect(out[2]!.content).toContain("已被系统清理");
    expect(out[3]!.content).toContain("已被系统清理");
    // toolCallId 各自保留
    expect(out[1]!.toolCallId).toBe("c1");
    expect(out[2]!.toolCallId).toBe("c2");
    expect(out[3]!.toolCallId).toBe("c3");
  });

  it("sanitizeToolPairs 删除孤儿工具结果并补齐缺失结果 stub", () => {
    const msgs: Message[] = [
      toolResultMsg("ghost", "orphan"),
      assistantMsg("call", [
        { id: "c1", name: "read", arguments: "{}" },
        { id: "c2", name: "read", arguments: "{}" },
      ]),
      toolResultMsg("c1", "ok"),
      userMsg("next"),
    ];

    const out = sanitizeToolPairs(msgs);

    expect(out.some((m) => m.toolCallId === "ghost")).toBe(false);
    expect(out.some((m) => m.toolCallId === "c1" && m.content === "ok")).toBe(true);
    const stub = out.find((m) => m.toolCallId === "c2");
    expect(stub?.content).toContain("工具结果已归档");
  });

  it("连续两次压缩收益不足时触发反抖守卫,跳过后续压缩", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 10 });
    const msgs = [systemMsg("S".repeat(1000)), userMsg("recent")];

    const first = c.compact(msgs);
    const second = c.compact(msgs);
    const third = c.compact(msgs);

    expect(c.ineffectiveCompressionCount).toBe(2);
    expect(first[0]!.content).toBe("S".repeat(1000));
    expect(second[0]!.content).toBe("S".repeat(1000));
    expect(third[0]!.content).toBe("S".repeat(1000));
  });

  it("retainLastTokens 按近似 token 预算保护尾部,不再只按消息条数", () => {
    const c = new Compactor({ maxChars: 10, retainLastMsgs: 100, retainLastTokens: 20 });
    const oldBig = toolResultMsg("old", "O".repeat(2000));
    const recentSmall = toolResultMsg("recent", "R".repeat(80));
    const msgs: Message[] = [
      assistantMsg("old-call", [{ id: "old", name: "read", arguments: "{}" }]),
      oldBig,
      assistantMsg("recent-call", [{ id: "recent", name: "read", arguments: "{}" }]),
      recentSmall,
    ];

    const out = c.compact(msgs);

    expect(out.find((m) => m.toolCallId === "old")?.content).toContain("已被系统清理");
    expect(out.find((m) => m.toolCallId === "recent")?.content).toBe("R".repeat(80));
  });

  it("compactWithSummary 基于 previousSummary 做增量摘要", async () => {
    const seen: { previousSummary?: string; newCount: number }[] = [];
    const c = new Compactor({
      maxChars: 50,
      retainLastMsgs: 1,
      summarizer: async ({ previousSummary, newMessages }) => {
        seen.push({ previousSummary, newCount: newMessages.length });
        return previousSummary ? `${previousSummary} + 增量${newMessages.length}` : `初次${newMessages.length}`;
      },
    });

    await c.compactWithSummary([
      userMsg("a".repeat(100)),
      assistantMsg("b".repeat(100)),
      userMsg("recent"),
    ]);
    await c.compactWithSummary([
      userMsg("a".repeat(100)),
      assistantMsg("b".repeat(100)),
      userMsg("c".repeat(100)),
      userMsg("recent"),
    ]);

    expect(seen[0]).toEqual({ previousSummary: undefined, newCount: 2 });
    expect(seen[1]).toEqual({ previousSummary: "初次2", newCount: 1 });
  });
});
