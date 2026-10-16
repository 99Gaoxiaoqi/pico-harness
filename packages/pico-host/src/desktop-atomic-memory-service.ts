import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import {
  createExecutionLearningIO,
  executionLearningRecallTargets,
} from "./execution-learning-recall.js";
import type { MemoryItemRecord, MemoryItemWrite } from "@pico/core/atomic-memory-contracts";
import {
  MemoryItemStoreConflictError,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
} from "@pico/core/atomic-memory-contracts";
import type { AtomicMemorySettings } from "@pico/core/atomic-memory-runtime-contracts";
import { memorySessionKey } from "@pico/core/atomic-memory-runtime-contracts";
import type { TaskExperienceCandidate, TaskExperienceReuse } from "@pico/core";
import { executionLearningPathAuthorizer } from "./execution-learning-host.js";
import { projectExperienceDelivery } from "./experience-delivery-evidence.js";
import { taskExperienceRecallTargets } from "./task-experience-recall.js";
import { resolvePicoPaths } from "./pico-paths.js";
import {
  MemoryItemListCursorError,
  SqliteMemoryItemStore,
} from "@pico/storage/sqlite/sqlite-memory-item-store";
import type {
  RuntimeMemoryItem,
  RuntimeMemoryListItem,
  RuntimeMemoryConsolidationReceipt,
  RuntimeMemorySettings,
  RuntimeNotificationMap,
  RuntimeParams,
  RuntimeResult,
} from "@pico/protocol";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";

export interface DesktopAtomicMemoryServiceOptions {
  readonly picoHome: string;
  readonly now?: () => number;
  readonly publish: <Topic extends "memory.changed" | "memory.deleted" | "memory.learning.changed">(
    workspacePath: string,
    topic: Topic,
    payload: RuntimeNotificationMap[Topic],
  ) => void;
}

/** Desktop management surface backed directly by authoritative atomic Memory Items. */
export class DesktopAtomicMemoryService {
  private closed = false;
  constructor(private readonly options: DesktopAtomicMemoryServiceOptions) {}
  async queryExperienceUses(
    workspacePath: string,
    params: RuntimeParams<"memory.experience.query">,
  ): Promise<RuntimeResult<"memory.experience.query">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const page = await store.experienceLedger.queryExperienceUses(workspaceKey, {
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.itemId ? { itemId: params.itemId } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
        limit: params.limit ?? 50,
      });
      return {
        experienceVersion: 1,
        ...(params.learningVersion === 3 ? { learningVersion: 3 as const } : {}),
        diagnostics: await store.experienceLedger.listExperienceDiagnostics(
          workspaceKey,
          params.sessionId,
        ),
        ...page,
        uses: page.uses.map((use) =>
          projectExperienceDelivery(use, {
            workDir: workspacePath,
            picoHome: this.options.picoHome,
          }),
        ),
      };
    });
  }
  async detailExperienceUse(
    workspacePath: string,
    useId: string,
    learningVersion?: 2 | 3,
  ): Promise<RuntimeResult<"memory.experience.detail">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const use = await store.experienceLedger.readExperienceUse(useId);
      if (!use || use.workspaceKey !== workspaceKey)
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有该经验引用");
      return {
        experienceVersion: 1,
        ...(learningVersion === 3 ? { learningVersion: 3 as const } : {}),
        use: projectExperienceDelivery(use, {
          workDir: workspacePath,
          picoHome: this.options.picoHome,
        }),
        effects: await store.experienceLedger.listExperienceEffects(useId),
      };
    });
  }
  async feedbackExperienceUse(
    workspacePath: string,
    params: RuntimeParams<"memory.experience.feedback">,
  ): Promise<RuntimeResult<"memory.experience.feedback">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const use = await store.experienceLedger.feedbackExperienceUse({
        workspaceKey,
        useId: params.useId,
        expectedItemVersion: params.expectedItemVersion,
        operationId: params.operationId,
        action: params.action,
        ...(params.expectedContentVersion !== undefined
          ? { expectedContentVersion: params.expectedContentVersion }
          : {}),
        now: this.now(),
      });
      if (params.action === "disable" || params.action === "correct") {
        const currentItem = await store.readItem(use.itemId);
        if (currentItem) this.changed(workspacePath, currentItem);
      }
      this.learningChanged(workspacePath, workspaceKey, store);
      return {
        experienceVersion: 1,
        ...(params.learningVersion === 3 ? { learningVersion: 3 as const } : {}),
        use: projectExperienceDelivery(use, {
          workDir: workspacePath,
          picoHome: this.options.picoHome,
        }),
      };
    });
  }
  async queryExperiences(
    workspacePath: string,
    params: RuntimeParams<"memory.learning.query">,
  ): Promise<RuntimeResult<"memory.learning.query">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const reuse = await this.projectLegacyExperienceReuse(
        workspacePath,
        store,
        (await store.taskExperiences.listTaskExperienceReuse(workspaceKey, params.sessionId)).slice(
          0,
          100,
        ),
      );
      const items = new Map(
        (
          await store.taskExperiences.queryTaskExperiences(workspaceKey, {
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            ...(params.review ? { review: params.review } : {}),
            ...(params.learningVersion === 3
              ? {
                  ...(params.representation ? { representation: params.representation } : {}),
                  ...(params.usagePolicy ? { usagePolicy: params.usagePolicy } : {}),
                  ...(params.lifecycleState ? { lifecycleState: params.lifecycleState } : {}),
                  ...(params.query ? { query: params.query } : {}),
                }
              : { representation: "method" as const }),
            limit: Math.min(params.limit ?? 100, 100),
          })
        ).map((item) => [item.candidateId, item]),
      );
      if (
        params.sessionId &&
        !params.review &&
        !params.representation &&
        !params.usagePolicy &&
        !params.lifecycleState &&
        !params.query
      )
        for (const receipt of reuse) {
          if (items.has(receipt.candidateId)) continue;
          const candidate = await store.taskExperiences.readTaskExperienceCandidate(
            receipt.candidateId,
          );
          if (
            candidate?.workspaceKey === workspaceKey &&
            candidate.state !== "discarded" &&
            (params.learningVersion === 3 || candidate.representation !== "case")
          )
            items.set(candidate.candidateId, candidate);
        }
      return {
        learningVersion: params.learningVersion === 3 ? 3 : 2,
        workspaceKey,
        revision: store.executionLearning.readRevision(),
        items: [...items.values()].map((item) =>
          publicExperienceCandidate(item, params.learningVersion),
        ),
        reuse,
        ...(params.learningVersion === 3 && params.sessionId
          ? {
              receipts: (
                await ((await store.taskExperiences.latestTaskExperienceTask(
                  workspaceKey,
                  params.sessionId,
                ))
                  ? store.listExtractionReceipts(
                      memorySessionKey(workspaceKey, params.sessionId),
                      100,
                    )
                  : Promise.resolve([]))
              )
                .filter((receipt) => receipt.summary !== undefined)
                .map((receipt) => ({
                  operationId: receipt.operationId,
                  sessionId: params.sessionId!,
                  committedAt: receipt.committedAt,
                  createdItemCount: receipt.summary!.createdItemCount,
                })),
            }
          : {}),
      };
    });
  }
  async detailExperience(
    workspacePath: string,
    candidateId: string,
    learningVersion?: 2 | 3,
  ): Promise<RuntimeResult<"memory.learning.detail">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const candidate = await store.taskExperiences.readTaskExperienceCandidate(candidateId);
      if (
        !candidate ||
        candidate.workspaceKey !== workspaceKey ||
        (learningVersion !== 3 && candidate.representation === "case")
      )
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有该经验");
      const observations = await store.taskExperiences.listTaskExperienceObservations(
        candidate.taskId,
      );
      const reuse = await this.projectLegacyExperienceReuse(
        workspacePath,
        store,
        (await store.taskExperiences.listTaskExperienceReuse(workspaceKey))
          .filter((r) => r.candidateId === candidateId)
          .slice(0, 100),
      );
      return {
        learningVersion: learningVersion === 3 ? 3 : 2,
        candidate: publicExperienceCandidate(candidate, learningVersion),
        observations: observations.filter((o) =>
          candidate.observationIds.includes(o.observationId),
        ),
        reuse,
      };
    });
  }
  async reviewExperience(
    workspacePath: string,
    params: RuntimeParams<"memory.learning.review">,
  ): Promise<RuntimeResult<"memory.learning.review">> {
    if (
      !["edit_accept", "revise"].includes(params.action) &&
      (params.content !== undefined ||
        params.applicability !== undefined ||
        params.representation !== undefined ||
        params.matchHints !== undefined ||
        params.requiredConditions !== undefined)
    )
      throw invalid("只有更正并确认可以修改建议内容");
    if (["edit_accept", "revise"].includes(params.action) && params.content === undefined)
      throw invalid("更正需要建议内容");
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const candidate = await store.taskExperiences.reviewTaskExperience({
        workspaceKey,
        candidateId: params.candidateId,
        expectedRecordRevision: params.expectedRecordRevision,
        expectedContentVersion: params.expectedContentVersion,
        operationId: params.operationId,
        action: params.action,
        ...(params.content !== undefined ? { content: safeContent(params.content) } : {}),
        ...(params.applicability ? { applicability: params.applicability } : {}),
        ...(params.representation ? { representation: params.representation } : {}),
        ...(params.matchHints ? { matchHints: params.matchHints } : {}),
        ...(params.requiredConditions ? { requiredConditions: params.requiredConditions } : {}),
        now: this.now(),
      });
      this.learningChanged(workspacePath, workspaceKey, store);
      return {
        learningVersion: params.learningVersion === 3 ? 3 : 2,
        candidate: publicExperienceCandidate(candidate, params.learningVersion),
      };
    });
  }
  async feedbackExperience(
    workspacePath: string,
    params: RuntimeParams<"memory.learning.feedback">,
  ): Promise<RuntimeResult<"memory.learning.feedback">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      if (params.source) {
        const observations = await store.taskExperiences.listTaskExperienceObservations(
          params.taskId,
        );
        if (
          !observations.some(
            (observation) =>
              observation.kind === "user-input" &&
              observation.taskVersion === params.taskVersion &&
              JSON.stringify(observation.source) === JSON.stringify(params.source),
          )
        )
          throw invalid("纠正来源不属于该任务的用户输入");
      }
      const candidate = await store.taskExperiences.feedbackTaskExperience({
        workspaceKey,
        candidateId: params.candidateId,
        expectedContentVersion: params.expectedContentVersion,
        operationId: params.operationId,
        taskId: params.taskId,
        taskVersion: params.taskVersion,
        action: params.action,
        ...(params.source ? { source: params.source } : {}),
        now: this.now(),
      });
      this.learningChanged(workspacePath, workspaceKey, store);
      return {
        learningVersion: params.learningVersion === 3 ? 3 : 2,
        candidate: publicExperienceCandidate(candidate, params.learningVersion),
      };
    });
  }
  private learningChanged(
    workspacePath: string,
    workspaceKey: string,
    store: SqliteMemoryItemStore,
  ): void {
    this.publish(() =>
      this.options.publish(workspacePath, "memory.learning.changed", {
        workspaceKey,
        revision: store.executionLearning.readRevision(),
      }),
    );
  }
  async listLearning(
    workspacePath: string,
    sessionId?: string,
  ): Promise<RuntimeResult<"memory.learning.list">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => ({
      workspaceKey,
      revision: store.executionLearning.readRevision(),
      // The old RPC is a read-only historical projection, not a second proposal queue.
      items: (await store.executionLearning.listExecutionLearning(workspaceKey, sessionId)).filter(
        (candidate) => candidate.state === "saved" && candidate.itemId,
      ),
    }));
  }
  async inspectLearning(
    workspacePath: string,
    candidateId: string,
  ): Promise<RuntimeResult<"memory.learning.inspect">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      const candidate = await store.executionLearning.readExecutionLearningCandidate(candidateId);
      if (
        !candidate ||
        candidate.claim.admission.workspaceKey !== workspaceKey ||
        candidate.state !== "saved"
      )
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有该学习候选");
      const legacy = JSON.parse(JSON.stringify(candidate));
      delete legacy.claim.admission.modelRoute;
      delete legacy.hypothesis;
      return { candidate: legacy as import("@pico/protocol").JsonObject };
    });
  }
  async discardLearning(
    _workspacePath: string,
    _candidateId: string,
    _revision: number,
  ): Promise<RuntimeResult<"memory.learning.discard">> {
    throw invalid("独立原生学习已停用。建议请通过经验审核管理；已保存经验请在记忆页归档或删除。");
  }

  async list(
    workspacePath: string,
    params: RuntimeParams<"memory.list">,
  ): Promise<RuntimeResult<"memory.list">> {
    return this.withStore(workspacePath, async (store, workspaceKey) => {
      if (params.paged) {
        const page = await store.listItemsPage({
          workspaceKey,
          ...(params.learningVersion !== undefined ? { learningVersion: 2 as const } : {}),
          ...(params.lifecycleStates ? { lifecycleStates: params.lifecycleStates } : {}),
          ...(params.kinds ? { kinds: params.kinds } : {}),
          ...(params.cursor ? { cursor: params.cursor } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        });
        const items: RuntimeMemoryListItem[] = [];
        // Reserve 8 KiB for the RPC response envelope (including its bounded request ID).
        const resultBudget = 983_040 - 8_192;
        let nextCursor = page.pageInfo.nextCursor;
        let itemsBytes = 0;
        for (const record of page.items) {
          const candidate: RuntimeMemoryListItem = {
            ...record.item,
            sourceCount: record.sourceCount,
            ...(record.sourceType ? { sourceType: record.sourceType } : {}),
            ...(params.learningVersion !== undefined && record.taskExperience
              ? {
                  taskExperience: publicExperienceSummary(
                    record.taskExperience,
                    params.learningVersion,
                  ) as import("@pico/core").TaskExperienceSummary &
                    import("@pico/protocol").JsonObject,
                }
              : {}),
            ...(record.taskAcceptance ? { taskAcceptance: { ...record.taskAcceptance } } : {}),
            ...(record.executionEvidence
              ? { executionEvidence: { ...record.executionEvidence } }
              : {}),
            ...(record.firstSource ? { firstSource: { ...record.firstSource } } : {}),
          };
          const pageInfo = {
            ...page.pageInfo,
            nextCursor: page.cursors[items.length],
          };
          const candidateBytes =
            Buffer.byteLength(JSON.stringify(candidate), "utf8") + (items.length ? 1 : 0);
          const envelopeBytes = Buffer.byteLength(JSON.stringify({ items: [], pageInfo }), "utf8");
          if (itemsBytes + candidateBytes + envelopeBytes > resultBudget) {
            nextCursor = page.cursors[items.length - 1];
            break;
          }
          items.push(candidate);
          itemsBytes += candidateBytes;
        }
        const { nextCursor: _originalCursor, ...pageInfo } = page.pageInfo;
        return {
          ...(params.learningVersion !== undefined
            ? { learningVersion: params.learningVersion }
            : {}),
          items,
          pageInfo: { ...pageInfo, ...(nextCursor ? { nextCursor } : {}) },
        };
      }
      const records = await store.listItems({
        workspaceKey,
        includeArchived: true,
        limit: 1000,
        ...(params.learningVersion !== undefined ? { learningVersion: 2 as const } : {}),
      });
      return {
        ...(params.learningVersion !== undefined
          ? { learningVersion: params.learningVersion }
          : {}),
        items: records
          .map((record) => projectItem(record, params.learningVersion))
          .filter(
            (item) =>
              (!params.lifecycleStates || params.lifecycleStates.includes(item.lifecycleState)) &&
              (!params.kinds || params.kinds.includes(item.kind)),
          )
          .slice(0, params.limit ?? 100),
      };
    });
  }

  async get(
    workspacePath: string,
    itemId: string,
    learningVersion?: 2 | 3,
  ): Promise<RuntimeResult<"memory.get">> {
    return this.withStore(workspacePath, async (store, key) => {
      const record = await authorizedItem(store, key, itemId);
      if (record.sourceType === "reviewed-reference" && learningVersion === undefined)
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前视图没有该记忆");
      return {
        ...(learningVersion !== undefined ? { learningVersion } : {}),
        item: projectItem(record, learningVersion),
      };
    });
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
      if (current.sourceType === "reviewed-reference")
        throw invalid("请通过经验审核入口更正或归档这条经验");
      const editing = [
        params.content,
        params.kind,
        params.statementType,
        params.temporalType,
        params.eventStartedAt,
        params.eventEndedAt,
      ].some((value) => value !== undefined);
      if (editing && params.lifecycleState !== undefined)
        throw invalid("请分别保存内容和更改归档状态");
      if (!editing && params.lifecycleState === undefined) throw invalid("没有可更新的记忆字段");
      const operationId = operationKey(key, params.idempotencyKey);
      if (editing) {
        const content = safeContent(params.content ?? current.item.content);
        const item: MemoryItemWrite = {
          content,
          kind: params.kind ?? current.item.kind,
          statementType: params.statementType ?? current.item.statementType,
          temporalType: params.temporalType ?? current.item.temporalType,
          scopeType: current.item.scopeType,
          scopeKey: current.item.scopeKey,
          eventStartedAt:
            params.eventStartedAt === undefined
              ? current.item.eventStartedAt
              : params.eventStartedAt,
          eventEndedAt:
            params.eventEndedAt === undefined ? current.item.eventEndedAt : params.eventEndedAt,
          observedAt: current.item.observedAt,
          origin: "user_requested",
          keys: manualKeys(content),
          sources: [],
        };
        try {
          validateMemoryTemporalBounds({
            temporalType: item.temporalType,
            eventStartedAt: item.eventStartedAt ?? null,
            eventEndedAt: item.eventEndedAt ?? null,
          });
        } catch {
          throw invalid("记忆时间类型与起止时间不一致，请检查后重试");
        }
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
      const operationId = operationKey(key, params.idempotencyKey);
      if (!(await store.readOperation(operationId))) {
        let record: MemoryItemRecord | undefined;
        try {
          record = await authorizedItem(store, key, params.itemId);
        } catch (error) {
          // Another request may commit after the first receipt lookup but before
          // the Item lookup. Only its durable receipt can authorize a replay.
          if (
            !(error instanceof RuntimeProtocolError) ||
            error.code !== RUNTIME_ERROR_CODES.NOT_FOUND ||
            !(await store.readOperation(operationId))
          )
            throw error;
        }
        if (record?.sourceType === "reviewed-reference")
          throw invalid("审核经验请在经验管理中删除");
      }
      // A receipt's presence is not proof of a matching delete. The store checks
      // the operation type and Item/version hash in its deletion transaction.
      await store.deleteItem({
        itemId: params.itemId,
        expectedVersion: params.expectedVersion,
        operationId,
      });
      const version = params.expectedVersion + 1;
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
      const maxItems = Math.min(params.maxItems ?? 3, 3);
      const maxTokens = Math.min(params.maxTokens ?? 320, 320);
      const result = await new AtomicMemoryContextBuilder(store, key).build(params.query, {
        ...(params.learningVersion !== undefined
          ? {
              reviewedExperiences: await taskExperienceRecallTargets({
                store: store.taskExperiences,
                workspaceKey: key,
                workDir: workspacePath,
                ...(params.query ? { query: params.query } : {}),
                // The management preview has no foreground Registry. Tool-dependent
                // methods need that task's authorization and are omitted here.
                toolAllowed: () => false,
              }),
            }
          : {}),
        executionTargets: await executionLearningRecallTargets(
          store,
          key,
          createExecutionLearningIO(
            workspacePath,
            undefined,
            params.sessionId
              ? executionLearningPathAuthorizer(
                  workspacePath,
                  this.options.picoHome,
                  params.sessionId,
                )
              : async () => {
                  throw new Error("current_session_permission_required");
                },
          ),
          params.query,
        ),
        maxItems,
        maxTokens,
      });
      const items = result.items.map((record) => projectItem(record, params.learningVersion));
      return {
        ...(params.learningVersion !== undefined
          ? { learningVersion: params.learningVersion }
          : {}),
        items,
        block: result.block,
        references: result.references.map(({ applicability: _applicability, ...reference }) => ({
          ...reference,
          range: { ...reference.range },
        })),
        diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        budget: {
          maxItems,
          maxTokens,
          usedItems: items.length,
          usedTokens: result.tokenCount,
          truncated: result.truncated,
        },
      };
    });
  }

  async getMetrics(
    workspacePath: string,
    params: RuntimeParams<"memory.metrics.get">,
  ): Promise<RuntimeResult<"memory.metrics.get">> {
    const to = params.to ?? this.now();
    const from = params.from ?? Math.max(0, to - 7 * 86_400_000);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to)
      throw invalid("统计时间范围无效");
    return this.withStore(workspacePath, async (store) => {
      const metrics = await store.readExtractionMetrics({ from, to });
      return { metrics: { ...metrics, groups: metrics.groups.map((group) => ({ ...group })) } };
    });
  }

  async listConsolidationHistory(
    workspacePath: string,
  ): Promise<RuntimeResult<"memory.consolidation.history">> {
    return this.withStore(workspacePath, async (store) => {
      const receipts = await store.listMemoryConsolidationHistory({ now: this.now() });
      return {
        receipts: receipts.map(projectConsolidationReceipt),
      };
    });
  }

  async undoConsolidation(
    workspacePath: string,
    batchId: string,
  ): Promise<RuntimeResult<"memory.consolidation.undo">> {
    return this.withStore(workspacePath, async (store) => {
      const result = await store.undoMemoryConsolidation({ batchId, now: this.now() });
      if (result.status === "undone") {
        for (const item of result.receipt.items) {
          const current = await store.readItem(item.itemId);
          if (current) this.changed(workspacePath, current);
        }
      }
      if ("receipt" in result)
        return { ...result, receipt: projectConsolidationReceipt(result.receipt) };
      return result;
    });
  }

  close(): void {
    this.closed = true;
  }

  private async projectLegacyExperienceReuse(
    workspacePath: string,
    store: SqliteMemoryItemStore,
    reuse: readonly TaskExperienceReuse[],
  ): Promise<readonly TaskExperienceReuse[]> {
    const projected = await Promise.all(
      reuse.map(async (receipt) => {
        const use = await store.experienceLedger.readExperienceUse(receipt.reuseId);
        if (!use) return undefined;
        // The v2 shape cannot represent pending or unknown delivery. Keep genuine
        // historical receipts, and expose new references only with native proof.
        if (use.historical) return receipt;
        const current = projectExperienceDelivery(use, {
          workDir: workspacePath,
          picoHome: this.options.picoHome,
        });
        return current.delivery === "carried" ? receipt : undefined;
      }),
    );
    return projected.filter((receipt): receipt is TaskExperienceReuse => receipt !== undefined);
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
      if (error instanceof MemoryItemListCursorError) throw invalid(error.message);
      if (error instanceof MemoryItemStoreConflictError)
        throw new RuntimeProtocolError(
          error.reason === "item_not_found"
            ? RUNTIME_ERROR_CODES.NOT_FOUND
            : RUNTIME_ERROR_CODES.CONFLICT,
          "记忆不存在或版本已改变，请刷新后重试",
        );
      const failure = new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INTERNAL_ERROR,
        "记忆服务暂时不可用",
      );
      Object.defineProperty(failure, "cause", { value: error });
      throw failure;
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

function projectConsolidationReceipt(receipt: {
  readonly batchId: string;
  readonly status: "undoable" | "undone";
  readonly consideredCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly undoneAt?: number;
  readonly items: readonly {
    readonly itemId: string;
    readonly fromVersion: number;
    readonly archivedVersion: number;
    readonly reason: RuntimeMemoryConsolidationReceipt["items"][number]["reason"];
  }[];
}): RuntimeMemoryConsolidationReceipt {
  return {
    batchId: receipt.batchId,
    status: receipt.status,
    consideredCount: receipt.consideredCount,
    createdAt: receipt.createdAt,
    expiresAt: receipt.expiresAt,
    ...(receipt.undoneAt !== undefined ? { undoneAt: receipt.undoneAt } : {}),
    items: receipt.items.map((item) => ({
      itemId: item.itemId,
      fromVersion: item.fromVersion,
      archivedVersion: item.archivedVersion,
      reason: item.reason,
    })),
  };
}

async function authorizedItem(
  store: SqliteMemoryItemStore,
  key: string,
  itemId: string,
): Promise<MemoryItemRecord> {
  const record = await store.readItem(itemId);
  if (!record) {
    for (const scope of [
      ["workspace", key],
      ["global", null],
    ] as const) {
      const identity = createHash("sha256")
        .update(JSON.stringify([...scope, itemId]))
        .digest("hex");
      const retired = await store.readOperation(`retire-execution-lesson:v14:item:${identity}`);
      if (retired?.operationType === "delete")
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "旧版经验已移除");
    }
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有这条记忆");
  }
  if (record.item.scopeType === "workspace" && record.item.scopeKey !== key) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, "当前工作区没有这条记忆");
  }
  return record;
}

function projectItem(
  {
    item,
    sources,
    executionEvidence,
    sourceType,
    taskAcceptance,
    taskExperience,
  }: MemoryItemRecord,
  learningVersion?: 2 | 3,
): RuntimeMemoryItem {
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
    ...(executionEvidence ? { executionEvidence: { ...executionEvidence } } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(taskExperience
      ? {
          taskExperience: publicExperienceSummary(
            taskExperience,
            learningVersion,
          ) as import("@pico/core").TaskExperienceSummary & import("@pico/protocol").JsonObject,
        }
      : {}),
    ...(taskAcceptance ? { taskAcceptance: { ...taskAcceptance } } : {}),
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
const legacySummaryKeys = [
  "candidateId",
  "contentVersion",
  "recordRevision",
  "review",
  "validation",
  "enabled",
  "applicability",
  "maturity",
  "risk",
  "promotionReason",
  "positiveReuseCount",
  "reviewReason",
] as const;
const v3SummaryKeys = [
  "representation",
  "usagePolicy",
  "matchHints",
  "requiredConditions",
  "scopeUnresolved",
  "decisionKind",
  "expiresAt",
  "evidenceSummary",
] as const;
function publicExperienceSummary(
  candidate: import("@pico/core").TaskExperienceSummary,
  version?: 2 | 3,
): import("@pico/core").TaskExperienceSummary {
  const keys: readonly string[] = [...legacySummaryKeys, ...(version === 3 ? v3SummaryKeys : [])];
  return Object.fromEntries(
    keys
      .filter((key) => (candidate as unknown as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, (candidate as unknown as Record<string, unknown>)[key]]),
  ) as unknown as import("@pico/core").TaskExperienceSummary;
}
/** Whitelist every public field; internal policy attachments never leak into v2. */
function publicExperienceCandidate(
  candidate: TaskExperienceCandidate,
  version?: 2 | 3,
): TaskExperienceCandidate {
  const keys = [
    "kind",
    "lifecycleState",
    "taskId",
    "taskVersion",
    "workspaceKey",
    "workDir",
    "sessionId",
    "runId",
    "failureKey",
    "inputEpoch",
    "settingsVersion",
    "deletionRevision",
    "state",
    "goal",
    "content",
    "sources",
    "observationIds",
    "modelRoute",
    "itemId",
    "reason",
    "createdAt",
    "updatedAt",
  ];
  return {
    ...publicExperienceSummary(candidate, version),
    ...Object.fromEntries(
      keys
        .filter((key) => (candidate as unknown as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, (candidate as unknown as Record<string, unknown>)[key]]),
    ),
  } as TaskExperienceCandidate;
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
