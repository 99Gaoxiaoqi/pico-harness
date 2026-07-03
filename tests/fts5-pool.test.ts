// FTS5Store 连接池化单测。
// 验证:同 workDir 复用单例(acquire 返回同实例)、引用计数、归零真关、closeAll。

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FTS5Store } from "../src/memory/fts5-store.js";

let tempDir: string;

function freshDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "fts5-pool-"));
  return tempDir;
}

afterEach(() => {
  // 清理池 + 残留句柄,再删目录
  FTS5Store.closeAll();
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放,temp 会被系统清理 */
    }
  }
});

describe("FTS5Store 连接池化", () => {
  it("acquire 同一 workDir 两次返回同一实例(单例)", () => {
    const dir = freshDir();
    const a = FTS5Store.acquire(dir);
    const b = FTS5Store.acquire(dir);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b); // 同一引用
  });

  it("acquire 不同 workDir 返回不同实例", () => {
    const dir1 = freshDir();
    const dir2 = mkdtempSync(join(tmpdir(), "fts5-pool2-"));
    const a = FTS5Store.acquire(dir1);
    const b = FTS5Store.acquire(dir2);
    expect(a).not.toBe(b);
    FTS5Store.release(dir2);
    try {
      rmSync(dir2, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("引用计数:多次 acquire 需等量 release 才真关并从池移除", () => {
    const dir = freshDir();
    const a = FTS5Store.acquire(dir)!;
    FTS5Store.acquire(dir); // rc=2
    a.insert("s1", 0, { role: "user", content: "测试池化" });
    const dbPath = join(dir, ".claw", "sessions.db");
    expect(existsSync(dbPath)).toBe(true);

    // 第一次 release:rc=1,实例仍在池中
    FTS5Store.release(dir);
    const c = FTS5Store.acquire(dir)!;
    expect(c).toBe(a); // 同实例,db 仍开
    c.insert("s1", 1, { role: "user", content: "再写一条" });

    // 把所有引用释放干净:当前 rc=2(a 与 c),需两次 release
    FTS5Store.release(dir);
    FTS5Store.release(dir); // rc=0,真关并从池移除

    // 再 acquire 是全新实例(池已清)
    const d = FTS5Store.acquire(dir)!;
    expect(d).not.toBe(a);
    FTS5Store.release(dir);
  });

  it("release 未 acquire 的 workDir 不报错(幂等)", () => {
    expect(() => FTS5Store.release("/nonexistent/path")).not.toThrow();
  });

  it("release 幂等:重复 release 不使 refCount 变负", () => {
    const dir = freshDir();
    FTS5Store.acquire(dir);
    FTS5Store.release(dir);
    // refCount 已归零、池已删;再 release 不应抛错或产生负计数
    expect(() => FTS5Store.release(dir)).not.toThrow();
  });

  it("closeAll 清空所有池实例", () => {
    const dir1 = freshDir();
    const dir2 = mkdtempSync(join(tmpdir(), "fts5-pool3-"));
    FTS5Store.acquire(dir1);
    FTS5Store.acquire(dir2);
    FTS5Store.closeAll();
    // closeAll 后再 acquire 应是全新实例
    const a = FTS5Store.acquire(dir1)!;
    expect(a).toBeDefined();
    FTS5Store.release(dir1);
    try {
      rmSync(dir2, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe("FTS5Store 向后兼容(直接 new)", () => {
  it("直接 new FTS5Store + close() 仍可用(旧代码路径)", () => {
    const dir = freshDir();
    const store = new FTS5Store(dir);
    store.insert("s1", 0, { role: "user", content: "直接构造" });
    expect(store.search("直接")).toBeDefined();
    store.close(); // 不应抛错
  });
});
