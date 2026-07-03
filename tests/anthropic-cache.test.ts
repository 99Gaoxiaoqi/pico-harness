// anthropic-cache:Prompt Cache 断点注入器单测。
// 验证断点位置、上限、幂等、门控开关,不依赖真实 API。

import { describe, expect, it } from "vitest";
import {
  applyAnthropicCacheControl,
  markCacheBreakpoint,
  MAX_CACHE_BREAKPOINTS,
} from "../src/provider/anthropic-cache.js";

describe("markCacheBreakpoint", () => {
  it("给空 block 注入 ephemeral cache_control(原地修改)", () => {
    const block = { type: "text", text: "hi" };
    markCacheBreakpoint(block);
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("已存在 cache_control 时不覆盖(幂等)", () => {
    const existing = { type: "ephemeral", ttl: "1h" as const };
    const block = { type: "text", text: "hi", cache_control: existing };
    markCacheBreakpoint(block);
    expect(block.cache_control).toBe(existing);
  });
});

describe("applyAnthropicCacheControl", () => {
  it("enabled=false 时不修改 body,返回 0", () => {
    const body = { system: "s", tools: [{ name: "t" }], messages: [] };
    const n = applyAnthropicCacheControl(body, false);
    expect(n).toBe(0);
    expect(body.system).toBe("s"); // 未被转成数组
  });

  it("string system 转成带 cache_control 的 block 数组(断点①)", () => {
    const body = { system: "你是助手", tools: [], messages: [] };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(1);
    expect(body.system).toEqual([
      { type: "text", text: "你是助手", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("tools 尾元素注入断点(断点②),其他 tool 不带", () => {
    const body = {
      system: undefined,
      tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
      messages: [],
    };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(1);
    expect(body.tools![0]!.cache_control).toBeUndefined();
    expect(body.tools![1]!.cache_control).toBeUndefined();
    expect(body.tools![2]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("历史前缀尾(倒数第二条消息末 block)注入断点(断点③),最后一条不带", () => {
    const body = {
      system: undefined,
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "旧" }] },
        { role: "assistant", content: [{ type: "text", text: "答" }] },
        { role: "user", content: [{ type: "text", text: "本轮新" }] },
      ],
    };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(1);
    expect(body.messages![1]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages![2]!.content[0]!.cache_control).toBeUndefined();
  });

  it("完整三断点:system + tools 尾 + 历史前缀尾", () => {
    const body = {
      system: "核心身份",
      tools: [{ name: "read" }, { name: "bash" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "问1" }] },
        { role: "assistant", content: [{ type: "text", text: "答1" }] },
        { role: "user", content: [{ type: "text", text: "本轮" }] },
      ],
    };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(3);
    expect((body.system as { cache_control?: unknown }[])[0]!.cache_control).toBeDefined();
    expect(body.tools![1]!.cache_control).toBeDefined();
    expect(body.messages![1]!.content[0]!.cache_control).toBeDefined();
  });

  it("消息不足 2 条时不打历史断点(无稳定前缀可言)", () => {
    const body = {
      system: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "唯一" }] }],
    };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(1); // 仅 system
  });

  it("content 为 string(非 block 数组)的消息不打断点,不报错", () => {
    const body = {
      system: undefined,
      tools: [],
      messages: [
        { role: "user", content: "纯文本旧" },
        { role: "assistant", content: "纯文本答" },
        { role: "user", content: "纯文本新" },
      ],
    };
    // 不应抛错,且因 content 非 array 跳过历史断点
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(0);
  });

  it("幂等:重复调用不会在同一 block 上叠加多个 cache_control", () => {
    const body = {
      system: "s",
      tools: [{ name: "t" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        { role: "user", content: [{ type: "text", text: "c" }] },
      ],
    };
    const first = applyAnthropicCacheControl(body);
    const second = applyAnthropicCacheControl(body);
    expect(second).toBe(0); // 第二次发现都已标记,不再新增
    expect(first + second).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it("数组型 system:在末元素���断点", () => {
    const body = {
      system: [
        { type: "text", text: "块1" },
        { type: "text", text: "块2" },
      ],
      tools: [],
      messages: [],
    };
    const n = applyAnthropicCacheControl(body);
    expect(n).toBe(1);
    expect(body.system![0]!.cache_control).toBeUndefined();
    expect(body.system![1]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
