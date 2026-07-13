// Session 持久化:事件溯源 JSONL。
//
// 对标 kimi-code packages/agent-core/src/agent/records/persistence.ts
// (FileSystemAgentRecordPersistence),但极简化:
//   - 无 write-behind 批处理(pico 单进程,append 直接落盘够用)
//   - 生产提交使用 O_APPEND FileHandle + fdatasync，末行撕裂仅作崩溃兜底
//   - 无 blob 内容寻址分离(工具产物由 artifact-store.ts 外部化,不进 session)
//
// 设计要点(对标 kimi-code wire.jsonl):
//   1. 事件追加:每条消息/截断是一行 JSON record,type 判别联合。
//   2. 末行撕裂容忍:load 时最后一行 JSON.parse 失败就停,不报错 ——
//      崩溃时 append 写一半是正常的(kimi-code transcript.ts:333 同款处理)。
//   3. truncate 折叠:重放遇到 truncate record,丢弃 fromIndex 之前的 message。
//   4. seq 单调递增:保证重放顺序,并防重复(幂等)。

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Message } from "../schema/message.js";
import { logger } from "../observability/logger.js";
import { OwnerLease } from "../storage/owner-lease.js";
import type { SessionIdentity } from "./session-identity.js";
import {
  normalizeSessionRuntimeStatePatch,
  SESSION_RUNTIME_STATE_VERSION,
  type SessionRuntimeStatePatch,
} from "./session-runtime.js";

/**
 * 当前 JSONL schema 版本号。
 *
 * meta 行({"type":"meta","schemaVersion":N})写在每个文件首行,
 * 作为头标记携带版本信息。旧文件(无 meta 行)视为 version 0。
 * 未来结构变更时 bump 此常量,并在 migrate() 加对应 case 分支。
 *
 * v0→v1:无结构变化(仅引入 meta 头与版本号机制本身),migrate 原样返回。
 * v1→v2:meta 头新增 session identity 字段,历史事件结构不变。
 * runtime_state 是可选的自版本记录，不改变旧事件语义，因此不 bump meta 版本。
 */
const CURRENT_SCHEMA_VERSION = 2;

export type SessionMetadata = {
  readonly schemaVersion: number;
} & Partial<SessionIdentity>;

export type SessionMetadataInput = Omit<SessionMetadata, "schemaVersion"> & {
  readonly schemaVersion?: number;
};

/** v3 会话身份与派生关系；仅描述事实，不引入运行时句柄。 */
export interface SessionLineage {
  readonly relation: "root" | "fork" | "spawn" | "salvage";
  readonly rootLogId: string;
  readonly parent?: SessionCursor;
  readonly parentTaskId?: string;
}

export interface SessionCursor {
  readonly logId: string;
  readonly seq: number;
  readonly epoch: number;
  readonly eventId: string;
}

export interface SessionMetaV3 {
  readonly type: "meta";
  readonly schemaVersion: 3;
  readonly logId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly identity: SessionIdentity;
  readonly lineage: SessionLineage;
}

export interface CommitReceipt {
  readonly eventId: string;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
  readonly durable: true;
}

interface SessionEventBase {
  readonly type: "event";
  readonly recordVersion: 1;
  readonly eventId: string;
  readonly seq: number;
  readonly epoch: number;
  readonly at: string;
}

export type SessionEvent =
  | (SessionEventBase & {
      readonly kind: "message.appended";
      readonly data: { readonly message: Message; readonly volatile?: boolean };
    })
  | (SessionEventBase & {
      readonly kind: "history.truncated";
      readonly data: { readonly fromIndex: number };
    })
  | (SessionEventBase & {
      readonly kind: "history.rewound";
      readonly data: { readonly messageIndex: number };
    })
  | (SessionEventBase & {
      readonly kind: "history.compacted";
      readonly data: {
        readonly summaryMessage: Message;
        readonly retainedMessages: readonly Message[];
      };
    })
  | (SessionEventBase & {
      /** 只供 v0-v2 adapter 使用；v3 writer 不得生成该事件。 */
      readonly kind: "legacy.undo";
      readonly data: { readonly count: number };
    })
  | (SessionEventBase & {
      readonly kind: "runtime.checkpoint";
      readonly data: {
        readonly stateVersion: typeof SESSION_RUNTIME_STATE_VERSION;
        readonly patch: SessionRuntimeStatePatch;
      };
    })
  | (SessionEventBase & {
      readonly kind: "session.seeded";
      readonly data: {
        readonly messages: readonly Message[];
        /** fork/spawn 来源的 durable cursor，用于重建 Catalog lineage。 */
        readonly lineage?: SessionLineage;
      };
    });

/** 持久化的事件记录:每行一个,带 type 判别联合。 */
/**
 * message record 的可选 `volatile` 字段(4.3 cursor 多端同步):
 *   - true:易失事件(如流式片段 text-delta),仅用于 WS 实时推送,
 *     不推进 cursor seq,重放时被丢弃(不重建进 history)。
 *   - false/缺省:持久事件,推进 seq,重放时进入 history。
 *   向后兼容:旧 JSONL 无此字段,load/recover 时按 false 处理(即全部当作持久)。
 */
export type LegacySessionRecord =
  | {
      readonly type: "message";
      readonly seq: number;
      readonly message: Message;
      readonly volatile?: boolean;
    }
  | { readonly type: "truncate"; readonly seq: number; readonly fromIndex: number }
  | { readonly type: "undo"; readonly seq: number; readonly count: number; readonly at: string }
  | {
      readonly type: "rewind_to";
      readonly seq: number;
      readonly messageIndex: number;
      readonly at: string;
    }
  | {
      readonly type: "runtime_state";
      readonly seq: number;
      readonly at: string;
      readonly stateVersion: typeof SESSION_RUNTIME_STATE_VERSION;
      readonly patch: SessionRuntimeStatePatch;
    };

export type SessionRecord =
  | LegacySessionRecord
  | SessionEvent
  | ({ readonly type: "meta" } & SessionMetadata)
  | SessionMetaV3;

/**
 * record 落盘监听器(4.3 cursor 多端同步)。
 *
 * SessionStore 在每条 record 追加后(无论 volatile 与否)向监听器广播
 * (record, seq, epoch)。WS 层订阅它,据此向连接的 client 推送事件流:
 *   - 持久事件(message with volatile!=true)/ truncate / undo / rewind_to /
 *     runtime_state 推进 seq
 *   - 易失事件(message with volatile===true)不推进 seq
 *   - epoch 用于 fork/rewind 后让旧 cursor 的 client 感知"世代已变"
 *
 * 监听器同步触发(appendLine 之后),保证 seq 单调与推送顺序一致。
 */
export type SessionRecordListener = (record: SessionRecord, seq: number, epoch: number) => void;

export class SessionJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionJournalIntegrityError";
  }
}

export class SessionWriteUncertainError extends Error {
  constructor(
    message: string,
    readonly uncertainCause?: unknown,
  ) {
    super(message);
    this.name = "SessionWriteUncertainError";
  }
}

interface DurableWriter {
  readonly file: FileHandle;
  readonly lease: OwnerLease;
  readonly logId: string;
  readonly eventIds: Set<string>;
  refs: number;
  headSeq: number;
  headEventId: string;
  epoch: number;
  tail: Promise<void>;
  state: "open" | "write_uncertain" | "closed";
}

export interface SessionJournalSnapshot {
  readonly records: Array<LegacySessionRecord | SessionEvent>;
  readonly metadata?: SessionMetadata | SessionMetaV3;
}

export interface CommitEventOptions {
  readonly eventId?: string;
  readonly expectedSeq?: number;
}

export interface SessionStoreDurabilityHooks {
  /** 仅用于故障注入集成测试；位于 write 之后、fdatasync 之前。 */
  readonly beforeDatasync?: () => void | Promise<void>;
}

/**
 * 单个 Session 的 JSONL 事件日志读写器。
 * 文件路径由调用方决定(通常是 workDir/.claw/sessions/<id>.jsonl)。
 */
export class SessionStore {
  private static readonly writers = new Map<string, Promise<DurableWriter>>();

  /**
   * epoch(4.3 cursor 多端同步):fork/rewind 时 bumpEpoch() 递增。
   * 同 sessionId 在 fork/rewind 后世代不同,旧 cursor 的 client 据此感知
   * 历史已被改写,需重新拉全量而非增量。纯私有字段,不影响 Session 类语义。
   */
  private epoch = 0;
  private logId: string;
  /** record 落盘监听器集合(WS 层订阅) */
  private readonly listeners = new Set<SessionRecordListener>();
  /** 实例按需引用进程级 durable writer pool。 */
  private writer?: DurableWriter;
  private writerPromise?: Promise<DurableWriter>;
  private released = false;

  constructor(
    private readonly filePath: string,
    private readonly metadata?: SessionMetadataInput,
    private readonly durabilityHooks?: SessionStoreDurabilityHooks,
  ) {
    this.logId = metadata?.sessionId ?? basename(filePath, ".jsonl");
  }

  /** 递增 epoch(fork/rewind 时调用)。纯游标概念,不改写已落盘的 JSONL。 */
  bumpEpoch(): void {
    this.epoch++;
  }

  /** 读取当前 epoch(WS 层连接握手时回传给 client)。 */
  getEpoch(): number {
    return this.epoch;
  }

  getLogId(): string {
    return this.logId;
  }

  getHeadCursor(): SessionCursor | undefined {
    const writer = this.writer;
    if (!writer || writer.headSeq < 0) return undefined;
    return {
      logId: writer.logId,
      seq: writer.headSeq,
      epoch: writer.epoch,
      eventId: writer.headEventId,
    };
  }

  get state(): "open" | "write_uncertain" | "closed" {
    if (this.released) return "closed";
    return this.writer?.state ?? "open";
  }

  /** 订阅 record 落盘事件。返回取消订阅函数。 */
  onRecord(listener: SessionRecordListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 向所有监听器广播(record, seq, epoch)。appendLine 成功后同步调用。 */
  private emit(record: SessionRecord, seq: number): void {
    for (const listener of this.listeners) {
      try {
        listener(record, seq, this.epoch);
      } catch (err) {
        // 监听器异常不应影响落盘主流程
        logger.warn({ err: String(err) }, "[session] record 监听器抛错,已忽略");
      }
    }
  }

  /**
   * 取得每日志唯一 writer lease。同进程的 SessionStore 共享一个
   * O_APPEND FileHandle，跨进程由 OwnerLease 仲裁。
   */
  async openWriter(): Promise<void> {
    await this.acquireWriter();
  }

  /** v3 生产接口：JSONL fdatasync 完成后才返回 durable receipt。 */
  async commitMessage(
    message: Message,
    options?: CommitEventOptions & { readonly volatile?: boolean },
  ): Promise<CommitReceipt> {
    return this.commitEvent(
      "message.appended",
      {
        message: structuredClone(message),
        ...(options?.volatile === true ? { volatile: true } : {}),
      },
      options,
    );
  }

  async commitTruncate(fromIndex: number, options?: CommitEventOptions): Promise<CommitReceipt> {
    return this.commitEvent("history.truncated", { fromIndex }, options);
  }

  async commitRewind(messageIndex: number, options?: CommitEventOptions): Promise<CommitReceipt> {
    return this.commitEvent("history.rewound", { messageIndex }, options);
  }

  async commitCompaction(
    summaryMessage: Message,
    retainedMessages: readonly Message[],
    options?: CommitEventOptions,
  ): Promise<CommitReceipt> {
    return this.commitEvent(
      "history.compacted",
      {
        summaryMessage: structuredClone(summaryMessage),
        retainedMessages: structuredClone(retainedMessages),
      },
      options,
    );
  }

  async commitRuntimeState(
    patch: SessionRuntimeStatePatch,
    options?: CommitEventOptions,
  ): Promise<CommitReceipt> {
    return this.commitEvent(
      "runtime.checkpoint",
      {
        stateVersion: SESSION_RUNTIME_STATE_VERSION,
        patch: structuredClone(patch),
      },
      options,
    );
  }

  async commitSeed(
    messages: readonly Message[],
    lineage: SessionLineage,
    options?: CommitEventOptions,
  ): Promise<CommitReceipt> {
    return this.commitEvent(
      "session.seeded",
      {
        messages: structuredClone(messages),
        lineage: structuredClone(lineage),
      },
      options,
    );
  }

  /** v0-v2 兼容 writer；生产 Session 不再调用这些方法。 */
  async appendMessage(seq: number, message: Message, volatile?: boolean): Promise<void> {
    const record: SessionRecord = {
      type: "message",
      seq,
      message,
      ...(volatile ? { volatile: true } : {}),
    };
    await this.appendLegacyRecord(record);
  }

  /** 追加一条 truncate 事件(fromIndex 之前的 message 在重放时被丢弃)。 */
  async appendTruncate(seq: number, fromIndex: number): Promise<void> {
    const record: SessionRecord = { type: "truncate", seq, fromIndex };
    await this.appendLegacyRecord(record);
  }

  async appendUndoEvent(seq: number, count: number): Promise<void> {
    const record: SessionRecord = { type: "undo", seq, count, at: new Date().toISOString() };
    await this.appendLegacyRecord(record);
  }

  async appendRewindTo(seq: number, messageIndex: number): Promise<void> {
    const record: SessionRecord = {
      type: "rewind_to",
      seq,
      messageIndex,
      at: new Date().toISOString(),
    };
    await this.appendLegacyRecord(record);
  }

  /** 追加一个会话运行态 section 快照，与消息共用同一 seq 序列。 */
  async appendRuntimeState(seq: number, patch: SessionRuntimeStatePatch): Promise<void> {
    const record: SessionRecord = {
      type: "runtime_state",
      seq,
      at: new Date().toISOString(),
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      patch: structuredClone(patch),
    };
    await this.appendLegacyRecord(record);
  }

  /**
   * 读取全部记录。逐行解析,容忍末行撕裂(最后一行 JSON.parse 失败则跳过)。
   * 中间行损坏改为"跳过该行继续解析"并 warn,保住其余有效记录(M2 修复);
   * 旧实现直接抛错会导致 recover 全量丢弃,前 N 条有效记录一并丢失。
   *
   * 返回结果按 seq 升序排序:append 是 fire-and-forget,不保证落盘顺序,
   * 但 seq 单调递增(调用方分配),重放必须按 seq 才能还原正确的历史顺序。
   * 这是 kimi-code/opencode 都遵循的不变量 —— seq 的存在意义就是解耦
   * "写入顺序"与"逻辑顺序"。
   */
  async load(): Promise<SessionRecord[]> {
    return (await this.readJournal(false)).records;
  }

  /** 生产恢复使用：拒绝中间损坏、seq 缺口/重复和 eventId 冲突。 */
  async loadStrict(): Promise<SessionRecord[]> {
    return (await this.readJournal(true)).records;
  }

  /**
   * 供 Catalog / Doctor 等可重建投影使用的日志快照。
   * 它只读 JSONL 真源，不获取 writer lease，也不会创建新日志。
   */
  async inspectJournal(options: { strict?: boolean } = {}): Promise<SessionJournalSnapshot> {
    const snapshot = await this.readJournal(options.strict === true);
    return {
      records: structuredClone(snapshot.records),
      ...(snapshot.metadata ? { metadata: structuredClone(snapshot.metadata) } : {}),
    };
  }

  async loadMetadata(): Promise<SessionMetadata | undefined> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch {
      return undefined;
    }

    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: SessionRecord;
      try {
        parsed = JSON.parse(line) as SessionRecord;
      } catch {
        if (i === lines.length - 1) break;
        continue;
      }
      if (parsed.type === "meta") {
        if ("identity" in parsed) {
          return { schemaVersion: parsed.schemaVersion, ...parsed.identity };
        }
        const { type: _type, ...metadata } = parsed;
        return metadata;
      }
    }

    return undefined;
  }

  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const writer = await this.writerPromise?.catch(() => undefined);
    if (!writer) return;
    await writer.tail.catch(() => undefined);
    writer.refs--;
    if (writer.refs > 0) return;
    writer.state = "closed";
    SessionStore.writers.delete(this.filePath);
    await writer.file.close().catch(() => undefined);
    await writer.lease.release().catch(() => undefined);
  }

  private async commitEvent<K extends SessionEvent["kind"]>(
    kind: K,
    data: Extract<SessionEvent, { readonly kind: K }>["data"],
    options?: CommitEventOptions,
  ): Promise<CommitReceipt> {
    const writer = await this.acquireWriter();
    const seq = options?.expectedSeq ?? writer.headSeq + 1;
    const eventId = options?.eventId ?? randomUUID();
    const event = {
      type: "event",
      recordVersion: 1,
      eventId,
      seq,
      epoch: this.epoch,
      at: new Date().toISOString(),
      kind,
      data,
    } as Extract<SessionEvent, { readonly kind: K }>;
    await this.appendDurable(writer, event);
    const committedAt = new Date().toISOString();
    return {
      eventId,
      cursor: { logId: writer.logId, seq, epoch: event.epoch, eventId },
      committedAt,
      durable: true,
    };
  }

  private async appendLegacyRecord(record: LegacySessionRecord): Promise<void> {
    const writer = await this.acquireWriter();
    // v0-v2 公开接口历史上允许首条 seq 从 1 或其他基线开始。
    if (writer.headSeq < 0 && writer.eventIds.size === 0) writer.headSeq = record.seq - 1;
    writer.epoch = Math.max(writer.epoch, this.epoch);
    await this.appendDurable(writer, record);
  }

  private async appendDurable(writer: DurableWriter, record: LegacySessionRecord | SessionEvent) {
    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const run = writer.tail.then(async () => {
      if (writer.state !== "open") {
        throw new SessionWriteUncertainError("Session journal is not writable");
      }
      const expectedSeq = writer.headSeq + 1;
      if (record.seq !== expectedSeq) {
        throw new SessionJournalIntegrityError(
          `Session seq conflict: received ${record.seq}, expected ${expectedSeq}`,
        );
      }
      const eventId = recordEventId(record);
      if (writer.eventIds.has(eventId)) {
        throw new SessionJournalIntegrityError(`Duplicate session eventId: ${eventId}`);
      }
      if (record.type === "event" && record.epoch < writer.epoch) {
        throw new SessionJournalIntegrityError(
          `Session epoch regressed: received ${record.epoch}, current ${writer.epoch}`,
        );
      }
      await writer.lease.assertOwnership();
      await writer.file.write(`${JSON.stringify(record)}\n`);
      await this.durabilityHooks?.beforeDatasync?.();
      await writer.file.datasync();
      writer.headSeq = record.seq;
      writer.headEventId = eventId;
      writer.eventIds.add(eventId);
      writer.epoch = effectiveEpoch(record, writer.epoch);
      this.epoch = writer.epoch;
      this.emit(record, record.seq);
    });
    writer.tail = run.then(resolveOperation, (error: unknown) => {
      writer.state = "write_uncertain";
      rejectOperation(new SessionWriteUncertainError("Session durable append failed", error));
    });
    await operation;
  }

  private async acquireWriter(): Promise<DurableWriter> {
    if (this.released) throw new SessionWriteUncertainError("Session store is closed");
    if (this.writer) {
      if (this.writer.state !== "open") {
        throw new SessionWriteUncertainError("Session journal is write_uncertain");
      }
      return this.writer;
    }
    this.writerPromise ??= this.acquirePooledWriter();
    const writer = await this.writerPromise;
    this.writer = writer;
    this.logId = writer.logId;
    this.epoch = Math.max(this.epoch, writer.epoch);
    return writer;
  }

  private async acquirePooledWriter(): Promise<DurableWriter> {
    const pooled = SessionStore.writers.get(this.filePath);
    if (pooled) {
      const writer = await pooled;
      writer.refs++;
      return writer;
    }
    const opening = this.createWriter();
    SessionStore.writers.set(this.filePath, opening);
    try {
      return await opening;
    } catch (error) {
      SessionStore.writers.delete(this.filePath);
      throw error;
    }
  }

  private async createWriter(): Promise<DurableWriter> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lease = await OwnerLease.acquire({
      leaseDirectory: join(dirname(this.filePath), ".leases", basename(this.filePath)),
      ownerId: `session:${this.metadata?.sessionId ?? basename(this.filePath)}`,
    });
    let file: FileHandle | undefined;
    try {
      file = await open(
        this.filePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
        0o600,
      );
      await chmod(this.filePath, 0o600);
      const existing = await stat(this.filePath);
      if (existing.size === 0) {
        const metadata = this.createMetadata();
        await file.write(`${JSON.stringify(metadata)}\n`);
        await file.datasync();
      }
      const journal = await this.readJournal(true);
      const head = journal.records.at(-1);
      const eventIds = new Set(journal.records.map(recordEventId));
      const epoch = journal.records.reduce((current, record) => effectiveEpoch(record, current), 0);
      const meta = journal.metadata;
      const logId = meta && "logId" in meta ? meta.logId : this.logId;
      return {
        file,
        lease,
        logId,
        eventIds,
        refs: 1,
        headSeq: head?.seq ?? -1,
        headEventId: head ? recordEventId(head) : "",
        epoch,
        tail: Promise.resolve(),
        state: "open",
      };
    } catch (error) {
      await file?.close().catch(() => undefined);
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  private createMetadata(): Extract<SessionRecord, { readonly type: "meta" }> {
    if (!this.metadata?.sessionId || this.metadata.schemaVersion !== undefined) {
      const { schemaVersion: _ignored, ...identity } = this.metadata ?? {};
      return { type: "meta", schemaVersion: CURRENT_SCHEMA_VERSION, ...identity };
    }
    const identity = this.metadata as SessionIdentity;
    const logId = randomUUID();
    this.logId = logId;
    return {
      type: "meta",
      schemaVersion: 3,
      logId,
      sessionId: identity.sessionId,
      createdAt: new Date().toISOString(),
      identity,
      lineage: { relation: "root", rootLogId: logId },
    };
  }

  private async readJournal(strict: boolean): Promise<SessionJournalSnapshot> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return { records: [] };
      throw error;
    }
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const records: Array<LegacySessionRecord | SessionEvent> = [];
    let metadata: SessionMetadata | SessionMetaV3 | undefined;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      let parsed: SessionRecord;
      try {
        const candidate: unknown = JSON.parse(line);
        if (isRuntimeStateCandidate(candidate)) {
          const runtimeRecord = normalizeRuntimeStateRecord(candidate);
          if (!runtimeRecord) throw new Error("invalid runtime_state");
          parsed = runtimeRecord;
        } else {
          parsed = candidate as SessionRecord;
        }
      } catch (error) {
        if (index === lines.length - 1) break;
        if (strict) {
          throw new SessionJournalIntegrityError(
            `Session journal line ${index + 1} is corrupt: ${String(error)}`,
          );
        }
        logger.warn({ line: index + 1 }, `[session] 第 ${index + 1} 行损坏,已跳过`);
        continue;
      }
      if (parsed.type === "meta") {
        metadata = parsed;
        if ("logId" in parsed) this.logId = parsed.logId;
        continue;
      }
      records.push(parsed as LegacySessionRecord | SessionEvent);
    }
    records.sort((left, right) => left.seq - right.seq);
    if (strict) validateRecordSequence(records);
    this.epoch = records.reduce((current, record) => effectiveEpoch(record, current), 0);
    return { records, ...(metadata ? { metadata } : {}) };
  }
}

function recordEventId(record: LegacySessionRecord | SessionEvent): string {
  return record.type === "event" ? record.eventId : `legacy:${record.seq}:${record.type}`;
}

function effectiveEpoch(record: LegacySessionRecord | SessionEvent, current: number): number {
  if (record.type === "event") return Math.max(current, record.epoch);
  return record.type === "truncate" || record.type === "undo" || record.type === "rewind_to"
    ? current + 1
    : current;
}

function validateRecordSequence(records: readonly (LegacySessionRecord | SessionEvent)[]): void {
  const eventIds = new Set<string>();
  let expectedSeq = records[0]?.seq ?? 0;
  let epoch = 0;
  for (const record of records) {
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) {
      throw new SessionJournalIntegrityError(`Invalid session seq: ${String(record.seq)}`);
    }
    if (record.seq !== expectedSeq) {
      throw new SessionJournalIntegrityError(
        `Session seq gap or conflict: received ${record.seq}, expected ${expectedSeq}`,
      );
    }
    const eventId = recordEventId(record);
    if (record.type === "event") {
      if (
        record.recordVersion !== 1 ||
        typeof record.eventId !== "string" ||
        record.eventId.length === 0 ||
        !Number.isSafeInteger(record.epoch) ||
        record.epoch < epoch ||
        record.epoch > epoch + 1 ||
        typeof record.at !== "string"
      ) {
        throw new SessionJournalIntegrityError(
          `Invalid canonical session event at seq ${record.seq}`,
        );
      }
      epoch = record.epoch;
    } else {
      epoch = effectiveEpoch(record, epoch);
    }
    if (eventIds.has(eventId)) {
      throw new SessionJournalIntegrityError(`Duplicate session eventId: ${eventId}`);
    }
    eventIds.add(eventId);
    expectedSeq++;
  }
}

function isRuntimeStateCandidate(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["type"] === "runtime_state"
  );
}

function normalizeRuntimeStateRecord(
  value: Record<string, unknown>,
): Extract<SessionRecord, { type: "runtime_state" }> | undefined {
  const seq = value["seq"];
  const at = value["at"];
  if (
    typeof seq !== "number" ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof at !== "string" ||
    value["stateVersion"] !== SESSION_RUNTIME_STATE_VERSION
  ) {
    return undefined;
  }
  const patch = normalizeSessionRuntimeStatePatch(value["patch"]);
  if (!patch) return undefined;
  return {
    type: "runtime_state",
    seq,
    at,
    stateVersion: SESSION_RUNTIME_STATE_VERSION,
    patch,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Schema 迁移(5.8a)。
 *
 * 将 records 从 fromVersion 升级到 CURRENT_SCHEMA_VERSION。
 * records 应是 load() 的结果(已剥离 meta 行)。
 *
 * 目前 v0→v1 无结构变化(仅引入 meta 头机制本身),原样返回。
 * 未来 schema 变更时在此加 case 分支,按序应用每个版本的转换。
 *
 * 设计为纯函数:不碰磁盘,不修改入参数组,返回(可能新的)records 数组。
 * 调用方负责持久化迁移结果(若需要)。
 */
export function migrate(records: SessionRecord[], fromVersion: number): SessionRecord[] {
  let current = fromVersion;
  const out = records;
  // 按版本号顺序应用每个迁移步骤,直到达到 CURRENT_SCHEMA_VERSION。
  while (current < CURRENT_SCHEMA_VERSION) {
    switch (current) {
      case 0:
        // v0→v1:结构未变(仅引入 meta 头),原样返回。
        break;
      case 1:
        // v1→v2:session identity 只存在于 meta 头,records 结构未变。
        break;
      default:
        // 未知中间版本:停止迁移,保住现有数据。
        logger.warn({ version: current }, `[session] migrate 遇到未知 schema 版本,停止迁移`);
        return out;
    }
    current++;
  }
  return out;
}

/**
 * 判断 records 数组(load 结果,含或不含 meta 行)的 schema 版本(5.8a)。
 *
 * - 若首条是 meta record,返回其 schemaVersion。
 * - 否则(旧文件,无 meta 头)视为 version 0。
 *
 * 注意:load() 返回的 records 已剥离 meta,这里同时兼容"未剥离"的原始读取。
 */
export function getSchemaVersion(records: SessionRecord[]): number {
  const first = records[0];
  if (first && first.type === "meta") {
    return first.schemaVersion;
  }
  return 0;
}
