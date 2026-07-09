// CredentialPool(多凭证轮换池)单测 (4.2)。
// 验证轮询顺序、限流跳过、冷却恢复、全限流兜底、单 key / 空池兼容。
//
// 用可注入的虚拟时钟(now())控制冷却到期,避免真实定时器;
// 这样限流的 60s 冷却期可在测试中"瞬间"推进,确定性验证恢复行为。

import { describe, expect, it } from "vitest";
import { CredentialPool } from "../../src/provider/credential-pool.js";

/** 虚拟时钟:可手动推进,供冷却到期测试确定性验证。 */
function makeClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("CredentialPool 轮询", () => {
  it("round-robin 依次返回 key1/key2/key3/key1...", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2", "k3"], clock.now);

    expect(pool.getNext()).toBe("k1");
    expect(pool.getNext()).toBe("k2");
    expect(pool.getNext()).toBe("k3");
    // 循环回 k1
    expect(pool.getNext()).toBe("k1");
    expect(pool.getNext()).toBe("k2");
  });

  it("markRateLimited(key1) 后 getNext 跳过 key1", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2", "k3"], clock.now);

    pool.markRateLimited("k1");
    // k1 限流 → 首个取 k2,接着 k3,再回 k2(k1 仍限流)
    expect(pool.getNext()).toBe("k2");
    expect(pool.getNext()).toBe("k3");
    expect(pool.getNext()).toBe("k2");
    expect(pool.available).toBe(2); // k2, k3 可用
  });
});

describe("CredentialPool 冷却恢复", () => {
  it("默认 60s 冷却,到期后 key1 重新可用", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1");
    expect(pool.available).toBe(1);

    // 推进 59s:仍未到期
    clock.advance(59_000);
    expect(pool.available).toBe(1);
    expect(pool.getNext()).toBe("k2");

    // 推进到 60s+:k1 恢复
    clock.advance(2_000);
    expect(pool.available).toBe(2);
    expect(pool.getNext()).toBe("k1");
  });

  it("自定义冷却期 cooldownMs 生效", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1", 10_000); // 10s 冷却
    expect(pool.available).toBe(1);

    clock.advance(9_000);
    expect(pool.available).toBe(1); // 未到期

    clock.advance(2_000);
    expect(pool.available).toBe(2); // 到期恢复
  });
});

describe("CredentialPool 全限流兜底", () => {
  it("所有 key 限流 → 取最早到期的那个(不抛错)", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2", "k3"], clock.now);

    // k1 冷却 60s,k2 冷却 30s,k3 冷却 90s → 最早到期是 k2
    pool.markRateLimited("k1", 60_000);
    pool.markRateLimited("k2", 30_000);
    pool.markRateLimited("k3", 90_000);

    expect(pool.available).toBe(0);

    // 全限流:返回最早到期的 k2
    const got = pool.getNext();
    expect(got).toBe("k2");
  });

  it("所有 key 冷却时 getNextAvailable 返回 undefined,供 retry 走退避", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1", 60_000);
    pool.markRateLimited("k2", 30_000);

    expect(pool.available).toBe(0);
    expect(pool.getNextAvailable()).toBeUndefined();
  });
});

describe("CredentialPool 单 key / 空池兼容", () => {
  it("单 key:getNext 总返回那一个", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["solo"], clock.now);

    expect(pool.getNext()).toBe("solo");
    expect(pool.getNext()).toBe("solo");
    expect(pool.size).toBe(1);
  });

  it("单 key:即使 markRateLimited 仍返回该 key(无替代 key)", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["solo"], clock.now);

    pool.markRateLimited("solo");
    // 单 key 无轮换空间,仍返回它(交给 retry 层指数退避)
    expect(pool.getNext()).toBe("solo");
  });

  it("空数组:getNext 返回空串,size=0,available=0", () => {
    const clock = makeClock();
    const pool = new CredentialPool([], clock.now);

    expect(pool.size).toBe(0);
    expect(pool.available).toBe(0);
    expect(pool.getNext()).toBe("");
  });

  it("逗号分隔的空段被过滤(只留非空 key)", () => {
    const clock = makeClock();
    // 模拟 LLM_API_KEYS="k1,,k2," 的解析结果
    const pool = new CredentialPool(["k1", "", "k2", ""], clock.now);

    expect(pool.size).toBe(2);
    expect(pool.getNext()).toBe("k1");
    expect(pool.getNext()).toBe("k2");
  });
});

describe("CredentialPool markRateLimited 边界", () => {
  it("标记非池内 key 被忽略(不影响状态)", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("not-in-pool");
    expect(pool.available).toBe(2); // 无影响
    expect(pool.getNext()).toBe("k1");
  });
});

describe("CredentialPool markRateLimitedWithInfo(精确冷却)", () => {
  it("retryAfterMs=5000 → 冷却 5000ms", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimitedWithInfo("k1", { retryAfterMs: 5_000 });
    // k1 限流 5s
    clock.advance(4_999);
    expect(pool.available).toBe(1); // 未到期
    clock.advance(1);
    expect(pool.available).toBe(2); // 5000ms 到期恢复
  });

  it("resetAt=now+10000 → 冷却约 10000ms", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimitedWithInfo("k1", { resetAt: 1000 + 10_000 });
    // diff = 11000 - 1000 = 10000 → 冷却到 now+10000 = 11000
    expect(pool.available).toBe(1);
    clock.advance(9_999);
    expect(pool.available).toBe(1); // now=10999,未到期
    clock.advance(1);
    expect(pool.available).toBe(2); // now=11000,到期恢复
  });

  it("resetAt 已过期(diff<=0)→ 回退默认 60s", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    // resetAt < now → diff<=0,使用默认 60s
    pool.markRateLimitedWithInfo("k1", { resetAt: 500 });
    expect(pool.available).toBe(1);
    clock.advance(59_000);
    expect(pool.available).toBe(1); // 60s 冷却未到期
    clock.advance(2_000);
    expect(pool.available).toBe(2); // 60s+ 到期
  });

  it("retryAfterMs 优先于 resetAt", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    // 两者都给:retryAfterMs 优先
    pool.markRateLimitedWithInfo("k1", { retryAfterMs: 3_000, resetAt: 1000 + 60_000 });
    expect(pool.available).toBe(1);
    clock.advance(2_999);
    expect(pool.available).toBe(1); // 按 3s 冷却,未到期
    clock.advance(1);
    expect(pool.available).toBe(2); // 3s 到期恢复
  });

  it("都没有 → 默认 60s(回归)", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimitedWithInfo("k1", {});
    expect(pool.available).toBe(1);
    clock.advance(59_000);
    expect(pool.available).toBe(1);
    clock.advance(2_000);
    expect(pool.available).toBe(2); // 60s+ 恢复
  });

  it("retryAfterMs<=0 → 跳过,走 resetAt 或默认", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimitedWithInfo("k1", { retryAfterMs: 0 });
    // retryAfterMs<=0 被忽略 → 默认 60s
    expect(pool.available).toBe(1);
    clock.advance(59_000);
    expect(pool.available).toBe(1);
    clock.advance(2_000);
    expect(pool.available).toBe(2);
  });

  it("非池内 key 被忽略", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimitedWithInfo("not-in-pool", { retryAfterMs: 5_000 });
    expect(pool.available).toBe(2); // 无影响
  });
});

describe("CredentialPool getRateLimitStatus", () => {
  it("未限流 → rateLimited=false,无 resetsAt", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    expect(pool.getRateLimitStatus("k1")).toEqual({ rateLimited: false });
  });

  it("限流中 → rateLimited=true,resetsAt 为到期时间戳", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1", 10_000);
    expect(pool.getRateLimitStatus("k1")).toEqual({
      rateLimited: true,
      resetsAt: 11_000,
    });
  });

  it("过期后 → 自动清标记,rateLimited=false", () => {
    const clock = makeClock(1000);
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1", 10_000);
    clock.advance(10_001);
    expect(pool.getRateLimitStatus("k1")).toEqual({ rateLimited: false });
  });

  it("非池内 key → rateLimited=false", () => {
    const clock = makeClock();
    const pool = new CredentialPool(["k1", "k2"], clock.now);

    pool.markRateLimited("k1", 10_000);
    expect(pool.getRateLimitStatus("unknown")).toEqual({ rateLimited: false });
  });
});
