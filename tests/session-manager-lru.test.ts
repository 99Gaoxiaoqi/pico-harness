// SessionManager LRU + TTL 内存治理单测。
// 验证:maxSessions 上限驱逐、MRU 提升、TTL 空闲过期、close() 资源释放。
//
// 资源清理:Session 初始化会无条件开 FTS5(better-sqlite3)句柄,Windows 上
// 句柄未释放时 rmSync 触发 EPERM。故每个测试的 mgr 登记到 activeMgr,
// afterEach 先 clear()(close 所有 Session 释放句柄)再删目录。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/engine/session.js";

let workDir: string;
let activeMgr: SessionManager | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pico-lru-"));
  activeMgr = undefined;
});

afterEach(() => {
  activeMgr?.clear();
  rmSync(workDir, { recursive: true, force: true });
});

/** 创建 mgr 并登记到 activeMgr,确保 afterEach 能清理其 Session 的句柄 */
function makeMgr(options?: { maxSessions?: number; ttlMs?: number }): SessionManager {
  const mgr = new SessionManager(options);
  activeMgr = mgr;
  return mgr;
}

describe("SessionManager LRU 驱逐", () => {
  it("超出 maxSessions 时驱逐最旧(首个插入)", async () => {
    const mgr = makeMgr({ maxSessions: 2, ttlMs: 60_000 });
    await mgr.getOrCreate("s1", workDir, { persistence: false });
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    expect(mgr.size).toBe(2);
    await mgr.getOrCreate("s3", workDir, { persistence: false });
    expect(mgr.size).toBe(2);
    expect(mgr.get("s1")).toBeUndefined();
    expect(mgr.get("s2")).toBeDefined();
    expect(mgr.get("s3")).toBeDefined();
  });

  it("get 触发 MRU 提升:被访问的 session 不最先被驱逐", async () => {
    const mgr = makeMgr({ maxSessions: 2, ttlMs: 60_000 });
    await mgr.getOrCreate("s1", workDir, { persistence: false });
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    mgr.get("s1"); // 提升 s1
    await mgr.getOrCreate("s3", workDir, { persistence: false });
    expect(mgr.get("s1")).toBeDefined();
    expect(mgr.get("s2")).toBeUndefined();
  });

  it("getOrCreate 命中已存在 session 也做 MRU 提升", async () => {
    const mgr = makeMgr({ maxSessions: 2, ttlMs: 60_000 });
    await mgr.getOrCreate("s1", workDir, { persistence: false });
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    await mgr.getOrCreate("s1", workDir, { persistence: false }); // 提升
    await mgr.getOrCreate("s3", workDir, { persistence: false });
    expect(mgr.get("s1")).toBeDefined();
    expect(mgr.get("s2")).toBeUndefined();
  });
});

describe("SessionManager TTL 过期", () => {
  it("空闲超 ttlMs 的会话被惰性驱逐(getOrCreate 时清理)", async () => {
    const mgr = makeMgr({ maxSessions: 100, ttlMs: 1 });
    await mgr.getOrCreate("s1", workDir, { persistence: false });
    expect(mgr.size).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    expect(mgr.get("s1")).toBeUndefined();
    expect(mgr.get("s2")).toBeDefined();
  });

  it("未过期的会话不被驱逐", async () => {
    const mgr = makeMgr({ maxSessions: 100, ttlMs: 60_000 });
    await mgr.getOrCreate("s1", workDir, { persistence: false });
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    expect(mgr.size).toBe(2);
  });
});

describe("SessionManager 资源释放", () => {
  it("delete 调用 session.close() 后从管理器移除", async () => {
    const mgr = makeMgr({ maxSessions: 100, ttlMs: 60_000 });
    const sess = await mgr.getOrCreate("s1", workDir, { persistence: false });
    const closeSpy = vi.spyOn(sess, "close");
    const deleted = mgr.delete("s1");
    expect(deleted).toBe(sess);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(mgr.get("s1")).toBeUndefined();
  });

  it("LRU 驱逐时也调用被驱逐 session 的 close()", async () => {
    const mgr = makeMgr({ maxSessions: 1, ttlMs: 60_000 });
    const s1 = await mgr.getOrCreate("s1", workDir, { persistence: false });
    const closeSpy = vi.spyOn(s1, "close");
    await mgr.getOrCreate("s2", workDir, { persistence: false });
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(mgr.get("s1")).toBeUndefined();
  });

  it("clear 释放所有 session 资源", async () => {
    const mgr = makeMgr({ maxSessions: 100, ttlMs: 60_000 });
    const s1 = await mgr.getOrCreate("s1", workDir, { persistence: false });
    const s2 = await mgr.getOrCreate("s2", workDir, { persistence: false });
    const spy1 = vi.spyOn(s1, "close");
    const spy2 = vi.spyOn(s2, "close");
    mgr.clear();
    expect(spy1).toHaveBeenCalledOnce();
    expect(spy2).toHaveBeenCalledOnce();
    expect(mgr.size).toBe(0);
  });
});

describe("SessionManager 默认配置", () => {
  it("向后兼容:new SessionManager() 无参构造可用", () => {
    const mgr = makeMgr();
    expect(mgr.size).toBe(0);
  });
});
