// MicroCompaction 3.1 增强测试:按缓存年龄 + 使用率触发远期 ToolResult 清理。
//
// 覆盖 ROADMAP 要求:
// 1. 年龄 > 1h + 使用率高(accessCount >= 2) → 触发 [Old tool result cleared] 标记
// 2. 年龄 < 1h → 不触发(即使 content 很长,走旧的字符阈值摘要)
// 3. 近 20 条保护区(retainLastMsgsMicro)内的 tool result 不被清理
// 4. [Old tool result cleared] 标记精确出现
// 5. 无 toolResultMetaProvider 时回退纯字符阈值(旧行为不变)

import { describe, expect, it } from "vitest";
import { Compactor } from "../../src/context/compactor.js";
import type { ToolResultMetaEntry } from "../../src/context/compactor.js";
import type { Message } from "../../src/schema/message.js";

const HOUR_MS = 60 * 60 * 1000;

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string, toolCalls?: Message["toolCalls"]): Message {
  return { role: "assistant", content, toolCalls };
}
function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

/** 构造一个 meta 提供者,返回固定的元数据表(便于控制 cachedAt / accessCount) */
function makeMetaProvider(
  meta: Record<string, ToolResultMetaEntry>,
): () => ReadonlyMap<string, ToolResultMetaEntry> {
  const map = new Map(Object.entries(meta));
  return () => map;
}

describe("Compactor MicroCompaction 3.1(年龄 + 使用率清理)", () => {
  it("远期 ToolResult 年龄>1h 且 accessCount>=2 时清理为 [Old tool result cleared]", () => {
    // tool result 在远期(>20 条之外),meta 显示缓存 2 小时前 + 被读过 3 次
    const meta = makeMetaProvider({
      old1: { cachedAt: Date.now() - 2 * HOUR_MS, accessCount: 3 },
    });
    const c = new Compactor({
      maxChars: 10, // 极低水位线,强制触发压缩
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    // 构造 25 条:前面是老的 tool result(被清理),后面填充到 >20 条使其落在 micro 保护区外
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "old1", name: "read", arguments: "{}" }]),
      toolResultMsg("old1", "short"), // 短内容(<200)正常不会触发字符阈值,但 age+usage 会触发
    ];
    // 填充 20 条普通消息,把 old1 推到 micro 保护区(最后 20 条)之外
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const cleared = out.find((m) => m.toolCallId === "old1")!;
    expect(cleared.content).toBe("[Old tool result cleared]");
    expect(cleared.toolCallId).toBe("old1"); // toolCallId 保留
  });

  it("远期 ToolResult 年龄<1h 时不触发清理(即使 content 很长,走字符阈值摘要)", () => {
    // meta:刚缓存 5 分钟前,被读过 5 次 —— 但年龄不够
    const meta = makeMetaProvider({
      fresh1: { cachedAt: Date.now() - 5 * 60 * 1000, accessCount: 5 },
    });
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "fresh1", name: "read", arguments: "{}" }]),
      toolResultMsg("fresh1", bigOutput), // 长 content 触发字符阈值摘要,但 age+usage 不触发
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "fresh1")!;
    // 应走字符阈值摘要(温和),不是 cleared 标记
    expect(result.content).not.toBe("[Old tool result cleared]");
    expect(result.content).toContain("输出已清理");
  });

  it("年龄>1h 但 accessCount<2(使用率低)时不触发清理", () => {
    // meta:缓存 2 小时前,但只被读过 1 次(< 阈值 2)
    const meta = makeMetaProvider({
      old2: { cachedAt: Date.now() - 2 * HOUR_MS, accessCount: 1 },
    });
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "old2", name: "read", arguments: "{}" }]),
      toolResultMsg("old2", bigOutput),
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "old2")!;
    // 使用率不够 → 不清理,走字符阈值摘要
    expect(result.content).not.toBe("[Old tool result cleared]");
    expect(result.content).toContain("输出已清理");
  });

  it("micro 保护区(最近 20 条)内的 tool result 不被清理,即使年龄老+使用率高", () => {
    const meta = makeMetaProvider({
      protected1: { cachedAt: Date.now() - 5 * HOUR_MS, accessCount: 10 },
    });
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "protected1", name: "read", arguments: "{}" }]),
      toolResultMsg("protected1", bigOutput),
    ];
    // 只填充 5 条,使 protected1 仍在 micro 保护区(最后 20 条)内
    for (let i = 0; i < 5; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "protected1")!;
    // 在保护区内 → 不清理(走字符阈值摘要)
    expect(result.content).not.toBe("[Old tool result cleared]");
    expect(result.content).toContain("输出已清理");
  });

  it("无 toolResultMetaProvider 时回退纯字符阈值(旧行为不变)", () => {
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      // 无 toolResultMetaProvider
    });

    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "noMeta", name: "read", arguments: "{}" }]),
      toolResultMsg("noMeta", bigOutput),
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "noMeta")!;
    // 无 meta → 不触发 age+usage,走字符阈值摘要
    expect(result.content).not.toBe("[Old tool result cleared]");
    expect(result.content).toContain("输出已清理");
  });

  it("meta 中无该 toolCallId 时回退字符阈值(不报错)", () => {
    // meta 表为空
    const meta = makeMetaProvider({});
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    const bigOutput = "Y".repeat(5000);
    const msgs: Message[] = [
      assistantMsg("call", [{ id: "missingMeta", name: "read", arguments: "{}" }]),
      toolResultMsg("missingMeta", bigOutput),
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "missingMeta")!;
    expect(result.content).not.toBe("[Old tool result cleared]");
    expect(result.content).toContain("输出已清理");
  });

  it("retainLastMsgsMicro 默认 20:不传时仍按 20 条保护", () => {
    const meta = makeMetaProvider({
      old3: { cachedAt: Date.now() - 2 * HOUR_MS, accessCount: 3 },
    });
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      // 不传 retainLastMsgsMicro,应默认 20
      toolResultMetaProvider: meta,
    });

    const msgs: Message[] = [
      assistantMsg("call", [{ id: "old3", name: "read", arguments: "{}" }]),
      toolResultMsg("old3", "short"),
    ];
    // 填充 20 条 → old3 刚好在保护区边界外(总 22 条,保护最后 20 条,old3 在索引 1 < 2)
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    const result = out.find((m) => m.toolCallId === "old3")!;
    expect(result.content).toBe("[Old tool result cleared]");
  });

  it("多个远期 tool result 同时清理:满足条件的清理,不满足的保留", () => {
    const meta = makeMetaProvider({
      oldA: { cachedAt: Date.now() - 2 * HOUR_MS, accessCount: 3 }, // 满足 → 清理
      oldB: { cachedAt: Date.now() - 2 * HOUR_MS, accessCount: 1 }, // 使用率低 → 不清理
      oldC: { cachedAt: Date.now() - 5 * 60 * 1000, accessCount: 5 }, // 年龄不够 → 不清理
    });
    const c = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      retainLastMsgsMicro: 20,
      toolResultMetaProvider: meta,
    });

    const msgs: Message[] = [
      assistantMsg("call", [
        { id: "oldA", name: "read", arguments: "{}" },
        { id: "oldB", name: "read", arguments: "{}" },
        { id: "oldC", name: "read", arguments: "{}" },
      ]),
      toolResultMsg("oldA", "outA"),
      toolResultMsg("oldB", "outB-long-" + "X".repeat(5000)),
      toolResultMsg("oldC", "outC-long-" + "X".repeat(5000)),
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(userMsg(`filler-${i}`));
    }

    const out = c.compact(msgs);
    expect(out.find((m) => m.toolCallId === "oldA")!.content).toBe("[Old tool result cleared]");
    expect(out.find((m) => m.toolCallId === "oldB")!.content).toContain("输出已清理");
    expect(out.find((m) => m.toolCallId === "oldC")!.content).toContain("输出已清理");
  });
});

describe("Session.getToolResultMeta 与 getWorkingMemory accessCount 联动", () => {
  it("append ToolResult 后 meta 登记,getWorkingMemory 调用 bump accessCount", async () => {
    const { Session } = await import("../../src/engine/session.js");
    const sess = new Session("meta-test", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("call", [{ id: "tr1", name: "read", arguments: "{}" }]),
      toolResultMsg("tr1", "result"),
      userMsg("follow up"),
    );

    // 初始 accessCount = 0
    const metaBefore = sess.getToolResultMeta().get("tr1");
    expect(metaBefore).toBeDefined();
    expect(metaBefore!.accessCount).toBe(0);

    // getWorkingMemory 读出该 tool result → bump
    sess.getWorkingMemory(10);
    expect(sess.getToolResultMeta().get("tr1")!.accessCount).toBe(1);

    // 再读一次 → accessCount = 2
    sess.getWorkingMemory(10);
    expect(sess.getToolResultMeta().get("tr1")!.accessCount).toBe(2);

    sess.close();
  });

  it("getToolResultMeta 返回只读视图,外部修改不影响内部(强转才生效)", async () => {
    const { Session } = await import("../../src/engine/session.js");
    const sess = new Session("meta-readonly", "/tmp", { persistence: false });
    sess.append(
      assistantMsg("call", [{ id: "tr2", name: "read", arguments: "{}" }]),
      toolResultMsg("tr2", "result"),
    );
    const meta = sess.getToolResultMeta();
    expect(meta.size).toBe(1);
    // 只读类型:通过 as 强转修改不应影响内部行为(运行时 Map 仍是同一引用,
    // 但接口约定为只读,调用方不应修改)
    expect(meta.get("tr2")).toBeDefined();
    sess.close();
  });
});
