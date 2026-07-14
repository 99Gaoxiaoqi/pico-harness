// Session 持久化(事件溯源 JSONL)的单元测试。
//
// 对标 kimi-code wire.jsonl:append 每条消息追加一行,truncateTo 追加折叠事件,
// 重启后通过 SessionManager.getOrCreate → recover 重放重建 history。
//
// 持久化开关通过构造参数显式传入 { persistence: true },
// 不再依赖环境变量(环境变量是进程级全局,vitest 并行跑测试文件时会相互污染)。
// 用 mkdtemp 创建独立临时目录,不污染工作区。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/engine/session.js";
import type { Message } from "../src/schema/message.js";

/** 显式开启持久化的 getOrCreate 选项 */
const ON = { persistence: true } as const;
const OFF = { persistence: false } as const;

/**
 * 跨平台安全删除:Windows 上 SQLite(better-sqlite3)sessions.db 句柄在 Session
 * 被 GC 前仍占用,rm 立即触发 EBUSY。退避重试给句柄释放时间。
 * Session.close() 是首选清理方式,但本测试 Session 是局部变量等 GC,此 helper 兜底。
 */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        String(err).includes("EBUSY") ||
        String(err).includes("EPERM") ||
        String(err).includes("ENOTEMPTY")
      ) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("Session 持久化(事件溯源 JSONL)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-sess-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("append 落盘后,新进程 getOrCreate 能重建历史", async () => {
    // 第一次:创建会话,append 两条
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-X", workDir, ON);
    s1.append(userMsg("hello"), assistantMsg("world"));
    await s1.flushPersistence();
    expect(s1.length).toBe(2);

    // 模拟重启:新建 SessionManager(内存清空),同 id 重建
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-X", workDir, ON);
    // recover 后历史应为 2 条,内容一致
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("hello");
    expect(s2.getHistory()[1]!.content).toBe("world");
  });

  it("truncateTo 落盘后,recover 正确折叠历史", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-trunc", workDir, ON);
    s1.append(userMsg("m0"), userMsg("m1"), userMsg("m2"), userMsg("m3"));
    await s1.flushPersistence();
    // 截断,只保留 index=2 起(m2, m3)
    s1.truncateTo(2);
    await s1.flushPersistence();
    expect(s1.length).toBe(2);

    // 重启恢复
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-trunc", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("m2");
    expect(s2.getHistory()[1]!.content).toBe("m3");
  });

  it("恢复后再 append,seq 不回退(不覆盖旧记录)", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-seq", workDir, ON);
    s1.append(userMsg("first"));
    await s1.flushPersistence();

    // 重启恢复,再 append 一条
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-seq", workDir, ON);
    expect(s2.length).toBe(1);
    s2.append(userMsg("second"));
    await s2.flushPersistence();

    // 再重启,应看到两条(证明 seq 续上了,没有覆盖)
    const mgr3 = new SessionManager();
    const s3 = await mgr3.getOrCreate("chat-seq", workDir, ON);
    expect(s3.length).toBe(2);
    expect(s3.getHistory()[0]!.content).toBe("first");
    expect(s3.getHistory()[1]!.content).toBe("second");
  });

  it("多 Session 在持久化下物理隔离(各自独立文件)", async () => {
    const mgr1 = new SessionManager();
    const sA = await mgr1.getOrCreate("feishu:群A", workDir, ON);
    const sB = await mgr1.getOrCreate("feishu:群B", workDir, ON);
    sA.append(userMsg("群A的消息"));
    sB.append(userMsg("群B的消息"));
    await Promise.all([sA.flushPersistence(), sB.flushPersistence()]);

    // 重启恢复:两个会话互不串
    const mgr2 = new SessionManager();
    const rA = await mgr2.getOrCreate("feishu:群A", workDir, ON);
    const rB = await mgr2.getOrCreate("feishu:群B", workDir, ON);
    expect(rA.length).toBe(1);
    expect(rB.length).toBe(1);
    expect(rA.getHistory()[0]!.content).toBe("群A的消息");
    expect(rB.getHistory()[0]!.content).toBe("群B的消息");
  });

  it("sessionId 含特殊字符被清洗为安全文件名", async () => {
    // "feishu:群/1" 含 : 和 /,须清洗后才不会破坏路径
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("feishu:群/1", workDir, ON);
    s1.append(userMsg("特殊 id"));
    await s1.flushPersistence();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("feishu:群/1", workDir, ON);
    expect(s2.length).toBe(1);
    expect(s2.getHistory()[0]!.content).toBe("特殊 id");
  });

  it("persistence:false 时持久化关闭,重启不恢复(纯内存)", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-off", workDir, OFF);
    s1.append(userMsg("不会落盘"));
    await s1.flushPersistence();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-off", workDir, OFF);
    // 持久化关闭 → recover 空操作 → 历史为空
    expect(s2.length).toBe(0);
  });
});

describe("SessionStore 末行撕裂容忍", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-tear-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("最后一行损坏(撕裂)时,重启修复残尾并保留完整记录", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-tear", workDir, ON);
    try {
      s1.append(userMsg("good-1"), userMsg("good-2"));
      // 以公开 durability 契约冻结已提交边界。固定 sleep 在全量 IO
      // 压力下可能只等到第一条 fdatasync。
      await s1.flushPersistence();
    } finally {
      // close 同时释放 pooled writer / OwnerLease / FTS，建立真实重启边界。
      await s1.close();
    }

    // 人为撕裂:把文件末尾追加一行半截 JSON,模拟崩溃时 append 写一半
    const file = join(workDir, ".claw", "sessions", "chat-tear.jsonl");
    await appendFile(file, '{"type":"message","seq":999,"message":{"ro', "utf8");

    // 重启恢复:新 writer 先修复撕裂末行,再严格重放两条完整消息。
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-tear", workDir, ON);
    try {
      expect(s2.length).toBe(2); // good-1 + good-2,撕裂行被修复
      const contents = s2
        .getHistory()
        .map((m) => m.content)
        .sort();
      expect(contents).toEqual(["good-1", "good-2"]);
      expect(await readFile(file, "utf8")).not.toContain('"seq":999');
    } finally {
      await s2.close();
    }
  });

  it("首次启动(无文件)recover 为空历史,不报错", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat-new", workDir, ON);
    expect(s.length).toBe(0);
  });
});

describe("truncate 竞态保护(pendingWrites 顺序保证)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-race-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("truncate 前的 appends 已落盘,truncate 不会抢跑导致 message 丢失", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("race-chat", workDir, ON);
    s1.append(userMsg("m0"), userMsg("m1"), userMsg("m2"), userMsg("m3"));
    // 不 flush!立即 truncate(模拟连续快速调用)
    await s1.truncateTo(2);
    await s1.flushPersistence();
    expect(s1.length).toBe(2);

    // 重启恢复:应得到 m2, m3(证明 appends 先于 truncate 落盘)
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("race-chat", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("m2");
    expect(s2.getHistory()[1]!.content).toBe("m3");
  });

  it("truncate 后再 append,seq 正常续接", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("race-seq", workDir, ON);
    s1.append(userMsg("a0"), userMsg("a1"));
    await s1.truncateTo(1); // 只保留 a1
    await s1.flushPersistence();
    // truncate 后再 append
    s1.append(userMsg("a2"));
    await s1.flushPersistence();
    expect(s1.length).toBe(2);

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("race-seq", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("a1");
    expect(s2.getHistory()[1]!.content).toBe("a2");
  });

  it("truncate record 在 JSONL 文件中物理位于所有 prior message records 之后", async () => {
    // 直接验证 pendingWrites 顺序保证的核心不变量:
    // persistTruncate 先 await Promise.all(pendingWrites) 再写 truncate record,
    // 因此磁盘上 truncate 行一定排在所有 prior message 行之后。
    // 若无此修复(fire-and-forget 不 await),truncate 可能抢跑先落盘,出现在文件中间。
    //
    // 注意:仅靠 recover 后的历史无法区分有无修复 —— SessionStore.load() 会按 seq
    // 排序(session-store.ts:87),掩盖磁盘乱序。只有检查原始文件物理行顺序才能
    // 暴露竞态。这是本 describe 块中唯一能真正区分"修复前/后"的测试。
    const { readFile } = await import("node:fs/promises");
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("race-order", workDir, ON);
    s.append(userMsg("m0"), userMsg("m1"), userMsg("m2"), userMsg("m3"));
    // 不 flush!立即 truncate —— 触发 pendingWrites await 路径
    await s.truncateTo(2);
    await s.flushPersistence();

    // 直接读原始 JSONL,检查物理行顺序(不依赖 load() 的 seq 排序)
    const file = join(workDir, ".claw", "sessions", "race-order.jsonl");
    const content = await readFile(file, "utf8");
    const lines = content.trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as { type: string; fromIndex?: number });
    const metaRecords = records.filter((rec) => rec.type === "meta");
    const dataRecords = records.filter((rec) => rec.type !== "meta");
    expect(metaRecords).toHaveLength(1);
    expect(dataRecords).toHaveLength(5); // 4 messages + 1 truncate

    // 前 4 行必须全是 message(证明 appends 先落盘)
    for (let i = 0; i < 4; i++) {
      const rec = dataRecords[i]!;
      expect(rec).toMatchObject({ type: "event", kind: "message.appended" });
    }
    // 最后一行必须是 truncate(证明 truncate 没有抢跑到 message 前面)
    const last = dataRecords[4]!;
    expect(last).toMatchObject({
      type: "event",
      kind: "history.truncated",
      data: { fromIndex: 2 },
    });
  });
});
