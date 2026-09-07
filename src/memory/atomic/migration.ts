import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolvePicoPaths } from "../../paths/pico-paths.js";
import {
  SqliteMemoryItemStore,
  type LegacyMemoryMigrationInput,
} from "../../storage/sqlite/sqlite-memory-item-store.js";
import { LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS, type MemoryItemKind } from "./contracts.js";
import { memorySessionKey } from "./runtime-contracts.js";

export interface AtomicMemoryMigrationReport {
  readonly workspaceKey: string;
  readonly legacyDatabasePath: string;
  readonly status: "no_legacy" | "migrated";
  readonly counts: {
    readonly active: number;
    readonly disabled: number;
    readonly archived: number;
    readonly forgotten: number;
    readonly pending: number;
  };
  readonly importedItems: number;
  readonly chunks: readonly { readonly legacyFactId: string; readonly chunkCount: number }[];
  readonly suppressedEvents: number;
  readonly settings: {
    readonly enabled: boolean;
    readonly autoExtract: boolean;
    readonly recallEnabled: boolean;
  };
  readonly completedAt: number;
}

const flights = new Map<string, Promise<AtomicMemoryMigrationReport>>();

/** Read the preservation source once; a durable new-database marker owns completion. */
export function ensureAtomicMemoryWorkspace(
  workDir: string,
  picoHome: string,
): Promise<AtomicMemoryMigrationReport> {
  const paths = resolvePicoPaths(workDir, { picoHome });
  const databasePath = join(paths.home.root, "memory.sqlite");
  const flightKey = JSON.stringify([databasePath, paths.workspace.id]);
  const existing = flights.get(flightKey);
  if (existing) return existing;
  const task = migrateWorkspace(
    databasePath,
    join(paths.workspace.root, "pico.sqlite"),
    paths.workspace.id,
  );
  flights.set(flightKey, task);
  void task
    .finally(() => {
      if (flights.get(flightKey) === task) flights.delete(flightKey);
    })
    .catch(() => {});
  return task;
}

async function migrateWorkspace(
  databasePath: string,
  legacyDatabasePath: string,
  workspaceKey: string,
): Promise<AtomicMemoryMigrationReport> {
  const store = new SqliteMemoryItemStore(databasePath);
  try {
    const previous = await store.readLegacyMigration(workspaceKey);
    if (previous) return JSON.parse(previous) as AtomicMemoryMigrationReport;
    const source = await readLegacy(legacyDatabasePath, workspaceKey);
    const completedAt = Date.now();
    const report: AtomicMemoryMigrationReport = {
      workspaceKey,
      legacyDatabasePath,
      status: source.found ? "migrated" : "no_legacy",
      counts: source.counts,
      importedItems: source.items.length,
      chunks: source.chunks,
      suppressedEvents: source.suppressedEvents.length,
      settings: source.settings,
      completedAt,
    };
    const committed = await store.commitLegacyMigration({
      workspaceKey,
      reportJson: JSON.stringify(report),
      settings: source.settings,
      items: source.items,
      suppressedEvents: source.suppressedEvents,
    });
    return JSON.parse(committed) as AtomicMemoryMigrationReport;
  } finally {
    store.close();
  }
}

type Row = Record<string, unknown>;
interface LegacySnapshot {
  found: boolean;
  counts: {
    active: number;
    disabled: number;
    archived: number;
    forgotten: number;
    pending: number;
  };
  settings: AtomicMemoryMigrationReport["settings"];
  items: LegacyMemoryMigrationInput["items"][number][];
  chunks: { legacyFactId: string; chunkCount: number }[];
  suppressedEvents: { sessionId: string; eventId: string }[];
}

async function readLegacy(path: string, workspaceKey: string): Promise<LegacySnapshot> {
  const snapshot: LegacySnapshot = {
    found: false,
    counts: { active: 0, disabled: 0, archived: 0, forgotten: 0, pending: 0 },
    settings: { enabled: true, autoExtract: true, recallEnabled: true },
    items: [],
    chunks: [],
    suppressedEvents: [],
  };
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Legacy memory preservation source must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
    throw error;
  }
  // Never construct the legacy repository: its constructor migrates/writes pico.sqlite.
  const legacy = new DatabaseSync(path, { readOnly: true });
  try {
    legacy.exec("PRAGMA query_only = ON; BEGIN");
    const tables = new Set(
      (
        legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    const required = ["memory_facts", "memory_sources", "memory_proposals", "memory_metadata"];
    if (!required.some((table) => tables.has(table))) return snapshot;
    if (!required.every((table) => tables.has(table)))
      throw new Error("Legacy memory schema is incomplete; source remains preserved");
    snapshot.found = true;
    const metadata = new Map(
      (
        legacy.prepare("SELECT key, value_json FROM memory_metadata").all() as {
          key: string;
          value_json: string;
        }[]
      ).map((row) => [row.key, JSON.parse(row.value_json) as unknown]),
    );
    if (metadata.has("workspaceId") && metadata.get("workspaceId") !== workspaceKey)
      throw new Error("Legacy memory workspace identity mismatch");
    const settings = metadata.get("settings");
    if (settings !== undefined) {
      const row = record(settings, "settings");
      if (row.workspaceId !== workspaceKey)
        throw new Error("Legacy memory settings workspace mismatch");
      if (!["eco", "balanced", "quality"].includes(text(row.reviewMode, "reviewMode")))
        throw new Error("Invalid legacy reviewMode");
      snapshot.settings = {
        enabled: boolean(row.enabled, "enabled"),
        autoExtract: boolean(row.autoPropose, "autoPropose") && row.reviewMode !== "eco",
        recallEnabled: boolean(row.injectionEnabled, "injectionEnabled"),
      };
    }
    const facts = legacy.prepare("SELECT * FROM memory_facts ORDER BY fact_id").all() as Row[];
    const proposals = legacy
      .prepare("SELECT count(*) AS n FROM memory_proposals WHERE status = 'pending'")
      .get()!;
    snapshot.counts.pending = Number(proposals.n);
    if (settings === undefined && (facts.length > 0 || snapshot.counts.pending > 0))
      throw new Error("Legacy memory settings are missing");
    const sources = legacy
      .prepare("SELECT * FROM memory_sources ORDER BY source_id")
      .all() as Row[];
    const sourceEvents = new Map(
      sources.map((source) => [
        text(source.source_id, "sourceId"),
        legacySourceEvents(source, workspaceKey),
      ]),
    );
    const forgottenSources = new Set<string>();
    const kinds: Record<string, MemoryItemKind> = {
      preference: "preference",
      correction: "knowledge",
      project_fact: "knowledge",
      reference: "note",
    };
    for (const fact of facts) {
      const factId = text(fact.fact_id, "factId");
      const state = text(fact.state, "state");
      if (
        state !== "active" &&
        state !== "disabled" &&
        state !== "archived" &&
        state !== "forgotten"
      )
        throw new Error("Invalid legacy Fact state");
      snapshot.counts[state] += 1;
      if (state === "forgotten") {
        if (fact.source_id !== null && fact.source_id !== undefined)
          forgottenSources.add(text(fact.source_id, "sourceId"));
        continue;
      }
      const kind = text(fact.kind, "kind");
      if (!kinds[kind]) throw new Error("Invalid legacy Fact kind");
      const title = text(fact.title, "title");
      const content = text(fact.content, "content");
      const body = Array.from(`${title}\n\n${content}`.normalize("NFC"));
      const chunks: string[] = [];
      for (
        let offset = 0;
        offset < body.length;
        offset += LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS
      ) {
        const chunk = body
          .slice(offset, offset + LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS)
          .join("")
          .trim();
        if (chunk) chunks.push(chunk);
      }
      const chunkCount = chunks.length;
      snapshot.chunks.push({ legacyFactId: factId, chunkCount });
      const observedAt = Date.parse(text(fact.created_at, "createdAt"));
      if (!Number.isFinite(observedAt) || observedAt < 0)
        throw new Error("Invalid legacy Fact creation time");
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]!;
        const origin = {
          origin: "legacy_fact_migration",
          workspaceKey,
          legacyFactId: factId,
          legacyKind: kind,
          legacyState: state,
          legacySourceId: fact.source_id ?? null,
          chunkIndex,
          chunkCount,
          legacyCreatedAt: fact.created_at,
          legacyUpdatedAt: fact.updated_at,
        };
        snapshot.items.push({
          operationId: `legacy_memory_${hash([workspaceKey, factId, chunkIndex])}`,
          archived: state !== "active",
          originJson: JSON.stringify(origin),
          sourceEvents:
            typeof fact.source_id === "string" ? (sourceEvents.get(fact.source_id) ?? []) : [],
          item: {
            content: chunk,
            kind: kinds[kind]!,
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: workspaceKey,
            observedAt: Math.min(observedAt, Date.now()),
            origin: "user_requested",
            sources: [],
            keys: migrationKeys(title, chunk, kind),
          },
        });
      }
    }
    const suppressed = new Map<string, { sessionId: string; eventId: string }>();
    for (const source of sources) {
      const id = text(source.source_id, "sourceId");
      if (source.extraction_suppressed_at == null && !forgottenSources.has(id)) continue;
      for (const entry of sourceEvents.get(id) ?? []) suppressed.set(hash(entry), entry);
    }
    snapshot.suppressedEvents = [...suppressed.values()];
    return snapshot;
  } finally {
    legacy.close();
  }
}

function legacySourceEvents(source: Row, workspaceKey: string) {
  const sessionId = memorySessionKey(workspaceKey, text(source.session_id, "source sessionId"));
  const eventIds: unknown = JSON.parse(text(source.event_ids_json, "eventIds"));
  if (!Array.isArray(eventIds)) throw new Error("Invalid legacy Source event IDs");
  return eventIds.map((value) => ({ sessionId, eventId: text(value, "eventId") }));
}

function migrationKeys(title: string, content: string, kind: string) {
  const words = `${title} ${content}`.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const keys = [
    ...new Set([kind, ...words].map((word) => Array.from(word).slice(0, 256).join(""))),
  ].slice(0, 32);
  return keys.map((key) => ({ key, keyType: "exact" as const, keyOrigin: "user" as const }));
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid legacy ${name}`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid legacy ${name}`);
  return value;
}
function record(value: unknown, name: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid legacy ${name}`);
  return value as Row;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
