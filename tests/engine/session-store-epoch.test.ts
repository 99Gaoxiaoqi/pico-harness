// 4.3 cursor 多端同步:SessionStore 的 epoch + volatile + onRecord 单元测试。
//
// 验证范围(风险最高的 session-store.ts 改动,严格"只加字段不改逻辑"):
// 1. epoch 初始 0,bumpEpoch 后 1,可多次递增
// 2. onRecord 订阅:每条 append 后广播 (record, seq, epoch)
// 3. volatile 字段正确序列化(true 时进 JSON,false/缺省时不带该 key)
// 4. 旧 JSONL(无 volatile 字段)重放兼容:load 后 record.volatile 为 undefined
// 5. Session.recover 跳过 volatile message(不重建进 history)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionRecord } from "../../src/engine/session-store.js";
import { SessionManager } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";

/** 跨平台安全删除(Windows EBUSY/EPERM 退避重试) */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (String(err).includes("EBUSY") || String(err).includes("EPERM")) {
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

describe("SessionStore epoch + onRecord(4.3 cursor 多端同步)", () => {
  let workDir: string;
  let storePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-epoch-"));
    storePath = join(workDir, "test.jsonl");
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("epoch 初始为 0", () => {
    const store = new SessionStore(storePath);
    expect(store.getEpoch()).toBe(0);
  });

  it("bumpEpoch 递增 epoch:0 → 1 → 2", () => {
    const store = new SessionStore(storePath);
    expect(store.getEpoch()).toBe(0);
    store.bumpEpoch();
    expect(store.getEpoch()).toBe(1);
    store.bumpEpoch();
    expect(store.getEpoch()).toBe(2);
  });

  it("onRecord 订阅:appendMessage 后广播 (record, seq, epoch)", async () => {
    const store = new SessionStore(storePath);
    const received: Array<{ record: SessionRecord; seq: number; epoch: number }> = [];
    store.onRecord((record, seq, epoch) => received.push({ record, seq, epoch }));

    await store.appendMessage(0, userMsg("hello"));
    await store.appendMessage(1, userMsg("world"));

    expect(received).toHaveLength(2);
    expect(received[0]!.seq).toBe(0);
    expect(received[0]!.epoch).toBe(0);
    expect(received[0]!.record.type).toBe("message");
    expect(received[1]!.seq).toBe(1);
  });

  it("onRecord 广播当前 epoch:bumpEpoch 后新事件携带新 epoch", async () => {
    const store = new SessionStore(storePath);
    const received: number[] = [];
    store.onRecord((_r, _s, epoch) => received.push(epoch));

    await store.appendMessage(0, userMsg("a"));
    store.bumpEpoch();
    await store.appendMessage(1, userMsg("b"));

    expect(received).toEqual([0, 1]);
  });

  it("onRecord 返回取消订阅函数,取消后不再收到事件", async () => {
    const store = new SessionStore(storePath);
    let count = 0;
    const unsub = store.onRecord(() => count++);

    await store.appendMessage(0, userMsg("a"));
    expect(count).toBe(1);

    unsub();
    await store.appendMessage(1, userMsg("b"));
    expect(count).toBe(1); // 取消后不再增加
  });

  it("onRecord 监听器抛错不影响落盘与其他监听器", async () => {
    const store = new SessionStore(storePath);
    let secondCalled = 0;
    store.onRecord(() => {
      throw new Error("boom");
    });
    store.onRecord(() => secondCalled++);

    // 抛错的监听器不应让 appendMessage reject
    await store.appendMessage(0, userMsg("a"));
    expect(secondCalled).toBe(1); // 第二个监听器仍被调用
  });
});

describe("SessionStore volatile 字段序列化", () => {
  let workDir: string;
  let storePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-volatile-"));
    storePath = join(workDir, "test.jsonl");
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("appendMessage 不传 volatile 时 JSON 行不含 volatile 字段(向后兼容)", async () => {
    const store = new SessionStore(storePath);
    await store.appendMessage(0, userMsg("normal"));
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(storePath, "utf8");
    // 5.8a:文件首行是 meta 头,取最后一行(message 行)解析
    const lines = content.split("\n").filter((l) => l.length > 0);
    const line = lines[lines.length - 1]!;
    expect(line).not.toContain("volatile");
    const parsed = JSON.parse(line) as SessionRecord;
    expect(parsed.type).toBe("message");
    expect((parsed as { volatile?: boolean }).volatile).toBeUndefined();
  });

  it('appendMessage 传 volatile=true 时 JSON 行包含 "volatile":true', async () => {
    const store = new SessionStore(storePath);
    await store.appendMessage(0, userMsg("stream-chunk"), true);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(storePath, "utf8");
    // 5.8a:文件首行是 meta 头,取最后一行(message 行)解析
    const lines = content.split("\n").filter((l) => l.length > 0);
    const parsed = JSON.parse(lines[lines.length - 1]!) as SessionRecord;
    expect(parsed.type).toBe("message");
    expect((parsed as { volatile?: boolean }).volatile).toBe(true);
  });

  it("onRecord 对 volatile 事件透传 volatile 标记", async () => {
    const store = new SessionStore(storePath);
    const records: SessionRecord[] = [];
    store.onRecord((r) => records.push(r));

    await store.appendMessage(0, userMsg("persistent"));
    await store.appendMessage(1, userMsg("volatile-chunk"), true);

    expect(records).toHaveLength(2);
    expect(records[0]!.type).toBe("message");
    expect((records[0]! as { volatile?: boolean }).volatile).toBeUndefined();
    expect(records[1]!.type).toBe("message");
    expect((records[1]! as { volatile?: boolean }).volatile).toBe(true);
  });
});

describe("旧 JSONL(无 volatile)重放兼容", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-old-jsonl-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("手写旧格式 JSONL(无 volatile)load 后 record.volatile 为 undefined", async () => {
    const storePath = join(workDir, "legacy.jsonl");
    // 手写一条旧格式的 message record(无 volatile 字段)
    const legacyLine = JSON.stringify({
      type: "message",
      seq: 0,
      message: { role: "user", content: "legacy message" },
    });
    await writeFile(storePath, legacyLine + "\n", "utf8");

    const store = new SessionStore(storePath);
    const records = await store.load();
    expect(records).toHaveLength(1);
    expect(records[0]!.type).toBe("message");
    // 旧格式重放:volatile 缺省,按 false(持久)处理
    expect((records[0]! as { volatile?: boolean }).volatile).toBeUndefined();
  });

  it("Session.recover 跳过 volatile message(不重建进 history)", async () => {
    const sessionId = "volatile-recover-test";
    const mgr = new SessionManager();
    // 第一次创建并写入:1 条持久 + 1 条 volatile + 1 条持久
    {
      const s = await mgr.getOrCreate(sessionId, workDir, { persistence: true });
      const store = s.recordStore!;
      await store.appendMessage(0, userMsg("持久消息1"));
      await store.appendMessage(1, userMsg("流式片段"), true); // volatile
      await store.appendMessage(2, userMsg("持久消息2"));
      s.close();
    }
    // 等待异步落盘完成
    await new Promise((r) => setTimeout(r, 100));

    // 重建 Session,recover 应只重放出 2 条持久消息,跳过 volatile
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate(sessionId, workDir, { persistence: true });
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("持久消息1");
    expect(s2.getHistory()[1]!.content).toBe("持久消息2");
    s2.close();
  });

  it("Session.undo/rewindTo 时 epoch 递增", async () => {
    const sessionId = "epoch-undo-test";
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate(sessionId, workDir, { persistence: true });
    const store = s.recordStore!;
    expect(store.getEpoch()).toBe(0);

    s.append(userMsg("a"), userMsg("b"), userMsg("c"));
    await new Promise((r) => setTimeout(r, 80));

    // undo 触发 epoch bump
    s.undo(1);
    expect(store.getEpoch()).toBe(1);

    // rewindTo 再次 bump
    s.rewindTo(0);
    expect(store.getEpoch()).toBe(2);
    s.close();
  });
});
