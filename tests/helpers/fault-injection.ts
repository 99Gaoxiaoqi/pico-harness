// 故障注入工具:模拟各种异常场景,验证降级逻辑和容错能力。
//
// 用于测试 Session + FTS5 的可靠性:
// - 数据库文件损坏
// - 磁盘满 / 权限不足
// - 数据库锁竞争
// - 网络中断(未来扩展)

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

/** 损坏 SQLite 数据库文件头(模拟文件损坏) */
export function corruptDatabase(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  const buffer = readFileSync(dbPath);
  // 损坏 SQLite 文件头的前 100 字节(magic number + header)
  buffer.fill(0, 0, Math.min(100, buffer.length));
  writeFileSync(dbPath, buffer);
}

/** 模拟磁盘满:将文件改为只读 */
export function simulateDiskFull(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  // 修改文件权限为只读(0o444 = r--r--r--)
  chmodSync(dbPath, 0o444);
}

/** 恢复文件权限为可读写 */
export function restorePermissions(dbPath: string): void {
  if (!existsSync(dbPath)) {
    return;
  }
  // 恢复为可读写(0o644 = rw-r--r--)
  chmodSync(dbPath, 0o644);
}

/** 损坏 JSONL 文件末行(模拟写入中断) */
export function corruptJSONL(jsonlPath: string): void {
  if (!existsSync(jsonlPath)) {
    throw new Error(`JSONL file not found: ${jsonlPath}`);
  }
  const content = readFileSync(jsonlPath, "utf8");
  // 末尾追加一个半截损坏行(未闭合的 JSON)
  const torn = `${content}{"type":"message","seq":999,"message":{"ro`;
  writeFileSync(jsonlPath, torn);
}

/** 模拟并发写入锁竞争(通过 PRAGMA locking_mode = EXCLUSIVE) */
export function lockDatabase(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }
  // 使用 better-sqlite3 锁定数据库(模拟其他进程持锁)
  const db = new Database(dbPath);
  db.pragma("locking_mode = EXCLUSIVE");
  // 开启一个事务并持有锁(不提交也不回滚)
  db.prepare("BEGIN EXCLUSIVE").run();
  // 返回 db 实例,调用方需保持引用以维持锁
  return db;
}

/** 释放数据库锁 */
export function unlockDatabase(db: Database.Database | null | undefined): void {
  if (db) {
    try {
      db.prepare("ROLLBACK").run();
      db.close();
    } catch {
      // 忽略关闭错误
    }
  }
}
