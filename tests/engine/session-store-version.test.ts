// 5.8a:JSONL schema 版本号 + migration 框架单元测试。
//
// 验证范围:
// 1. 新建 SessionStore → appendMessage → load:首行是 meta、schemaVersion=2
// 2. 旧文件(手动写无 meta 的 JSONL)→ load:version=0、records 正常
// 3. migrate v0→v1:原样返回(结构未变)
// 4. meta 行不在 records 数组里(load 已剥离)
// 5. getSchemaVersion:从含/不含 meta 的数组正确判断版本

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  getSchemaVersion,
  migrate,
  type SessionMetadata,
  type SessionRecord,
} from "../../src/engine/session-store.js";
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

/** 让出事件循环等真实文件 IO 走完。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

describe("5.8a SessionStore schema 版本号 + migration", () => {
  let workDir: string;
  let storePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-store-ver-"));
    storePath = join(workDir, "session.jsonl");
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("新建 SessionStore 首次写入产生 meta 头行,schemaVersion=2", async () => {
    const metadata: SessionMetadata = {
      schemaVersion: 2,
      sessionId: "session-identity",
      originalCwd: workDir,
      projectRoot: workDir,
      cwd: workDir,
      sessionProjectDir: workDir,
    };
    const store = new SessionStore(storePath, metadata);
    await store.appendMessage(1, userMsg("hello"));
    await flush();

    // load 剥离 meta,返回的 records 不含 meta
    const records = await store.load();
    expect(records.length).toBe(1);
    expect(records[0]?.type).toBe("message");
    // meta 行不应出现在 records 里
    expect(records.some((r) => r.type === "meta")).toBe(false);

    // 直接读文件验证首行是 meta
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(storePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2); // meta + 1 message
    const firstLine = JSON.parse(lines[0]!) as SessionRecord;
    expect(firstLine.type).toBe("meta");
    expect((firstLine as { schemaVersion: number }).schemaVersion).toBe(2);
    expect(firstLine).toMatchObject(metadata);
    await expect(store.loadMetadata()).resolves.toMatchObject(metadata);
  });

  it("多次 append 只写一次 meta 头", async () => {
    const store = new SessionStore(storePath);
    await store.appendMessage(1, userMsg("a"));
    await store.appendMessage(2, userMsg("b"));
    await store.appendMessage(3, userMsg("c"));
    await flush();

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(storePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // 1 meta + 3 message
    expect(lines.length).toBe(4);
    const metaCount = lines.filter((l) => {
      try {
        return (JSON.parse(l) as SessionRecord).type === "meta";
      } catch {
        return false;
      }
    }).length;
    expect(metaCount).toBe(1);
  });

  it("旧文件(无 meta 头)→ load:version=0、records 正常", async () => {
    // 模拟旧格式:直接写 message 行,无 meta 头
    const oldLine1 = JSON.stringify({ type: "message", seq: 1, message: userMsg("old1") });
    const oldLine2 = JSON.stringify({ type: "message", seq: 2, message: userMsg("old2") });
    await writeFile(storePath, oldLine1 + "\n" + oldLine2 + "\n", "utf8");

    const store = new SessionStore(storePath);
    const records = await store.load();
    expect(records.length).toBe(2);
    expect(records[0]?.type).toBe("message");
    expect(records[1]?.type).toBe("message");

    // 从 load 结果(已剥离 meta)判断版本:无 meta 头 → 0
    expect(getSchemaVersion(records)).toBe(0);
  });

  it("旧 meta 缺少 session identity 字段时仍可兼容加载", async () => {
    const oldMeta = JSON.stringify({ type: "meta", schemaVersion: 1 });
    const oldLine = JSON.stringify({ type: "message", seq: 1, message: userMsg("old") });
    await writeFile(storePath, `${oldMeta}\n${oldLine}\n`, "utf8");

    const store = new SessionStore(storePath);

    await expect(store.load()).resolves.toMatchObject([
      { type: "message", seq: 1, message: userMsg("old") },
    ]);
    await expect(store.loadMetadata()).resolves.toEqual({ schemaVersion: 1 });
  });

  it("getSchemaVersion:从含 meta 的原始数组正确提取版本", async () => {
    // 构造一个含 meta 头的数组(模拟未剥离的原始读取)
    const withMeta: SessionRecord[] = [
      { type: "meta", schemaVersion: 1 },
      { type: "message", seq: 1, message: userMsg("x") },
    ];
    expect(getSchemaVersion(withMeta)).toBe(1);

    // 不含 meta → 0
    const noMeta: SessionRecord[] = [
      { type: "message", seq: 1, message: userMsg("x") },
    ];
    expect(getSchemaVersion(noMeta)).toBe(0);

    // 空数组 → 0
    expect(getSchemaVersion([])).toBe(0);
  });

  it("migrate v0→v1:原样返回(结构未变)", () => {
    const records: SessionRecord[] = [
      { type: "message", seq: 1, message: userMsg("a") },
      { type: "message", seq: 2, message: userMsg("b") },
      { type: "truncate", seq: 3, fromIndex: 0 },
    ];
    const migrated = migrate(records, 0);
    // v0→v1 无结构变化,原样返回(长度、内容���致)
    expect(migrated.length).toBe(records.length);
    expect(migrated).toEqual(records);
  });

  it("migrate v1→v1:fromVersion 已是当前版本,原样返回", () => {
    const records: SessionRecord[] = [
      { type: "message", seq: 1, message: userMsg("a") },
    ];
    const migrated = migrate(records, 1);
    expect(migrated).toEqual(records);
  });

  it("meta 行不在 records 数组里(跨旧→新追加场景)", async () => {
    // 先写旧文件,再用新 SessionStore 追加(此时 initialized 仍 false,会补写 meta)
    const oldLine = JSON.stringify({ type: "message", seq: 1, message: userMsg("old") });
    await writeFile(storePath, oldLine + "\n", "utf8");

    const store = new SessionStore(storePath);
    await store.appendMessage(2, userMsg("new"));
    await flush();

    const records = await store.load();
    // meta 被剥离,只应有 2 条 message(旧 1 + 新 1)
    const messages = records.filter((r) => r.type === "message");
    expect(messages.length).toBe(2);
    expect(records.some((r) => r.type === "meta")).toBe(false);
  });
});
