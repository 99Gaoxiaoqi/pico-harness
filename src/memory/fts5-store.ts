// FTS5Store: SQLite FTS5 全文检索存储层,为 pico-harness 提供历史对话检索能力。
//
// 解决痛点:长程对话历史滚雪球后,Agent 需要快速定位过去的关键决策、错误教训、
// 技能使用模式等信息。通过 FTS5 虚拟表索引全部对话片段,实现毫秒级语义检索。
//
// 架构设计借鉴 Hermes Agent 的四层记忆:
// 1. conversation_chunks: FTS5 虚拟表,索引每轮对话的 content(role/timestamp 不参与分词)
// 2. session_summaries: 会话摘要表,存储每个 session 的浓缩总结
// 3. skill_usage: 技能使用记录表,追踪哪些 skill 成功/失败,供自愈参考
//
// 路径约定:<workDir>/.claw/sessions.db(与 session-store.jsonl 同级,数据集中化)
// 错误处理:初始化/插入/查询失败时降级,记 warn 不抛异常,不阻断主流程。

import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "pathe";
import { logger } from "../observability/logger.js";
import type { Message } from "../schema/message.js";
import type {
  ConversationSearchStore,
  MemoryBackendStatus,
  MemorySearchResult,
} from "./memory-store.js";

/** @deprecated 请改用 MemorySearchResult。保留别名以兼容既有外部导入。 */
export type SearchResult = MemorySearchResult;

/** 会话摘要(对标 Hermes 的 Long-term Memory) */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 技能使用统计(对标 Hermes 的 Skill Memory) */
export interface SkillStats {
  skillId: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  recentErrors: string[]; // 最近 5 条错误消息
}

interface ClassifiedInitError {
  reason: string;
  recommendation: string;
}

function errorCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function classifyInitError(err: unknown): ClassifiedInitError {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  const code = errorCode(err)?.toUpperCase();

  if (
    normalized.includes("node_module_version") ||
    normalized.includes("different node.js version") ||
    normalized.includes("module did not self-register") ||
    normalized.includes("invalid elf header") ||
    normalized.includes("incompatible architecture") ||
    normalized.includes("wrong architecture") ||
    normalized.includes("mach-o")
  ) {
    return {
      reason: `better-sqlite3 原生模块与当前 Node ABI ${process.versions.modules ?? "unknown"} 不兼容`,
      recommendation:
        "请在当前 Node 环境运行 npm rebuild better-sqlite3；仍失败时重新运行 npm ci。不要跨设备复制 node_modules。",
    };
  }

  if (
    normalized.includes("could not locate the bindings file") ||
    normalized.includes("cannot find module") ||
    normalized.includes("better_sqlite3.node")
  ) {
    return {
      reason: "better-sqlite3 原生绑定缺失或无法加载",
      recommendation:
        "请在当前 Node 环境运行 npm rebuild better-sqlite3；仍失败时重新运行 npm ci。",
    };
  }

  if (
    normalized.includes("no such module: fts5") ||
    normalized.includes("no such tokenizer: trigram") ||
    (normalized.includes("fts5") && normalized.includes("not available"))
  ) {
    return {
      reason: "当前 SQLite 构建不支持所需的 FTS5/trigram 全文索引",
      recommendation: "请重新安装带 FTS5 支持的 better-sqlite3，或使用 JSONL 记忆检索后端。",
    };
  }

  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "ENOSPC" ||
    code === "SQLITE_READONLY" ||
    code === "SQLITE_CANTOPEN" ||
    code === "SQLITE_FULL" ||
    normalized.includes("readonly") ||
    normalized.includes("read-only") ||
    normalized.includes("permission denied") ||
    normalized.includes("unable to open database file") ||
    normalized.includes("sqlite_cantopen")
  ) {
    return {
      reason: "记忆数据库路径不可创建或不可写",
      recommendation: "请检查工作区及 .claw 目录的路径、所有者、写权限和剩余磁盘空间。",
    };
  }

  const errorKind = code ?? (err instanceof Error ? err.name : "UNKNOWN");
  return {
    reason: `SQLite FTS5 初始化失败（${errorKind}）`,
    recommendation:
      "请检查工作区写权限，并在当前 Node 环境运行 npm rebuild better-sqlite3 后重试。",
  };
}

/**
 * FTS5Store: SQLite FTS5 全文检索存储层。
 *
 * 线程安全:better-sqlite3 默认串行化所有操作(WAL mode + NORMAL synchronous),
 * 单进程多 Session 并发写入安全。跨进程并发需额外加锁(当前不支持)。
 *
 * 【连接池化】同一 workDir 的多个 Session 共享同一个 FTS5Store 实例(单例 + 引用计数),
 * 避免"每 Session new 一个 Database"导致连接数随会话数线性增长(原先 N 个 Session =
 * N 个连接指向同一 sessions.db 文件,争抢文件锁且浪费 fd)。改造后连接数 O(workDir),
 * 通常 O(1)。Session.close() 调 release(),引用计数归零才真正 close db。
 */
export class FTS5Store implements ConversationSearchStore {
  /** workDir → 共享实例 + 引用计数 */
  private static readonly pool = new Map<string, { store: FTS5Store; refCount: number }>();
  /** 避免同一工作目录的相同初始化错误在反复 acquire 时刷屏。 */
  private static readonly loggedDegradations = new Set<string>();

  /**
   * 按 workDir 获取共享 FTS5Store 实例(引用计数 +1)。
   * 同一 workDir 的所有 Session 复用同一个 SQLite 连接,连接数从 O(sessions) 降到 O(1)。
   * 初始化失败(workDir 不可写等)返回 null,降级为纯内存模式。
   */
  static acquire(workDir: string): FTS5Store | null {
    const entry = FTS5Store.pool.get(workDir);
    if (entry) {
      entry.refCount++;
      return entry.store;
    }
    const store = new FTS5Store(workDir);
    // 初始化失败(db 为 null)不进池,直接返回该实例(其内部操作均为空操作)
    FTS5Store.pool.set(workDir, { store, refCount: 1 });
    return store;
  }

  /**
   * 释放引用(计数 -1)。归零时真正 close db 并从池移除。
   * 幂等:重复 release 不使 refCount 变负。
   */
  static release(workDir: string): void {
    const entry = FTS5Store.pool.get(workDir);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      entry.store.closeInternal();
      FTS5Store.pool.delete(workDir);
    }
  }

  /** 关闭所有 workDir 的连接(进程退出前调用) */
  static closeAll(): void {
    for (const { store } of FTS5Store.pool.values()) {
      store.closeInternal();
    }
    FTS5Store.pool.clear();
  }

  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private backendStatus: MemoryBackendStatus = {
    backend: "sqlite_fts5",
    state: "degraded",
    persistentSource: "sqlite",
    nodeVersion: process.version,
    nodeModuleAbi: process.versions.modules,
    reason: "SQLite FTS5 尚未初始化",
  };

  get status(): MemoryBackendStatus {
    return { ...this.backendStatus };
  }

  constructor(workDir: string) {
    this.dbPath = `${workDir}/.claw/sessions.db`;
    try {
      // 确保 .claw/ 目录存在
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.dbPath), 0o700);
      this.db = new Database(this.dbPath);
      chmodSync(this.dbPath, 0o600);
      // 启用 WAL 模式(并发读写性能更好,断电恢复更安全)
      this.db.pragma("journal_mode = WAL");
      this.initSchema();
      this.backendStatus = {
        backend: "sqlite_fts5",
        state: "healthy",
        persistentSource: "sqlite",
        nodeVersion: process.version,
        nodeModuleAbi: process.versions.modules,
      };
      logger.info({ dbPath: this.dbPath }, "[fts5] 数据库初始化成功");
    } catch (err) {
      // 降级:数据库初始化失败不抛异常,仅 warn,后续操作变为空操作
      this.db = null;
      const classified = classifyInitError(err);
      this.backendStatus = {
        backend: "sqlite_fts5",
        state: "degraded",
        persistentSource: "sqlite",
        nodeVersion: process.version,
        nodeModuleAbi: process.versions.modules,
        ...classified,
      };
      const warningKey = `${this.dbPath}\u0000${classified.reason}`;
      if (!FTS5Store.loggedDegradations.has(warningKey)) {
        FTS5Store.loggedDegradations.add(warningKey);
        logger.warn(
          {
            dbPath: this.dbPath,
            nodeVersion: process.version,
            nodeModuleAbi: process.versions.modules,
            ...classified,
          },
          "[fts5] 数据库初始化失败,检索功能降级",
        );
      }
    }
  }

  /** 初始化数据库 schema(幂等:IF NOT EXISTS) */
  private initSchema(): void {
    if (!this.db) return;

    // FTS5 虚拟表:对话片段全文检索
    // tokenize='trigram' 使用 3-gram 分词,对中文/日文等无空格语言友好
    // 性能开销略高,但索引准确度更好(支持子串匹配)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_chunks USING fts5(
        session_id UNINDEXED,
        turn_index UNINDEXED,
        role UNINDEXED,
        content,
        timestamp UNINDEXED,
        tokenize='trigram'
      );
    `);

    // 会话摘要表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // 技能使用记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        success BOOLEAN NOT NULL,
        error_message TEXT,
        timestamp TEXT NOT NULL
      );
    `);

    // 索引:加速技能统计查询
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_usage_skill 
      ON skill_usage(skill_id, success);
    `);
  }

  /**
   * 索引一条消息到 FTS5(供 Session.append 调用)。
   * 降级处理:插入失败时仅 warn,不抛异常,不影响主流程。
   */
  insert(sessionId: string, turnIndex: number, message: Message): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO conversation_chunks (session_id, turn_index, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        sessionId,
        turnIndex,
        message.role,
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        new Date().toISOString(),
      );
    } catch (err) {
      logger.warn({ err, sessionId, turnIndex }, "[fts5] 插入消息失败");
    }
  }

  /**
   * 用当前完整消息替换指定会话的全文索引。
   * 删除与重建在单个 SQLite 事务中完成；任一步失败都会整体回滚。
   */
  replaceSession(sessionId: string, messages: readonly Message[]): void {
    if (!this.db) return;
    try {
      const deleteStmt = this.db.prepare("DELETE FROM conversation_chunks WHERE session_id = ?");
      const insertStmt = this.db.prepare(`
        INSERT INTO conversation_chunks (session_id, turn_index, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      const replace = this.db.transaction((currentMessages: readonly Message[]) => {
        deleteStmt.run(sessionId);
        const timestamp = new Date().toISOString();
        for (const [turnIndex, message] of currentMessages.entries()) {
          insertStmt.run(
            sessionId,
            turnIndex,
            message.role,
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            timestamp,
          );
        }
      });
      replace(messages);
    } catch (err) {
      logger.warn({ err, sessionId }, "[fts5] 重建会话索引失败");
    }
  }

  /**
   * 全文检索对话历史(FTS5 MATCH 语法)。
   *
   * @param query - 搜索关键词(支持 FTS5 查询语法:AND/OR/NOT/"短语")
   * @param limit - 返回结果数上限(默认 10)
   * @param sessionId - 可选的 Session ID 过滤(不传则全局检索)
   * @returns 按相关性排序的结果数组(relevance 越接近 0 越相关)
   *
   * 示例:
   * - search("驾驭工程") → trigram 自动匹配子串(≥3 字符)
   * - search("FTS5 全文检索") → 匹配包含这些关键词的文档
   * - search("Session AND WorkingMemory") → 必须同时包含
   * - search('"Session 物理隔离"') → 精确短语匹配
   *
   * 中文支持:trigram tokenizer 要求查询长度 ≥3 字符。
   * 对于短查询(<3 字符,如"驾驭"),降级为 LIKE 模糊匹配。
   */
  search(query: string, limit = 10, sessionId?: string): MemorySearchResult[] {
    if (!this.db) return [];
    try {
      // trigram tokenizer 要求查询长度 ≥3,对于短查询降级为 LIKE
      if (query.length < 3 && !/\b(AND|OR|NOT)\b|["()]/.test(query)) {
        // 短查询:用 LIKE 模糊匹配(性能略差,但能覆盖短词)
        const whereClause = sessionId
          ? "WHERE content LIKE ? AND session_id = ?"
          : "WHERE content LIKE ?";
        const stmt = this.db.prepare(`
          SELECT 
            session_id AS sessionId,
            turn_index AS turnIndex,
            role,
            content,
            timestamp,
            0 AS relevance
          FROM conversation_chunks
          ${whereClause}
          LIMIT ?
        `);
        const params = sessionId ? [`%${query}%`, sessionId, limit] : [`%${query}%`, limit];
        return stmt.all(...params) as MemorySearchResult[];
      }

      // 标准 FTS5 查询(trigram ≥3 字符)
      const whereClause = sessionId
        ? "WHERE conversation_chunks MATCH ? AND session_id = ?"
        : "WHERE conversation_chunks MATCH ?";
      const stmt = this.db.prepare(`
        SELECT 
          session_id AS sessionId,
          turn_index AS turnIndex,
          role,
          content,
          timestamp,
          rank AS relevance
        FROM conversation_chunks
        ${whereClause}
        ORDER BY rank
        LIMIT ?
      `);
      const params = sessionId ? [query, sessionId, limit] : [query, limit];
      return stmt.all(...params) as MemorySearchResult[];
    } catch (err) {
      logger.warn({ err, query }, "[fts5] 搜索失败");
      return [];
    }
  }

  /**
   * 保存会话摘要(UPSERT:存在则更新,不存在则插入)。
   * 供 ContextCompactor 调用,把压缩后的 summary 持久化到长期记忆。
   */
  saveSummary(sessionId: string, summary: string, messageCount: number): void {
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO session_summaries (session_id, summary, message_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary = excluded.summary,
          message_count = excluded.message_count,
          updated_at = excluded.updated_at
      `);
      stmt.run(sessionId, summary, messageCount, now, now);
    } catch (err) {
      logger.warn({ err, sessionId }, "[fts5] 保存摘要失败");
    }
  }

  /** 获取会话摘要(不存在返回 null) */
  getSummary(sessionId: string): SessionSummary | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(`
        SELECT 
          session_id AS sessionId, 
          summary, 
          message_count AS messageCount, 
          created_at AS createdAt, 
          updated_at AS updatedAt
        FROM session_summaries
        WHERE session_id = ?
      `);
      const row = stmt.get(sessionId) as SessionSummary | undefined;
      return row ?? null;
    } catch (err) {
      logger.warn({ err, sessionId }, "[fts5] 获取摘要失败");
      return null;
    }
  }

  /**
   * 记录技能使用(供 ToolRegistry 调用)。
   * 每次执行 skill 后记录成功/失败,供后续统计分析。
   */
  recordSkillUsage(
    skillId: string,
    sessionId: string,
    success: boolean,
    errorMessage?: string,
  ): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO skill_usage (skill_id, session_id, success, error_message, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(skillId, sessionId, success ? 1 : 0, errorMessage ?? null, new Date().toISOString());
    } catch (err) {
      logger.warn({ err, skillId }, "[fts5] 记录技能使用失败");
    }
  }

  /**
   * 获取技能统计信息(成功率、最近错误等)。
   * 供 SystemReminders 调用,判断是否需要提示"该 skill 近期失败率高,谨慎使用"。
   */
  getSkillStats(skillId: string): SkillStats | null {
    if (!this.db) return null;
    try {
      // 统计总次数、成功/失败数
      const countStmt = this.db.prepare(`
        SELECT 
          COUNT(*) AS total_calls,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failure_count
        FROM skill_usage
        WHERE skill_id = ?
      `);
      const counts = countStmt.get(skillId) as {
        total_calls: number;
        success_count: number;
        failure_count: number;
      };

      if (counts.total_calls === 0) return null;

      // 获取最近 5 条错误消息
      const errorsStmt = this.db.prepare(`
        SELECT error_message
        FROM skill_usage
        WHERE skill_id = ? AND success = 0 AND error_message IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 5
      `);
      const errors = (errorsStmt.all(skillId) as { error_message: string }[]).map(
        (row) => row.error_message,
      );

      return {
        skillId,
        totalCalls: counts.total_calls,
        successCount: counts.success_count,
        failureCount: counts.failure_count,
        successRate: counts.total_calls > 0 ? counts.success_count / counts.total_calls : 0,
        recentErrors: errors,
      };
    } catch (err) {
      logger.warn({ err, skillId }, "[fts5] 获取技能统计失败");
      return null;
    }
  }

  /**
   * 关闭本实例的数据库连接。
   *
   * 语义:
   * - 直接 new 的实例(测试/旧代码):关闭自己的 db 句柄。
   * - 池化 acquire 的实例:通常应通过 FTS5Store.release(workDir) 释放引用;
   *   直接调 close() 会强制关闭共享句柄(供测试精确控制,生产路径勿用)。
   *
   * 幂等:已关闭再调不报错。
   */
  close(): void {
    this.closeInternal();
  }

  /** 关闭数据库连接(内部实现,幂等)。 */
  private closeInternal(): void {
    if (this.db) {
      try {
        this.db.close();
        logger.info("[fts5] 数据库连接已关闭");
      } catch (err) {
        logger.warn({ err }, "[fts5] 关闭数据库失败");
      }
      this.db = null;
      this.backendStatus = {
        backend: "sqlite_fts5",
        state: "degraded",
        persistentSource: "sqlite",
        nodeVersion: process.version,
        nodeModuleAbi: process.versions.modules,
        reason: "SQLite FTS5 连接已关闭",
        recommendation: "需要继续检索时，请重新 acquire 记忆存储。",
      };
    }
  }
}
