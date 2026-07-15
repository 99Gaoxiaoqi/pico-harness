import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { InMemorySearchStore } from "../../src/memory/in-memory-search-store.js";
import type { ConversationSearchStore } from "../../src/memory/memory-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

describe("conversation search backend integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    FTS5Store.closeAll();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps relevance and limit semantics consistent across SQLite and in-memory search", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-contract-"));
    tempDirs.push(workDir);
    const stores: ConversationSearchStore[] = [new FTS5Store(workDir), new InMemorySearchStore()];

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

  it("keeps projection append and cursor mismatch semantics consistent across backends", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-projection-contract-"));
    tempDirs.push(workDir);
    const stores: ConversationSearchStore[] = [new FTS5Store(workDir), new InMemorySearchStore()];
    const initialCursor = { logId: "session", seq: 10, epoch: 0, eventId: "event-10" };
    const appendedCursor = { logId: "session", seq: 20, epoch: 0, eventId: "event-20" };

    for (const store of stores) {
      if (!store.projectReplace || !store.projectAppend || !store.getProjectionCursor) {
        throw new Error("Projection backend contract is incomplete");
      }
      store.projectReplace(
        "session",
        [{ role: "user", content: "initial projection value" }],
        initialCursor,
      );

      expect(
        store.projectAppend(
          "session",
          1,
          [{ role: "assistant", content: "acceptedprojectiontoken" }],
          initialCursor,
          appendedCursor,
        ),
      ).toBe(true);
      expect(
        store.projectAppend(
          "session",
          2,
          [{ role: "user", content: "rejectedprojectiontoken" }],
          initialCursor,
          { logId: "session", seq: 30, epoch: 0, eventId: "event-30" },
        ),
      ).toBe(false);
      expect(
        store.projectAppend(
          "session",
          2,
          [{ role: "user", content: "rejectedrewindtoken" }],
          appendedCursor,
          { logId: "session", seq: 30, epoch: 1, eventId: "event-30" },
        ),
      ).toBe(false);
      expect(store.getProjectionCursor("session")).toEqual(appendedCursor);
      expect(store.search("acceptedprojectiontoken", 10, "session")).not.toEqual([]);
      expect(store.search("rejectedprojectiontoken", 10, "session")).toEqual([]);
      expect(store.search("rejectedrewindtoken", 10, "session")).toEqual([]);
      store.close();
    }
  });

  it("rolls back FTS messages when the projection cursor transaction fails", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-memory-projection-rollback-"));
    tempDirs.push(workDir);
    const store = new FTS5Store(workDir);
    const dbPath = join(resolvePicoPaths(workDir).workspace.root, "sessions.db");
    const initialCursor = { logId: "session", seq: 1, epoch: 0, eventId: "event-1" };
    store.projectReplace(
      "session",
      [{ role: "user", content: "initial transaction value" }],
      initialCursor,
    );

    const setup = new Database(dbPath);
    setup.exec(`CREATE TRIGGER fail_projection_cursor
      BEFORE UPDATE ON session_projection_cursor
      WHEN NEW.event_id = 'event-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected projection cursor failure');
      END;`);
    setup.close();

    expect(
      store.projectAppend(
        "session",
        1,
        [{ role: "assistant", content: "must roll back with cursor" }],
        initialCursor,
        { logId: "session", seq: 2, epoch: 0, eventId: "event-2" },
      ),
    ).toBe(false);

    const verification = new Database(dbPath, { readonly: true });
    const rejectedRows = verification
      .prepare("SELECT COUNT(*) AS count FROM conversation_chunks WHERE content = ?")
      .get("must roll back with cursor") as { count: number };
    const cursor = verification
      .prepare(
        "SELECT event_id AS eventId FROM session_projection_cursor WHERE session_id = 'session'",
      )
      .get() as { eventId: string };
    verification.close();

    expect(rejectedRows.count).toBe(0);
    expect(cursor.eventId).toBe("event-1");
    store.close();
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
    const workspaceRoot = resolvePicoPaths(workDir).workspace.root;
    const dbPath = join(workspaceRoot, "sessions.db");
    mkdirSync(workspaceRoot, { recursive: true });

    const setup = new Database(dbPath);
    setup.exec("CREATE VIEW skill_usage AS SELECT 1 AS id");
    setup.close();

    const store = new FTS5Store(workDir);
    expect(store.status.state).toBe("degraded");
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
    store.close();
  });
});
