import type { SqliteSchemaScope } from "./sqlite-schema.js";
export const DEEP_RESEARCH_SCOPE: SqliteSchemaScope = {
  name: "deep_research",
  migrations: new Map([
    [
      1,
      `
    CREATE TABLE deep_research_events (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      command_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, command_key)
    );
  `,
    ],
  ]),
};
