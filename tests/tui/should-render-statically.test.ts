// shouldRenderStatically 单元测试:验证各场景下 entry 的 isStatic 判定。
// 覆盖:user/tool-done/tool-running/assistant-static/assistant-streaming/thinking。

import { describe, expect, it } from "vitest";
import { shouldRenderStatically } from "../../src/tui/message-list.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

describe("shouldRenderStatically", () => {
  it("user 条目:始终固定(true)", () => {
    const e: TuiEntry = { kind: "user", content: "你好" };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("tool done:已 resolve → 固定(true)", () => {
    const e: TuiEntry = { kind: "tool", name: "read", args: "{}", status: "done", summary: "10 字节" };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, false)).toBe(true);
  });

  it("tool error:已 resolve → 固定(true)", () => {
    const e: TuiEntry = { kind: "tool", name: "bash", args: "{}", status: "error", summary: "失败" };
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("tool running:进行中 → 非固定(false)", () => {
    const e: TuiEntry = { kind: "tool", name: "bash", args: "{}", status: "running" };
    expect(shouldRenderStatically(e, true, true)).toBe(false);
    expect(shouldRenderStatically(e, false, false)).toBe(false);
  });

  it("assistant 非末条:历史回复 → 固定(true)", () => {
    const e: TuiEntry = { kind: "assistant", content: "历史回复" };
    expect(shouldRenderStatically(e, false, true)).toBe(true);
    expect(shouldRenderStatically(e, false, false)).toBe(true);
  });

  it("assistant 末条且流式中 → 非固定(false)", () => {
    const e: TuiEntry = { kind: "assistant", content: "正在写…" };
    expect(shouldRenderStatically(e, true, true)).toBe(false);
  });

  it("assistant 末条且非流式 → 固定(true)", () => {
    const e: TuiEntry = { kind: "assistant", content: "已完成回复" };
    expect(shouldRenderStatically(e, true, false)).toBe(true);
  });

  it("thinking:始终非固定(false)", () => {
    const e: TuiEntry = { kind: "thinking" };
    expect(shouldRenderStatically(e, false, false)).toBe(false);
    expect(shouldRenderStatically(e, true, true)).toBe(false);
  });
});
