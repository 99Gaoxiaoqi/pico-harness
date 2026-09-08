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
  RuntimeMemoryFact,
  RuntimeMemoryKind,
  RuntimeMemorySettings,
  RuntimeNotificationMap,
  RuntimeParams,
  RuntimeResult,
} from "./protocol.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "./protocol.js";

export interface DesktopAtomicMemoryServiceOptions {
  readonly picoHome: string;
  readonly now?: () => number;
  readonly publish: <Topic extends "memory.changed" | "memory.forgotten">(
    workspacePath: string,
    topic: Topic,
    payload: RuntimeNotificationMap[Topic],
  ) => void;
}

/** Atomic Items are authoritative; legacy envelope names only preserve the desktop wire contract. */
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
        facts: records
          .map(projectFact)
          .filter(
            (fact) =>
              (!params.states || params.states.includes(fact.state)) &&
              (!params.kinds || params.kinds.includes(fact.kind)),
          )
          .slice(0, params.limit ?? 100),
      };
    });
  }

  async get(workspacePath: string, factId: string): Promise<RuntimeResult<"memory.get">> {
    return this.withStore(workspacePath, async (store, key) => ({
      fact: projectFact(await authorizedItem(store, key, factId)),
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
        return { fact: projectFact(record) };
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
      return { fact: projectFact(record) };
    });
  }

  async update(
    workspacePath: string,
    params: RuntimeParams<"memory.update">,
  ): Promise<RuntimeResult<"memory.update">> {
    return this.withStore(workspacePath, async (store, key) => {
      const current = await authorizedItem(store, key, params.factId);
      const editing =
        params.content !== undefined || params.title !== undefined || params.kind !== undefined;
      if (
        params.pinned !== undefined ||
        params.confidence !== undefined ||
        params.expiresAt !== undefined ||
        params.lastUsedAt !== undefined
      ) {
        throw invalid("原子记忆不支持置顶、置信度或旧版过期字段");
      }
      if (editing && params.state !== undefined) throw invalid("请分别保存内容和更改归档状态");
      if (!editing && params.state === undefined) throw invalid("没有可更新的记忆字段");
      const operationId = operationKey(key, params.idempotencyKey);
      if (editing) {
        const content = safeContent(params.content ?? params.title ?? current.item.content);
        const item: MemoryItemWrite = {
          content,
          kind: params.kind ? atomicKind(params.kind) : current.item.kind,
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
              itemId: params.factId,
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
              type: params.state === "active" ? "restore" : "archive",
              itemId: params.factId,
              expectedVersion: params.expectedVersion,
            },
          ],
        });
      }
      const record = await authorizedItem(store, key, params.factId);
      this.changed(workspacePath, record);
      return { fact: projectFact(record) };
    });
  }

  async forget(
    workspacePath: string,
    params: RuntimeParams<"memory.forget">,
  ): Promise<RuntimeResult<"memory.forget">> {
    return this.withStore(workspacePath, async (store, key) => {
      const record = await authorizedItem(store, key, params.factId);
      await store.deleteItem({
        itemId: params.factId,
        expectedVersion: params.expectedVersion,
        operationId: operationKey(key, params.idempotencyKey),
      });
      const at = new Date(this.now()).toISOString();
      const fact: RuntimeMemoryFact = {
        factId: params.factId,
        kind: legacyKind(record.item.kind),
        title: null,
        content: null,
        confidence: 0,
        state: "forgotten",
        pinned: false,
        version: record.item.version + 1,
        createdAt: new Date(record.item.createdAt).toISOString(),
        updatedAt: at,
        forgottenAt: at,
      };
      this.publish(() =>
        this.options.publish(workspacePath, "memory.forgotten", {
          factId: fact.factId,
          version: fact.version,
        }),
      );
      return { fact };
    });
  }

  async listReviews(
    _workspacePath: string,
    _params: RuntimeParams<"memory.review.list">,
  ): Promise<RuntimeResult<"memory.review.list">> {
    return { proposals: [] };
  }

  async resolveReview(
    _workspacePath: string,
    _params: RuntimeParams<"memory.review.resolve">,
  ): Promise<RuntimeResult<"memory.review.resolve">> {
    throw invalid("原子记忆直接保存，不再提供旧版审核操作");
  }

  async getSettings(workspacePath: string): Promise<RuntimeResult<"memory.settings.get">> {
    return this.withStore(workspacePath, async (store, key) =>
      settingsResult(await store.readSettings(key), this.now()),
    );
  }

  async updateSettings(
    workspacePath: string,
    params: RuntimeParams<"memory.settings.update">,
  ): Promise<RuntimeResult<"memory.settings.update">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      if (params.autoCommit !== undefined || params.reviewMode !== undefined)
        throw invalid("原子记忆直接保存，请使用启用、自动提取和会话召回开关");
      const settings = await store.updateSettings({
        workspaceKey,
        expectedVersion: params.expectedVersion,
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.autoPropose !== undefined ? { autoExtract: params.autoPropose } : {}),
        ...(params.injectionEnabled !== undefined
          ? { recallEnabled: params.injectionEnabled }
          : {}),
      });
      this.publish(() =>
        this.options.publish(workspacePath, "memory.changed", {
          entityType: "settings",
          entityId: "settings",
          version: settings.version,
          change: "updated",
        }),
      );
      return settingsResult(settings, this.now());
    });
  }

  async previewContext(
    workspacePath: string,
    params: RuntimeParams<"memory.context.preview">,
  ): Promise<RuntimeResult<"memory.context.preview">> {
    return this.withStore(workspacePath, async (store, key) => {
      const result = await new AtomicMemoryContextBuilder(store, key).build();
      const maxFacts = Math.min(params.maxFacts ?? 3, 3);
      const maxTokens = Math.min(params.maxTokens ?? 320, 320);
      const fits = result.items.length <= maxFacts && result.tokenCount <= maxTokens;
      const facts = fits ? result.items.map(projectFact) : [];
      return {
        facts,
        budget: {
          maxFacts,
          maxTokens,
          usedFacts: facts.length,
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
        entityType: "fact",
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

function projectFact({ item, sources }: MemoryItemRecord): RuntimeMemoryFact {
  const source = sources[0];
  return {
    factId: item.itemId,
    kind: legacyKind(item.kind),
    title: [...item.content].slice(0, 60).join(""),
    content: item.content,
    confidence: 1,
    state: item.lifecycleState,
    pinned: false,
    version: item.version,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
    atomic: {
      itemId: item.itemId,
      kind: item.kind,
      scopeType: item.scopeType,
      scopeKey: item.scopeKey,
      statementType: item.statementType,
      temporalType: item.temporalType,
      observedAt: item.observedAt,
      eventStartedAt: item.eventStartedAt,
      eventEndedAt: item.eventEndedAt,
      origin: item.origin,
    },
    ...(source
      ? {
          sourceId: source.eventId,
          source: {
            sourceId: source.eventId,
            sessionId: source.sessionId,
            availability: "available" as const,
            createdAt: new Date(item.createdAt).toISOString(),
            updatedAt: new Date(item.updatedAt).toISOString(),
          },
        }
      : {}),
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

function legacyKind(kind: MemoryItemWrite["kind"]): RuntimeMemoryKind {
  return kind === "preference"
    ? "preference"
    : kind === "failure"
      ? "correction"
      : kind === "context" || kind === "identity"
        ? "project_fact"
        : "reference";
}
function atomicKind(kind: RuntimeMemoryKind): MemoryItemWrite["kind"] {
  return kind === "preference"
    ? "preference"
    : kind === "correction"
      ? "failure"
      : kind === "project_fact"
        ? "context"
        : "knowledge";
}
function operationKey(workspaceKey: string, value: string): string {
  return `desktop:${createHash("sha256")
    .update(JSON.stringify([workspaceKey, value]))
    .digest("hex")}`;
}
function invalid(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}
function settingsResult(
  value: AtomicMemorySettings,
  now: number,
): RuntimeResult<"memory.settings.get"> {
  const settings: RuntimeMemorySettings = {
    enabled: value.enabled,
    autoPropose: value.autoExtract,
    autoCommit: true,
    injectionEnabled: value.recallEnabled,
    reviewMode: "balanced",
    version: value.version,
    updatedAt: new Date(now).toISOString(),
  };
  return {
    settings,
    reviewBudget: {
      mode: "balanced",
      allowed: true,
      reason: "available",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      maxCalls: 3,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    },
  };
}
