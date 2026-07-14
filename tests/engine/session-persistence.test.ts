// Session + FTS5 持久化与可靠性测试套件。
//
// 验证范围:
// 1. 断点续传:Session 关闭后重新创建,历史完整恢复
// 2. 跨 Session 全文检索:不同 Session 的消息正确隔离和检索
// 3. WorkingMemory 与 FTS5 数据一致性
// 4. 持久化失败降级逻辑
// 5. 多 Session 隔离
// 6. 并发 Session 安全性
// 7. 真实场景模拟(飞书多群、崩溃恢复)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/engine/session.js";
import { SessionStore } from "../../src/engine/session-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { Message } from "../../src/schema/message.js";
import {
  corruptDatabase,
  simulateDiskFull,
  restorePermissions,
} from "../helpers/fault-injection.js";

/** 显式开启持久化的 getOrCreate 选项 */
const ON = { persistence: true } as const;

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

function toolUseMsg(toolName: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "1", name: toolName, input: {} }],
  };
}

function toolResultMsg(result: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "1", content: result }],
  };
}

/**
 * 等待异步文件 IO 完成。
 * append/truncate 是 fire-and-forget,需让出事件循环等真实 IO 走完。
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

/**
 * 跨平台安全删除:带退避重试。
 * Windows 上 SQLite(better-sqlite3)的 sessions.db / .db-wal / .db-shm 句柄
 * 在 Session 被 GC 前可能仍占用,rm 立即触发 EBUSY。重试几次给句柄释放时间。
 * Session.close() 是首选清理方式,但本测试文件 Session 都是局部变量、出作用域
 * 等 GC,此 helper 作为兜底保证测试目录被清掉。
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
        // 句柄未释放,退避后重试
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err; // 其他错误直接抛
    }
  }
}

describe("Session + FTS5 断点续传", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-resume-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("Session 1: 插入 5 条消息 → 关闭, Session 2: 重建 → 检索到全部 5 条", async () => {
    // Session 1: 插入消息
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("user_001", workDir, ON);
    s1.append(
      userMsg("帮我创建一个 HTTP Server"),
      assistantMsg("好的,我先读取 package.json"),
      toolUseMsg("read_file"),
      toolResultMsg("文件不存在"),
      assistantMsg("我来创建 package.json"),
    );
    await s1.flushPersistence();
    expect(s1.length).toBe(5);

    // 模拟 Session 关闭(进程重启)
    // Session 2: 重建同一 workDir 的 Session
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("user_001", workDir, ON);

    // WorkingMemory 恢复
    expect(s2.length).toBe(5);
    expect(s2.getHistory()[0]!.content).toBe("帮我创建一个 HTTP Server");
    expect(s2.getHistory()[4]!.content).toBe("我来创建 package.json");

    // FTS5 检索恢复
    const results = s2.search("HTTP Server");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("HTTP Server");
  });

  it("新 session metadata 包含 cwd、projectRoot 与 sessionProjectDir", async () => {
    const mgr = new SessionManager();
    const session = await mgr.getOrCreate("identity_001", workDir, ON);
    session.append(userMsg("hello identity"));
    await session.flushPersistence();

    const storePath = join(resolvePicoPaths(workDir).workspace.sessions, "identity_001.jsonl");
    const metadata = await new SessionStore(storePath).loadMetadata();

    expect(metadata).toMatchObject({
      sessionId: "identity_001",
      cwd: workDir,
      originalCwd: expect.any(String) as string,
      projectRoot: workDir,
      sessionProjectDir: workDir,
    });
  });

  it("Session 2 继续插入 5 条 → Session 3 检索到全部 10 条", async () => {
    // Session 1
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("user_002", workDir, ON);
    s1.append(userMsg("m1"), userMsg("m2"), userMsg("m3"), userMsg("m4"), userMsg("m5"));
    await flush();

    // Session 2: 继续插入
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("user_002", workDir, ON);
    expect(s2.length).toBe(5);
    s2.append(userMsg("m6"), userMsg("m7"), userMsg("m8"), userMsg("m9"), userMsg("m10"));
    await flush();
    expect(s2.length).toBe(10);

    // Session 3: 检索全部
    const mgr3 = new SessionManager();
    const s3 = await mgr3.getOrCreate("user_002", workDir, ON);
    expect(s3.length).toBe(10);

    // FTS5 检索到所有消息
    const results = s3.search("m");
    expect(results.length).toBe(10);
  });

  it("truncateTo 后断点续传,只保留截断后的消息", async () => {
    // Session 1: 插入后截断
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("user_trunc", workDir, ON);
    s1.append(userMsg("old1"), userMsg("old2"), userMsg("keep1"), userMsg("keep2"));
    await flush();
    s1.truncateTo(2); // 只保留 keep1, keep2
    await flush();
    expect(s1.length).toBe(2);

    // Session 2: 恢复后应只有 keep1, keep2
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("user_trunc", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("keep1");
    expect(s2.getHistory()[1]!.content).toBe("keep2");

    // 检索索引与可恢复历史一致，不保留已截断的消息。
    expect(s2.search("old")).toEqual([]);
    expect(s2.search("keep")).toHaveLength(2);
  });
});

describe("跨 Session 全文检索", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-fts5-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("Session A 插入'添加工具', Session B 插入'修复 bug', Session C 分别检索", async () => {
    const mgr = new SessionManager();

    // Session A: 讨论添加工具
    const sA = await mgr.getOrCreate("chat_A", workDir, ON);
    sA.append(userMsg("帮我添加一个新工具"), assistantMsg("好的,我来添加 read_file 工具"));
    await flush();

    // Session B: 讨论修复 bug
    const sB = await mgr.getOrCreate("chat_B", workDir, ON);
    sB.append(userMsg("有个 bug 需要修复"), assistantMsg("我查看一下错误日志"));
    await flush();

    // Session C: 检索"工具" → 只返回 A 的消息
    const resultsTools = sA.search("工具");
    expect(resultsTools.length).toBeGreaterThan(0);
    expect(resultsTools.every((r) => r.sessionId === "chat_A")).toBe(true);
    expect(resultsTools[0]!.content).toContain("工具");

    // Session C: 检索"bug" → 只返回 B 的消息
    const resultsBug = sB.search("bug");
    expect(resultsBug.length).toBeGreaterThan(0);
    expect(resultsBug.every((r) => r.sessionId === "chat_B")).toBe(true);
    expect(resultsBug[0]!.content).toContain("bug");

    // Session A 不应检索到"bug"
    expect(sA.search("bug").length).toBe(0);

    // Session B 不应检索到"工具"
    expect(sB.search("工具").length).toBe(0);
  });

  it("检索不存在的关键词 → 返回空数组", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_empty", workDir, ON);
    s.append(userMsg("hello world"));
    await flush();

    const results = s.search("不存在的关键词XYZ123");
    expect(results).toEqual([]);
  });

  it("空 Session 检索 → 返回空数组", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_new", workDir, ON);

    const results = s.search("任何关键词");
    expect(results).toEqual([]);
  });
});

describe("WorkingMemory 与 FTS5 数据一致性", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-consistency-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("Session.append() 后 WorkingMemory 和 FTS5 都包含该消息", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_1", workDir, ON);

    s.append(userMsg("测试消息ABC"));
    await flush();

    // WorkingMemory 包含
    expect(s.length).toBe(1);
    expect(s.getHistory()[0]!.content).toBe("测试消息ABC");

    // FTS5 包含
    const results = s.search("ABC");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("测试消息ABC");
  });

  it("Session.truncateTo() 后检索索引同步当前历史", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_2", workDir, ON);

    s.append(userMsg("old_message"), userMsg("new_message"));
    await flush();

    // 截断,只保留 new_message
    s.truncateTo(1);
    await flush();

    // WorkingMemory 只有 new_message
    expect(s.length).toBe(1);
    expect(s.getHistory()[0]!.content).toBe("new_message");

    // 已从当前可恢复历史删除的消息不再可检索。
    expect(s.search("old_message")).toEqual([]);
    expect(s.search("new_message")).toHaveLength(1);
  });

  it("Session.applyCompaction() 后检索索引反映压缩后的历史", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_compact", workDir, ON);

    s.append(userMsg("原始消息1"), userMsg("原始消息2"), userMsg("原始消息3"));
    await flush();

    // 应用压缩:前 2 条压缩为摘要
    s.applyCompaction("摘要:讨论了消息1和2", 2);
    await flush();

    // WorkingMemory: 摘要 + 原始消息3
    expect(s.length).toBe(2);
    expect(s.getHistory()[0]!.content).toContain("摘要");
    expect(s.getHistory()[1]!.content).toBe("原始消息3");

    // 原文已被摘要取代，仅摘要和保留的尾部消息可检索。
    expect(s.search("原始消息1")).toEqual([]);
    expect(s.search("原始消息2")).toEqual([]);
    expect(s.search("摘要")).toHaveLength(1);
    expect(s.search("原始消息3")).toHaveLength(1);
  });

  it("Session.search() 和 WorkingMemory.getWorkingMemory() 数据不冲突", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_3", workDir, ON);

    // 插入 10 条消息
    for (let i = 0; i < 10; i++) {
      s.append(userMsg(`message_${i}`));
    }
    await flush();

    // WorkingMemory 获取最近 5 条
    const recent = s.getWorkingMemory(5);
    expect(recent.length).toBe(5);
    expect(recent[0]!.content).toBe("message_5");

    // FTS5 检索应返回全部匹配
    const allResults = s.search("message");
    expect(allResults.length).toBe(10);
  });
});

describe("持久化失败降级逻辑", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-fault-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("FTS5 初始化失败 → Session 降级后仍可检索", async () => {
    // 跨平台注入:把 workspace state root 占用为普通文件，使 FTS5Store 构造失败。
    // 旧的 chmod(0o444) 在 Windows 上对目录无效(只读位只阻止删目录,不阻止建文件),
    // 用"文件占位"是 POSIX/Windows 都确定能触发降级 catch 的方案。
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const paths = resolvePicoPaths(workDir);
    mkdirSync(paths.home.workspaces, { recursive: true });
    writeFileSync(paths.workspace.root, "blocker");

    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_fault", workDir, ON);

    // Session 正常工作，检索降级为 JSONL/内存后端。
    s.append(userMsg("test message"));
    expect(s.length).toBe(1);
    expect(s.memoryStatus).toMatchObject({
      backend: "jsonl_memory",
      state: "degraded",
      persistentSource: "none",
    });

    const results = s.search("test");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("test message");
  });

  it("FTS5 插入失败(磁盘满) → Session.append() 继续成功, 只记录 warn", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_disk_full", workDir, ON);

    s.append(userMsg("before disk full"));
    await flush();

    // 模拟磁盘满(改为只读)
    const dbPath = join(resolvePicoPaths(workDir).workspace.root, "sessions.db");
    simulateDiskFull(dbPath);

    // 继续 append(应该成功,即使 FTS5 失败)
    // Session.append() 的核心行为:FTS5 失败不阻塞主流程
    s.append(userMsg("after disk full"));
    await flush();

    // WorkingMemory 正常工作
    expect(s.length).toBe(2);
    expect(s.getHistory()[1]!.content).toBe("after disk full");

    // search() 可能失败或返回部分结果,但不应抛异常
    const results = s.search("before");
    // 只验证不抛异常,不强制要求返回特定结果
    expect(Array.isArray(results)).toBe(true);

    // 清理
    restorePermissions(dbPath);
  });

  it("FTS5 检索失败 → Session.search() 返回空数组, 不抛异常", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat_search_fail", workDir, ON);

    s.append(userMsg("test data"));
    await flush();

    // 损坏前先关闭当前 Session 的 SQLite 连接,避免句柄占用 + 防止它的连接
    // 通过 checkpoint 把数据写回主 db(那样 corrupt 就白做了)。
    s.close();

    // 删除 WAL 三件套的全部附属文件,再损坏主 db。
    // 只删 -wal 不够:-shm 还在时 SQLite 可能用共享内存恢复;必须连同删掉。
    const dbPath = join(resolvePicoPaths(workDir).workspace.root, "sessions.db");
    const { unlinkSync, existsSync } = await import("node:fs");
    for (const suffix of ["-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) unlinkSync(p);
    }
    corruptDatabase(dbPath);

    // 创建新 Session,数据库损坏应导致 FTS5 初始化失败(this.db=null 降级)
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat_search_fail2", workDir, ON);

    // search() 应降级返回空数组(FTS5 未初始化)
    const results = s2.search("test");
    expect(results).toEqual([]);
  });

  it("重启后 FTS5 恢复正常 → 检索到之前的消息", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat_recover", workDir, ON);

    s1.append(userMsg("persistent message"));
    await flush();

    // 第一次检索成功
    const results1 = s1.search("persistent");
    expect(results1.length).toBe(1);

    // 模拟数据库临时故障后恢复(这里只是重启,FTS5 自动恢复)
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat_recover", workDir, ON);

    // 检索到之前的消息
    const results2 = s2.search("persistent");
    expect(results2.length).toBe(1);
    expect(results2[0]!.content).toBe("persistent message");
  });
});

describe("多 Session 隔离", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-isolation-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("Session A 插入消息, Session B 检索时只返回 B 的消息", async () => {
    const mgr = new SessionManager();

    const sA = await mgr.getOrCreate("alice", workDir, ON);
    sA.append(userMsg("Alice's message"));
    await flush();

    const sB = await mgr.getOrCreate("bob", workDir, ON);
    sB.append(userMsg("Bob's message"));
    await flush();

    // A 检索只返回 A 的消息
    const resultsA = sA.search("message");
    expect(resultsA.length).toBe(1);
    expect(resultsA.every((r) => r.sessionId === "alice")).toBe(true);

    // B 检索只返回 B 的消息
    const resultsB = sB.search("message");
    expect(resultsB.length).toBe(1);
    expect(resultsB.every((r) => r.sessionId === "bob")).toBe(true);
  });

  it("5 个 Session 各自插入并检索, 互不干扰", async () => {
    const mgr = new SessionManager();
    const sessions = [];

    for (let i = 0; i < 5; i++) {
      const s = await mgr.getOrCreate(`session_${i}`, workDir, ON);
      s.append(userMsg(`message from session ${i}`));
      sessions.push(s);
    }
    await flush();

    // 每个 Session 只检索到自己的消息
    for (let i = 0; i < 5; i++) {
      const results = sessions[i]!.search(`session ${i}`);
      expect(results.length).toBe(1);
      expect(results[0]!.sessionId).toBe(`session_${i}`);
    }
  });
});

describe("并发 Session 测试", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-concurrent-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("10 个 Session 同时创建并插入消息", async () => {
    const mgr = new SessionManager();

    const tasks = Array.from({ length: 10 }, async (_, i) => {
      const s = await mgr.getOrCreate(`concurrent_${i}`, workDir, ON);
      s.append(userMsg(`concurrent message ${i}`));
      return s;
    });

    const sessions = await Promise.all(tasks);
    await Promise.all(sessions.map((session) => session.flushPersistence()));

    // 验证每个 Session 的数据独立
    for (let i = 0; i < 10; i++) {
      expect(sessions[i]!.length).toBe(1);
      expect(sessions[i]!.getHistory()[0]!.content).toBe(`concurrent message ${i}`);
    }
  });

  it("并发检索无死锁", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("concurrent_search", workDir, ON);

    // 先插入一些数据
    for (let i = 0; i < 100; i++) {
      s.append(userMsg(`message ${i}`));
    }
    await s.flushPersistence();

    // 并发执行 50 次检索（传入 limit=100）
    const searchTasks = Array.from({ length: 50 }, () => {
      return s.search("message", 100);
    });

    const results = await Promise.all(searchTasks);

    // 所有检索都应成功返回 100 条
    for (const r of results) {
      expect(r.length).toBe(100);
    }
  });

  it("所有 Session 的消息都正确持久化", async () => {
    const mgr1 = new SessionManager();

    // 并发创建 20 个 Session
    const tasks = Array.from({ length: 20 }, async (_, i) => {
      const s = await mgr1.getOrCreate(`persist_${i}`, workDir, ON);
      s.append(userMsg(`persistent ${i}`));
      await s.flushPersistence();
    });

    await Promise.all(tasks);

    // 重启后验证所有 Session 都恢复了
    const mgr2 = new SessionManager();
    for (let i = 0; i < 20; i++) {
      const s = await mgr2.getOrCreate(`persist_${i}`, workDir, ON);
      expect(s.length).toBe(1);
      expect(s.getHistory()[0]!.content).toBe(`persistent ${i}`);
    }
  });
});

describe("真实场景模拟", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-real-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  it("飞书多群对话隔离", async () => {
    const mgr = new SessionManager();

    // 群 A 讨论添加工具
    const sessionA = await mgr.getOrCreate("feishu_chat_123", workDir, ON);
    sessionA.append(userMsg("帮我添加一个新工具"));
    sessionA.append(assistantMsg("好的,我来添加 read_file 工具"));
    sessionA.append(toolUseMsg("read_file"));
    sessionA.append(toolResultMsg("工具添加成功"));

    // 群 B 讨论修复 bug
    const sessionB = await mgr.getOrCreate("feishu_chat_456", workDir, ON);
    sessionB.append(userMsg("有个 bug 需要修复"));
    sessionB.append(assistantMsg("我查看一下日志"));
    sessionB.append(toolUseMsg("bash"));
    sessionB.append(toolResultMsg("发现错误:NullPointerException"));

    await flush();

    // 群 A 检索"工具" → 只返回 A 的消息
    const resultsA = sessionA.search("工具");
    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsA.every((r) => r.sessionId === "feishu_chat_123")).toBe(true);

    // 群 B 检索"bug" → 只返回 B 的消息
    const resultsB = sessionB.search("bug");
    expect(resultsB.length).toBeGreaterThan(0);
    expect(resultsB.every((r) => r.sessionId === "feishu_chat_456")).toBe(true);

    // 群 A 不应检索到"bug"
    expect(sessionA.search("bug").length).toBe(0);

    // 群 B 不应检索到"工具"
    expect(sessionB.search("工具").length).toBe(0);
  });

  it("Agent 崩溃后恢复对话", async () => {
    // 第一次对话(模拟崩溃前)
    {
      const mgr = new SessionManager();
      const session = await mgr.getOrCreate("user_001", workDir, ON);
      try {
        session.append(userMsg("帮我写个 HTTP Server"));
        session.append(assistantMsg("好的,我先创建 package.json"));
        session.append(toolUseMsg("write_file"));
        session.append(toolResultMsg("文件创建成功"));
        session.append(userMsg("用 TypeScript"));
        await session.flushPersistence();

        expect(session.length).toBe(5);
      } finally {
        // 同进程测试不会因离开代码块就销毁 Session，显式释放 writer 才是可重现的重启边界。
        await session.close();
      }
    }

    // 重启后恢复(模拟崩溃后)
    {
      const mgr = new SessionManager();
      const session = await mgr.getOrCreate("user_001", workDir, ON);
      try {
        // WorkingMemory 自动恢复(recover 在 getOrCreate 时自动调用)
        expect(session.length).toBe(5);
        expect(session.getHistory()[0]!.content).toBe("帮我写个 HTTP Server");
        expect(session.getHistory()[4]!.content).toBe("用 TypeScript");

        // FTS5 自动恢复
        const results = session.search("HTTP Server");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]!.content).toContain("HTTP Server");

        // 可以继续对话
        session.append(assistantMsg("好的,我用 TypeScript 重写"));
        await session.flushPersistence();
        expect(session.length).toBe(6);
      } finally {
        await session.close();
      }
    }
  });

  it("长程对话 + 压缩 + 检索", async () => {
    const mgr = new SessionManager();
    const session = await mgr.getOrCreate("long_chat", workDir, ON);

    // 模拟 30 轮对话
    for (let i = 0; i < 30; i++) {
      session.append(userMsg(`request ${i}`));
      session.append(assistantMsg(`response ${i}`));
    }
    await session.flushPersistence();

    expect(session.length).toBe(60);

    // 应用压缩:前 40 条压缩为摘要
    await session.applyCompaction("摘要:前 20 轮讨论了各种功能实现", 40);
    await session.flushPersistence();

    // WorkingMemory 压缩后只有 21 条(摘要 + 后 20 条)
    expect(session.length).toBe(21);

    // 检索只反映压缩后的可恢复历史。
    expect(session.search("request 5").some((result) => result.content === "request 5")).toBe(
      false,
    );
    expect(session.search("request 25").some((result) => result.content === "request 25")).toBe(
      true,
    );

    // 重启后验证
    const mgr2 = new SessionManager();
    const session2 = await mgr2.getOrCreate("long_chat", workDir, ON);

    // WorkingMemory 恢复压缩后的状态
    expect(session2.length).toBe(21);

    // 重启重建后保持相同的检索语义。
    expect(session2.search("request 5").some((result) => result.content === "request 5")).toBe(
      false,
    );
    expect(session2.search("request 25").some((result) => result.content === "request 25")).toBe(
      true,
    );
  });

  it("跨 Session 断电恢复", async () => {
    const mgr1 = new SessionManager();

    // 创建 3 个 Session,模拟生产环境同时处理多个用户
    const s1 = await mgr1.getOrCreate("user_a", workDir, ON);
    const s2 = await mgr1.getOrCreate("user_b", workDir, ON);
    const s3 = await mgr1.getOrCreate("user_c", workDir, ON);

    s1.append(userMsg("user A request"));
    s2.append(userMsg("user B request"));
    s3.append(userMsg("user C request"));
    await Promise.all([s1.flushPersistence(), s2.flushPersistence(), s3.flushPersistence()]);

    // 模拟断电(所有 Session 对象销毁)

    // 重启后恢复
    const mgr2 = new SessionManager();
    const r1 = await mgr2.getOrCreate("user_a", workDir, ON);
    const r2 = await mgr2.getOrCreate("user_b", workDir, ON);
    const r3 = await mgr2.getOrCreate("user_c", workDir, ON);

    // 所有 Session 都正确恢复
    expect(r1.length).toBe(1);
    expect(r1.getHistory()[0]!.content).toBe("user A request");

    expect(r2.length).toBe(1);
    expect(r2.getHistory()[0]!.content).toBe("user B request");

    expect(r3.length).toBe(1);
    expect(r3.getHistory()[0]!.content).toBe("user C request");

    // FTS5 检索也都正常
    expect(r1.search("user A").length).toBe(1);
    expect(r2.search("user B").length).toBe(1);
    expect(r3.search("user C").length).toBe(1);
  });
});
