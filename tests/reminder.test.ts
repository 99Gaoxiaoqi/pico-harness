// ReminderInjector 死循环探测器的单元测试。
// 覆盖:指纹生成 / 成功清零 / 失败累加 / 阈值3触发 / 不同参数不累计 / 触发消息格式。

import { describe, expect, it } from "vitest";
import { ReminderInjector } from "../src/engine/reminder.js";
import type { ToolCall, ToolResult } from "../src/schema/message.js";

function toolCall(name: string, args: string): ToolCall {
  return { id: `id-${name}-${args.length}`, name, arguments: args };
}
function okResult(output = "ok"): ToolResult {
  return { toolCallId: "x", output, isError: false };
}
function errResult(output = "Error: failed"): ToolResult {
  return { toolCallId: "x", output, isError: true };
}

describe("ReminderInjector.fingerprint", () => {
  it("相同工具名+参数生成相同指纹", () => {
    const a = ReminderInjector.fingerprint("read_file", '{"path":"a.txt"}');
    const b = ReminderInjector.fingerprint("read_file", '{"path":"a.txt"}');
    expect(a).toBe(b);
  });

  it("不同参数生成不同指纹", () => {
    const a = ReminderInjector.fingerprint("read_file", '{"path":"a.txt"}');
    const b = ReminderInjector.fingerprint("read_file", '{"path":"b.txt"}');
    expect(a).not.toBe(b);
  });

  it("不同工具名生成不同指纹", () => {
    const a = ReminderInjector.fingerprint("read_file", "{}");
    const b = ReminderInjector.fingerprint("bash", "{}");
    expect(a).not.toBe(b);
  });
});

describe("ReminderInjector.checkAndInject", () => {
  it("工具成功:不注入,且清空已有失败计数", () => {
    const inj = new ReminderInjector();
    // 先制造 2 次失败
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    // 成功一次
    const msg = inj.checkAndInject(toolCall("read", '{"p":"a"}'), okResult());
    expect(msg).toBeNull();
    // 之后同样的失败应从 1 重新计数(不立即触发)
    const msg2 = inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    expect(msg2).toBeNull();
  });

  it("连续 1、2 次同参数失败:不触发", () => {
    const inj = new ReminderInjector();
    expect(inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult())).toBeNull();
    expect(inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult())).toBeNull();
  });

  it("连续 3 次同参数失败:触发 [SYSTEM REMINDER] 干预", () => {
    const inj = new ReminderInjector();
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    const msg = inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("user");
    expect(msg!.content).toContain("SYSTEM REMINDER");
    expect(msg!.content).toContain("死循环");
    expect(msg!.content).toContain("3");
    expect(msg!.content).toContain("read");
  });

  it("不同参数的失败不累计到同一指纹", () => {
    const inj = new ReminderInjector();
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    inj.checkAndInject(toolCall("read", '{"p":"b"}'), errResult());
    inj.checkAndInject(toolCall("read", '{"p":"c"}'), errResult());
    // 三次失败但参数各不相同,不应触发
    const msg = inj.checkAndInject(toolCall("read", '{"p":"d"}'), errResult());
    expect(msg).toBeNull();
  });

  it("不同工具的失败不互相累计", () => {
    const inj = new ReminderInjector();
    inj.checkAndInject(toolCall("read", '{"p":"a"}'), errResult());
    inj.checkAndInject(toolCall("bash", '{"p":"a"}'), errResult());
    // 各自只有 1 次,不触发
    expect(inj.checkAndInject(toolCall("edit", '{"p":"a"}'), errResult())).toBeNull();
  });

  it("触发后继续失败仍持续注入(每次都提醒)", () => {
    const inj = new ReminderInjector();
    const tc = toolCall("read", '{"p":"a"}');
    inj.checkAndInject(tc, errResult());
    inj.checkAndInject(tc, errResult());
    const msg3 = inj.checkAndInject(tc, errResult());
    const msg4 = inj.checkAndInject(tc, errResult());
    expect(msg3).not.toBeNull();
    expect(msg4).not.toBeNull();
    expect(msg4!.content).toContain("4");
  });

  it("中途成功清零后,重新累计 3 次才触发", () => {
    const inj = new ReminderInjector();
    const tc = toolCall("read", '{"p":"a"}');
    inj.checkAndInject(tc, errResult());
    inj.checkAndInject(tc, errResult());
    // 中途成功 → 清零
    inj.checkAndInject(tc, okResult());
    // 重新累计
    expect(inj.checkAndInject(tc, errResult())).toBeNull();
    expect(inj.checkAndInject(tc, errResult())).toBeNull();
    const msg = inj.checkAndInject(tc, errResult());
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain("3");
  });

  it("触发消息为 RoleUser(享受最高近因效应)", () => {
    const inj = new ReminderInjector();
    const tc = toolCall("bash", '{"command":"rm -rf /"}');
    inj.checkAndInject(tc, errResult());
    inj.checkAndInject(tc, errResult());
    const msg = inj.checkAndInject(tc, errResult());
    expect(msg!.role).toBe("user");
    expect(msg!.toolCallId).toBeUndefined();
  });

  it("reset 清空所有失败计数", () => {
    const inj = new ReminderInjector();
    const tc = toolCall("read", '{"p":"a"}');
    inj.checkAndInject(tc, errResult());
    inj.checkAndInject(tc, errResult());
    inj.reset();
    // reset 后从 1 开始
    expect(inj.checkAndInject(tc, errResult())).toBeNull();
  });
});
