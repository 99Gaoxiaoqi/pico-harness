import type { DatabaseSync } from "node:sqlite";
import type { MemorySearchSignals } from "@pico/core/atomic-memory-contracts";
import { collectMemoryContentLexemes, scoreMemoryContent } from "@pico/core/atomic-memory-search";

/** Install once in the owner's schema migration, never on every Store open. */
export const MEMORY_CONTENT_INDEX_SCHEMA_SQL = `
CREATE TABLE memory_content_postings (
  kind TEXT NOT NULL CHECK(kind IN ('path','token','cjk')),
  term TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(kind,term,item_id)
) WITHOUT ROWID;
CREATE INDEX memory_content_postings_item ON memory_content_postings(item_id);
CREATE TABLE memory_content_dirty (item_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE memory_content_index_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  format_version INTEGER NOT NULL CHECK(format_version=1)
);
INSERT INTO memory_content_index_state VALUES(1,1);
INSERT INTO memory_content_dirty SELECT item_id FROM memory_items WHERE lifecycle_state='active';
CREATE TRIGGER memory_content_insert AFTER INSERT ON memory_items WHEN NEW.lifecycle_state='active'
BEGIN INSERT OR IGNORE INTO memory_content_dirty VALUES(NEW.item_id); END;
CREATE TRIGGER memory_content_update AFTER UPDATE OF content,lifecycle_state,item_id ON memory_items
BEGIN
  DELETE FROM memory_content_postings WHERE item_id=OLD.item_id;
  DELETE FROM memory_content_dirty WHERE item_id=OLD.item_id;
  INSERT OR IGNORE INTO memory_content_dirty SELECT NEW.item_id WHERE NEW.lifecycle_state='active';
END;
CREATE TRIGGER memory_content_delete AFTER DELETE ON memory_items
BEGIN
  DELETE FROM memory_content_postings WHERE item_id=OLD.item_id;
  DELETE FROM memory_content_dirty WHERE item_id=OLD.item_id;
END;
`;

export interface MemoryContentIndexHit {
  readonly itemId: string;
  readonly score: number;
  readonly updatedAt: number;
}
const contentBody = (content: string): string =>
  content.replace(/^用户要求保留的助手笔记（未经独立核实） \[[1-9]\d*\/[1-9]\d*\]：/u, "");
function atomic<T>(db: DatabaseSync, action: () => T): T {
  db.exec("SAVEPOINT pico_memory_content_index");
  try {
    const result = action();
    db.exec("RELEASE pico_memory_content_index");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO pico_memory_content_index; RELEASE pico_memory_content_index");
    throw error;
  }
}

/** Flush is transactional, including when nested in the Store's read snapshot. */
export function flushMemoryContentIndex(db: DatabaseSync): number {
  return atomic(db, () => {
    const state = db
      .prepare("SELECT format_version FROM memory_content_index_state WHERE singleton=1")
      .get();
    if (state?.format_version !== 1) throw new Error("memory_content_index_unavailable");
    const dirty = db.prepare("SELECT item_id FROM memory_content_dirty ORDER BY item_id").all();
    if (!dirty.length) return 0;
    const read = db.prepare(
      "SELECT content FROM memory_items WHERE item_id=? AND lifecycle_state='active'",
    );
    const clear = db.prepare("DELETE FROM memory_content_postings WHERE item_id=?");
    const clean = db.prepare("DELETE FROM memory_content_dirty WHERE item_id=?");
    const insert = db.prepare(
      "INSERT OR IGNORE INTO memory_content_postings(kind,term,item_id) VALUES(?,?,?)",
    );
    for (const { item_id: itemId } of dirty) {
      if (typeof itemId !== "string") throw new Error("memory_content_index_invalid_identity");
      clear.run(itemId);
      const row = read.get(itemId);
      if (row) {
        if (typeof row.content !== "string")
          throw new Error("memory_content_index_invalid_content");
        const lexemes = collectMemoryContentLexemes(contentBody(row.content));
        for (const [kind, terms] of [
          ["path", lexemes.paths],
          ["token", lexemes.tokens],
          ["cjk", lexemes.cjkBigrams],
        ] as const)
          for (const term of terms) insert.run(kind, term, itemId);
      }
      clean.run(itemId);
    }
    return dirty.length;
  });
}

/** Explicit recovery operation; normal opens must not rebuild a healthy index. */
export function rebuildMemoryContentIndex(db: DatabaseSync): number {
  return atomic(db, () => {
    db.exec(
      "DELETE FROM memory_content_postings; DELETE FROM memory_content_dirty; INSERT INTO memory_content_dirty SELECT item_id FROM memory_items WHERE lifecycle_state='active'",
    );
    return flushMemoryContentIndex(db);
  });
}

/** undefined means unavailable/unsupported: the caller MUST use its original scan. */
export function queryMemoryContentIndex(
  db: DatabaseSync,
  input: {
    readonly workspaceKey: string;
    readonly signals: MemorySearchSignals;
    readonly limit: number;
  },
): readonly MemoryContentIndexHit[] | undefined {
  const { signals, workspaceKey, limit } = input;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  // scoreMemoryContent permits arbitrary substring signals through the Store API.
  // Only the query collector's actual two-CJK-codepoint terms have postings.
  if (
    signals.cjkBigrams.some(
      (term) => !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}$/u.test(term),
    )
  )
    return undefined;
  const terms = [
    ...signals.paths.map((term) => ["path", term]),
    ...signals.tokens.map((term) => ["token", term]),
    ...signals.cjkBigrams.map((term) => ["cjk", term]),
  ];
  if (terms.length > 32) return undefined;
  try {
    return atomic(db, () => {
      flushMemoryContentIndex(db);
      if (!terms.length) return [];
      const placeholders = terms.map(() => "(?,?)").join(",");
      // Preserve duplicates in VALUES: the reference scorer counts duplicate query terms.
      // Include every score/time boundary tie, then apply JS UTF-16 identity order.
      const rows = db
        .prepare(
          `
WITH query_terms(kind,term) AS (VALUES ${placeholders}),
scores AS (
 SELECT p.item_id,m.updated_at,
  SUM(CASE p.kind WHEN 'path' THEN 8 WHEN 'token' THEN 4 ELSE 0 END) +
  CASE WHEN SUM(CASE WHEN p.kind='cjk' THEN 1 ELSE 0 END)>=2
   THEN min(8,SUM(CASE WHEN p.kind='cjk' THEN 1 ELSE 0 END)) ELSE 0 END AS score
 FROM query_terms q JOIN memory_content_postings p ON p.kind=q.kind AND p.term=q.term
 JOIN memory_items m ON m.item_id=p.item_id
 WHERE m.lifecycle_state='active' AND (m.scope_type='global' OR (m.scope_type='workspace' AND m.scope_key=?))
 GROUP BY p.item_id
), ranked AS (
 SELECT *,rank() OVER (ORDER BY score DESC,updated_at DESC) AS boundary_rank FROM scores WHERE score>0
)
SELECT item_id,updated_at,score FROM ranked WHERE boundary_rank<=?
`,
        )
        .all(...terms.flat(), workspaceKey, limit);
      const hits = rows
        .map((row): MemoryContentIndexHit => {
          if (
            typeof row.item_id !== "string" ||
            typeof row.score !== "number" ||
            typeof row.updated_at !== "number"
          )
            throw new Error("memory_content_index_invalid_hit");
          return { itemId: row.item_id, score: row.score, updatedAt: row.updated_at };
        })
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.updatedAt - a.updatedAt ||
            (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
        )
        .slice(0, limit);
      const read = db.prepare(
        "SELECT content FROM memory_items WHERE item_id=? AND lifecycle_state='active'",
      );
      for (const hit of hits) {
        const row = read.get(hit.itemId);
        if (
          typeof row?.content !== "string" ||
          scoreMemoryContent(contentBody(row.content), signals) !== hit.score
        )
          throw new Error("memory_content_index_verification_failed");
      }
      return hits;
    });
  } catch {
    // Missing migration, corrupt/unwritable index or snapshot-upgrade contention.
    // Never turn an index failure into a false authoritative no-match result.
    return undefined;
  }
}
