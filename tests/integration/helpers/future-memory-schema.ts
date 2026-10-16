import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

/** Current-Store-derived legacy fixtures must remove v18-v20 objects before downgrading.
 * Drop revision/index triggers first: surviving triggers on memory_items/keys would otherwise
 * reference removed tables while an older migration rewrites or retires those records.
 * This is fixture construction only, never a production downgrade/migration operation.
 */
export function removeFutureRecallSchemaForLegacyFixture(db: DatabaseSync): void {
  for (const row of db
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type='trigger' AND
    (name GLOB 'memory_recall_revision_*' OR name IN ('memory_content_insert','memory_content_update','memory_content_delete'))`,
    )
    .all()) {
    assert.equal(typeof row.name, "string");
    db.exec(`DROP TRIGGER "${(row.name as string).replaceAll('"', '""')}"`);
  }
  db.exec(`
DROP TABLE IF EXISTS memory_extraction_call_slots;
DROP TABLE IF EXISTS memory_content_postings;
DROP TABLE IF EXISTS memory_content_dirty;
DROP TABLE IF EXISTS memory_content_index_state;
DROP TABLE IF EXISTS memory_recall_revision;
`);
  assert.equal(
    db
      .prepare(
        `SELECT count(*) AS count FROM sqlite_schema WHERE
    name='memory_extraction_call_slots' OR name='memory_recall_revision' OR
    name GLOB 'memory_recall_revision_*' OR name GLOB 'memory_content_*'`,
      )
      .get()!.count,
    0,
  );
}
