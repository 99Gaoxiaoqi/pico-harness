import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * kv scope(ADR 24 §4.7,票 08):workspace 级小文档 KV。
 *
 * 首个租户是 todo.json:旧裸 writeFile(无原子性)迁入后顺带获得单事务
 * 原子性;hooks-state/plugins workspace 态按需后续迁入。
 */

export const KV_SCOPE_NAME = "kv";

export const KV_SCOPE: SqliteSchemaScope = {
  name: KV_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE workspace_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      `,
    ],
  ]),
};
