import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { JsonlMemoryStore } from "../../src/memory/jsonl-memory-store.js";
import type { ConversationSearchStore } from "../../src/memory/memory-store.js";

describe("conversation search backend integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    FTS5Store.closeAll();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps relevance and limit semantics consistent across SQLite and JSONL", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-contract-"));
    tempDirs.push(workDir);
    const stores: ConversationSearchStore[] = [new FTS5Store(workDir), new JsonlMemoryStore()];

    for (const store of stores) {
      store.insert("session", 0, { role: "user", content: "alpha" });
      store.insert("session", 1, { role: "user", content: "alpha alpha alpha" });

      const results = store.search("alpha", 1000);
      expect(results).toHaveLength(2);
      expect(results[0]!.relevance).toBeGreaterThanOrEqual(results[1]!.relevance);
      expect(store.search("alpha", 0)).toHaveLength(1);
      store.close();
    }
  });

  it("exposes runtime search failures through degraded status", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-runtime-"));
    tempDirs.push(workDir);
    const store = new FTS5Store(workDir);

    expect(store.search('"unterminated')).toEqual([]);
    expect(store.status).toMatchObject({
      backend: "sqlite_fts5",
      state: "degraded",
      persistentSource: "sqlite",
      recommendation: expect.any(String),
    });
    expect(store.status.reason).toContain("搜索失败");

    store.close();
  });

  it("closes an opened SQLite handle when schema initialization fails", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-init-"));
    tempDirs.push(workDir);
    const clawDir = join(workDir, ".claw");
    const dbPath = join(clawDir, "sessions.db");
    mkdirSync(clawDir, { recursive: true });

    const setup = new Database(dbPath);
    setup.exec("CREATE VIEW skill_usage AS SELECT 1 AS id");
    setup.close();

    const store = new FTS5Store(workDir);
    expect(store.status.state).toBe("degraded");
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
    store.close();
  });
});
