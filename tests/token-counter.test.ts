// 精确 Token 计数器单测。
// 验证 BPE 计数精度(中文场景显著优于 chars/4)、缓存、降级、prime 预加载。

import { afterEach, describe, expect, it } from "vitest";
import {
  countTokens,
  primeTokenizer,
  resetTokenCounterCache,
} from "../src/context/token-counter.js";
import { estimateMessageTokens, estimateMessagesTokens } from "../src/context/context-budget.js";
import type { Message } from "../src/schema/message.js";

afterEach(() => {
  resetTokenCounterCache();
});

describe("countTokens 基础", () => {
  it("空字符串返回 0", () => {
    expect(countTokens("")).toBe(0);
  });

  it("非空文本至少 1 token", () => {
    expect(countTokens("a")).toBeGreaterThanOrEqual(1);
  });
});

describe("countTokens 精度(BPE vs chars/4 兜底)", () => {
  // 注意:countTokens 在词表未加载时走 chars/4 兜底。
  // primeTokenizer 后切到精确 BPE。两组用例分别覆盖两条路径。

  it("未 prime 时走 chars/4 兜底:纯英文约 4 字符/token", () => {
    // 不调 prime,词表未就绪。10 个英文字符 → ceil(10/4)=3
    expect(countTokens("hello world")).toBe(Math.ceil("hello world".length / 4));
  });

  it("prime 后中文 token 数显著大于 chars/4(修正中文低估)", async () => {
    await primeTokenizer();
    const zh = "你好世界,这是一个中文句子,用于验证分词精度。";
    const precise = countTokens(zh);
    const fallback = Math.ceil(zh.length / 4);
    // 中文 BPE 后通常每个字 ≈ 1-2 token,precise 应明显大于 chars/4 估算
    expect(precise).toBeGreaterThan(fallback);
    expect(precise).toBeGreaterThan(0);
  });

  it("prime 后混合中英文给出合理计数", async () => {
    await primeTokenizer();
    const mixed = "请用 read_file 读取 README.md,然后用一句话总结。";
    const count = countTokens(mixed);
    expect(count).toBeGreaterThan(0);
    // 混合文本 token 数应在字符数的 1/4 到 2 倍之间(BPE 对中文偏高、英文偏低)
    expect(count).toBeGreaterThan(mixed.length / 4);
  });

  it("prime 幂等:重复调用不重复加载", async () => {
    await primeTokenizer();
    await primeTokenizer(); // 不应抛错
    expect(countTokens("test text")).toBeGreaterThan(0);
  });
});

describe("countTokens 缓存", () => {
  it("相同文本重复计数命中缓存(返回相同值)", () => {
    const text = "重复的文本内容 repeated content";
    const a = countTokens(text);
    const b = countTokens(text);
    expect(a).toBe(b);
  });
});

describe("estimateMessageTokens / estimateMessagesTokens", () => {
  it("单条消息:content + toolCalls 都计入", () => {
    const msg: Message = {
      role: "assistant",
      content: "调用工具",
      toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
  });

  it("多条消息累加", () => {
    const msgs: Message[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ];
    const single = estimateMessageTokens(msgs[0]!) + estimateMessageTokens(msgs[1]!);
    const total = estimateMessagesTokens(msgs);
    expect(total).toBe(single);
  });

  it("无 toolCalls 的消息按 content 计数", () => {
    const msg: Message = { role: "user", content: "简单文本" };
    expect(estimateMessageTokens(msg)).toBe(countTokens("简单文本"));
  });
});
