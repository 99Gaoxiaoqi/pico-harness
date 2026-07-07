// 凭证轮换集成测试 (4.2):验证 generateWithRetry 遇 429 时
// 通过 onRateLimited 回调触发 CredentialPool 切换 key、用新 provider 重试成功。
//
// 复刻 run-agent.ts 的轮换策略:pool.getNext() 取首 key →
// 429 时 markRateLimited(当前 key) + getNext() 取下一个 → 重建 provider。
// 断言:两次 generate 用的 apiKey 不同(切 key 真发生),第 2 次成功。

import { describe, expect, it, vi } from "vitest";
import { CredentialPool } from "../../src/provider/credential-pool.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { generateWithRetry } from "../../src/provider/retry.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const ok: Message = { role: "assistant", content: "ok" };
const msgs: Message[] = [{ role: "user", content: "hi" }];
const tools: ToolDefinition[] = [];

type MockFn = ReturnType<typeof vi.fn>;

/** 构造 mock provider:generate 是 vi.fn,可由测试编排返回值。 */
function makeProvider(): { provider: LLMProvider; fn: MockFn } {
  const fn = vi.fn();
  const provider: LLMProvider = { generate: fn as unknown as LLMProvider["generate"] };
  return { provider, fn };
}

/** 快速退避:固定抖动 + 即时 setTimeout,避免真实等待。 */
function fastBackoff() {
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(globalThis, "setTimeout").mockImplementation((cb) => {
    cb();
    return 0 as unknown as NodeJS.Timeout;
  });
}

describe("凭证轮换(429 → 切 key 重试)", () => {
  it("第 1 次 429 → 标记 key-A 限流、切 key-B → 第 2 次成功", async () => {
    const pool = new CredentialPool(["key-A", "key-B"]);
    let currentKey = pool.getNext(); // key-A
    expect(currentKey).toBe("key-A");

    const providerA = makeProvider();
    const providerB = makeProvider();
    const buildByKey = new Map<string, { provider: LLMProvider; fn: MockFn }>();
    buildByKey.set("key-A", providerA);
    buildByKey.set("key-B", providerB);

    let current = buildByKey.get(currentKey)!;

    // 编排:key-A 抛 429,key-B 成功
    providerA.fn.mockRejectedValueOnce(new LLMStatusError(429, "rate limited"));
    providerB.fn.mockResolvedValueOnce(ok);

    // onRateLimited 回调(复刻 run-agent 的 rebuildProvider)
    const onRateLimited = (): LLMProvider | undefined => {
      pool.markRateLimited(currentKey);
      const nextKey = pool.getNext();
      if (nextKey === currentKey) return undefined; // 全限流兜底
      currentKey = nextKey;
      current = buildByKey.get(currentKey)!;
      return current.provider;
    };

    const res = await generateWithRetry(current.provider, msgs, tools, { onRateLimited });

    expect(res).toBe(ok);
    // 两次 generate 用了不同的 key(切 key 真发生)
    expect(providerA.fn).toHaveBeenCalledTimes(1);
    expect(providerB.fn).toHaveBeenCalledTimes(1);
    // key-A 已被标记限流,仅 key-B 可用
    expect(pool.available).toBe(1);
  });

  it("无 onRateLimited(单 key 场景)→ 429 走原指数退避,不切换", async () => {
    const { provider, fn } = makeProvider();
    fn.mockRejectedValueOnce(new LLMStatusError(429, "limited"));
    fn.mockResolvedValueOnce(ok);

    fastBackoff();

    const res = await generateWithRetry(provider, msgs, tools);
    expect(res).toBe(ok);
    expect(fn).toHaveBeenCalledTimes(2); // 同 provider 重试,无切换

    vi.restoreAllMocks();
  });

  it("全限流兜底:onRateLimited 返回 undefined → 退回指数退避同 key 重试", async () => {
    const pool = new CredentialPool(["only-key"]);
    const { provider, fn } = makeProvider();

    const onRateLimited = (): LLMProvider | undefined => {
      pool.markRateLimited("only-key");
      const next = pool.getNext(); // 单 key → 返回 only-key(同 key)
      return next === "only-key" ? undefined : provider;
    };

    fn.mockRejectedValueOnce(new LLMStatusError(429, "limited"));
    fn.mockResolvedValueOnce(ok);

    fastBackoff();

    const res = await generateWithRetry(provider, msgs, tools, { onRateLimited });
    expect(res).toBe(ok);
    // 同 provider 重试(generate 调 2 次,无切换)
    expect(fn).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("多 key 连续 429:逐个标记限流直到可用 key 成功", async () => {
    // 3 key:key-A 429 → key-B 429 → key-C 成功
    const pool = new CredentialPool(["key-A", "key-B", "key-C"]);
    let currentKey = pool.getNext(); // key-A

    const pa = makeProvider();
    const pb = makeProvider();
    const pc = makeProvider();
    const buildByKey = new Map<string, { provider: LLMProvider; fn: MockFn }>();
    buildByKey.set("key-A", pa);
    buildByKey.set("key-B", pb);
    buildByKey.set("key-C", pc);

    let current = buildByKey.get(currentKey)!;
    pa.fn.mockRejectedValueOnce(new LLMStatusError(429, "limited A"));
    pb.fn.mockRejectedValueOnce(new LLMStatusError(429, "limited B"));
    pc.fn.mockResolvedValueOnce(ok);

    const onRateLimited = (): LLMProvider | undefined => {
      pool.markRateLimited(currentKey);
      const nextKey = pool.getNext();
      if (nextKey === currentKey) return undefined;
      currentKey = nextKey;
      current = buildByKey.get(currentKey)!;
      return current.provider;
    };

    const res = await generateWithRetry(current.provider, msgs, tools, {
      onRateLimited,
      maxAttempts: 5,
    });

    expect(res).toBe(ok);
    expect(pa.fn).toHaveBeenCalledTimes(1);
    expect(pb.fn).toHaveBeenCalledTimes(1);
    expect(pc.fn).toHaveBeenCalledTimes(1);
    expect(pool.available).toBe(1); // 仅 key-C 未限流
  });
});
