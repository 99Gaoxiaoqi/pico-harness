import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { sanitizeMemoryContent } from "../memory/atomic/content-safety.js";
import { AtomicMemoryContextBuilder } from "../memory/atomic/context-builder.js";
import type { MemoryItemRecord, MemoryItemWrite } from "../memory/atomic/contracts.js";
import {
  MemoryItemStoreConflictError,
  normalizeLongTermMemoryContent,
} from "../memory/atomic/contracts.js";
import type { AtomicMemorySettings } from "../memory/atomic/runtime-contracts.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../storage/sqlite/sqlite-memory-item-store.js";
import type {
  RuntimeMemoryItem,
  RuntimeMemorySettings,
  RuntimeNotificationMap,
  RuntimeParams,
  RuntimeResult,
} from "@pico/protocol";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";

export interface DesktopAtomicMemoryServiceOptions {
  readonly picoHome: string;
  readonly now?: () => number;
  readonly publish: <Topic extends "memory.changed" | "memory.deleted">(
    workspacePath: string,
    topic: Topic,
    payload: RuntimeNotificationMap[Topic],
  ) => void;
}

/** Desktop management surface backed directly by authoritative atomic Memory Items. */
export class DesktopAtomicMemoryService {
  private closed = false;
  constructor(private readonly options: DesktopAtomicMemoryServiceOptions) {}

  async list(
    workspacePath: string,
    params: RuntimeParams<"memory.list">,
  ): Promise<RuntimeResult<"memory.list">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const records = await store.listItems({ workspaceKey, includeArchived: true, limit: 1000 });
      return {
        items: records
          .map(projectItem)
          .filter(
            (item) =>
              (!params.lifecycleStates || params.lifecycleStates.includes(item.lifecycleState)) &&
              (!params.kinds || params.kinds.includes(item.kind)),
          )
          .slice(0, params.limit ?? 100),
      };
    });
  }

  async get(workspacePath: string, itemId: string): Promise<RuntimeResult<"memory.get">> {
    return this.withStore(workspacePath, async (store, key) => ({
      item: projectItem(await authorizedItem(store, key, itemId)),
    }));
  }

  async create(workspacePath: string, text: string): Promise<RuntimeResult<"memory.create">> {
    const content = safeContent(text);
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const operationId = operationKey(workspaceKey, `create:${content}`);
      const previous = await store.readOperation(operationId);
      const existing = previous?.results[0]
        ? await store.readItem(previous.results[0].itemId)
        : undefined;
      if (existing && existing.item.content === content) {
        if (existing.item.lifecycleState === "archived") {
          await store.applyMutations({
            operationId: `${operationId}:restore:${existing.item.version}`,
            mutations: [
              {
                type: "restore",
                itemId: existing.item.itemId,
                expectedVersion: existing.item.version,
              },
            ],
          });
        }
        const record = await authorizedItem(store, workspaceKey, existing.item.itemId);
        this.changed(workspacePath, record);
        return { item: projectItem(record) };
      }
      const saved = await store.applyMutations({
        operationId: previous ? `${operationId}:${randomUUID()}` : operationId,
        mutations: [
          {
            type: "create",
            item: {
              content,
              kind: "note",
              statementType: "fact",
              temporalType: "undated",
              scopeType: "workspace",
              scopeKey: workspaceKey,
              observedAt: this.now(),
              origin: "user_requested",
              keys: manualKeys(content),
              sources: [],
            },
          },
        ],
      });
      const record = await authorizedItem(store, workspaceKey, saved.results[0]!.itemId);
      this.changed(workspacePath, record);
      return { item: projectItem(record) };
    });
  }

  async update(
    workspacePath: string,
    params: RuntimeParams<"memory.update">,
  ): Promise<RuntimeResult<"memory.update">> {
    return this.withStore(workspacePath, async (store, key) => {
      const current = await authorizedItem(store, key, params.itemId);
      const editing = params.content !== undefined || params.kind !== undefined;
      if (editing && params.lifecycleState !== undefined)
        throw invalid("请分别保存内容和更改归档状态");
      if (!editing && params.lifecycleState === undefined) throw invalid("没有可更新的记忆字段");
      const operationId = operationKey(key, params.idempotencyKey);
      if (editing) {
        const content = safeContent(params.content ?? current.item.content);
        const item: MemoryItemWrite = {
          content,
          kind: params.kind ?? current.item.kind,
          statementType: current.item.statementType,
          temporalType: current.item.temporalType,
          scopeType: current.item.scopeType,
          scopeKey: current.item.scopeKey,
          eventStartedAt: current.item.eventStartedAt,
          eventEndedAt: current.item.eventEndedAt,
          observedAt: current.item.observedAt,
          origin: "user_requested",
          keys: manualKeys(content),
          sources: [],
        };
        await store.applyMutations({
          operationId,
          mutations: [
            {
              type: "update",
              itemId: params.itemId,
              expectedVersion: params.expectedVersion,
              item,
            },
          ],
        });
      } else {
        await store.applyMutations({
          operationId,
          mutations: [
            {
              type: params.lifecycleState === "active" ? "restore" : "archive",
              itemId: params.itemId,
              expectedVersion: params.expectedVersion,
            },
          ],
        });
      }
      const record = await authorizedItem(store, key, params.itemId);
      this.changed(workspacePath, record);
      return { item: projectItem(record) };
    });
  }

  async delete(
    workspacePath: string,
    params: RuntimeParams<"memory.delete">,
  ): Promise<RuntimeResult<"memory.delete">> {
    return this.withStore(workspacePath, async (store, key) => {
      const record = await authorizedItem(store, key, params.itemId);
      await store.deleteItem({
        itemId: params.itemId,
        expectedVersion: params.expectedVersion,
        operationId: operationKey(key, params.idempotencyKey),
      });
      const version = record.item.version + 1;
      this.publish(() =>
        this.options.publish(workspacePath, "memory.deleted", {
          itemId: params.itemId,
          version,
        }),
      );
      return { itemId: params.itemId, deleted: true };
    });
  }

  async getSettings(workspacePath: string): Promise<RuntimeResult<"memory.settings.get">> {
    return this.withStore(workspacePath, async (store, key) =>
      settingsResult(await store.readSettings(key)),
    );
  }

  async updateSettings(
    workspacePath: string,
    params: RuntimeParams<"memory.settings.update">,
  ): Promise<RuntimeResult<"memory.settings.update">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const settings = await store.updateSettings({
        workspaceKey,
        expectedVersion: params.expectedVersion,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.autoExtract !== undefined ? { autoExtract: params.autoExtract } : {}),
        ...(params.recallEnabled !== undefined ? { recallEnabled: params.recallEnabled } : {}),
      });
      this.publish(() =>
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "settings",
          entityId: "settings",
          version: settings.version,
          change: "updated",
        }),
      );
      return settingsResult(settings);
    });
  }

  async previewContext(
    workspacePath: string,
    params: RuntimeParams<"memory.context.preview">,
  ): Promise<RuntimeResult<"memory.context.preview">> {
    return this.withStore(workspacePath, async (store, key) => {
      const result = await new AtomicMemoryContextBuilder(store, key).build();
      const maxItems = Math.min(params.maxItems ?? 3, 3);
      const maxTokens = Math.min(params.maxTokens ?? 320, 320);
      const fits = result.items.length <= maxItems && result.tokenCount <= maxTokens;
      const items = fits ? result.items.map(projectItem) : [];
      return {
        items,
        budget: {
          maxItems,
          maxTokens,
          usedItems: items.length,
          usedTokens: fits ? result.tokenCount : 0,
          truncated: result.truncated || !fits,
        },
      };
    });
  }

  close(): void {
    this.closed = true;
  }

  private async withStore<T>(
    workspacePath: string,
    operation: (store: SqliteMemoryItemStore, key: string) => Promise<T>,
  ): Promise<T> {
    try {
      if (this.closed) throw new Error("Memory service is closed");
      const key = resolvePicoPaths(workspacePath, { picoHome: this.options.picoHome }).workspace.id;
      const store = new SqliteMemoryItemStore(join(this.options.picoHome, "memory.sqlite"), {
        now: () => this.now(),
      });
      try {
        return await operation(store, key);
      } finally {
        store.close();
      }
    } catch (error) {
      if (error instanceof RuntimeProtocolError) throw error;
      if (error instanceof MemoryItemStoreConflictError)
        throw new RuntimeProtocolError(
          error.reason === "item_not_found"
            ? RUNTIME_ERROR_CODES.NOT_FOUND
            : RUNTIME_ERROR_CODES.CONFLICT,
          "记忆不存在或版本已改变，请刷新后重试",
        );
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, "记忆服务暂时不可用");
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private changed(workspacePath: string, record: MemoryItemRecord): void {
    this.publish(() =>
      this.options.publish(workspacePath, "memory.changed", {
        entityType: "item",
        entityId: record.item.itemId,
        version: record.item.version,
        change: "updated",
      }),
    );
  }
  private publish(callback: () => void): void {
    // The mutation is already durable; a disconnected renderer must not turn it into a failed write.
    try {
      callback();
    } catch {
      /* The renderer can refetch canonical state. */
    }
  }
}

async function authorizedItem(
  store: SqliteMemoryItemStore,
  key: string,
  itemId: string,
): Promise<MemoryItemRecord> {
  const record = await store.readItem(itemId);
  if (!record || (record.item.scopeType === "workspace" && record.item.scopeKey !== key)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有这条记忆");
  }
  return record;
}

function projectItem({ item, sources }: MemoryItemRecord): RuntimeMemoryItem {
  return {
    itemId: item.itemId,
    version: item.version,
    content: item.content,
    kind: item.kind,
    statementType: item.statementType,
    temporalType: item.temporalType,
    scopeType: item.scopeType,
    scopeKey: item.scopeKey,
    eventStartedAt: item.eventStartedAt,
    eventEndedAt: item.eventEndedAt,
    observedAt: item.observedAt,
    lifecycleState: item.lifecycleState,
    origin: item.origin,
    contentHash: item.contentHash,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    sources: sources.map((source) => ({
      sessionId: source.sessionId,
      runId: source.runId,
      turnId: source.turnId,
      eventId: source.eventId,
    })),
  };
}

function safeContent(value: string): string {
  const normalized = normalizeLongTermMemoryContent(value);
  if (!normalized.ok) throw invalid(normalized.message);
  const sanitized = sanitizeMemoryContent({
    title: "记忆",
    content: normalized.value,
    reason: "用户手动保存",
  });
  if (sanitized.disposition !== "allow")
    throw invalid(`记忆安全扫描未通过：${sanitized.safetyCodes.join(", ")}`);
  const stored = normalizeLongTermMemoryContent(sanitized.content);
  if (!stored.ok) throw invalid(stored.message);
  return stored.value;
}

function manualKeys(content: string): MemoryItemWrite["keys"] {
  const text = content.normalize("NFKC").toLowerCase();
  const terms = new Set(text.match(/[\p{L}\p{N}_./-]{2,256}/gu) ?? []);
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const points = [...run];
    for (let i = 0; i + 1 < points.length; i++) terms.add(`${points[i]}${points[i + 1]}`);
  }
  if (terms.size === 0) terms.add([...text].slice(0, 256).join(""));
  return [...terms].slice(0, 32).map((key) => ({ key, keyType: "concept", keyOrigin: "user" }));
}

function operationKey(workspaceKey: string, value: string): string {
  return `desktop:${createHash("sha256")
    .update(JSON.stringify([workspaceKey, value]))
    .digest("hex")}`;
}
function invalid(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}
function settingsResult(value: AtomicMemorySettings): RuntimeResult<"memory.settings.get"> {
  const settings: RuntimeMemorySettings = {
    enabled: value.enabled,
    autoExtract: value.autoExtract,
    recallEnabled: value.recallEnabled,
    version: value.version,
  };
  return { settings };
}
