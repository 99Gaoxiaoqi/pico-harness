// Session 持久化:事件溯源 JSONL。
//
// 对标 kimi-code packages/agent-core/src/agent/records/persistence.ts
// (FileSystemAgentRecordPersistence),但极简化:
//   - 无 write-behind 批处理(pico 单进程,append 直接落盘够用)
//   - 无 fsync/syncDir(OS page cache flush 足够;末行撕裂容忍兜底)
//   - 无 blob 内容寻址分离(工具产物由 artifact-store.ts 外部化,不进 session)
//
// 设计要点(对标 kimi-code wire.jsonl):
//   1. 事件追加:每条消息/截断是一行 JSON record,type 判别联合。
//   2. 末行撕裂容忍:load 时最后一行 JSON.parse 失败就停,不报错 ——
//      崩溃时 append 写一半是正常的(kimi-code transcript.ts:333 同款处理)。
//   3. truncate 折叠:重放遇到 truncate record,丢弃 fromIndex 之前的 message。
//   4. seq 单调递增:保证重放顺序,并防重复(幂等)。

import { appendFile, chmod, readFile, stat } from "node:fs/promises";
import type { Message } from "../schema/message.js";
import { logger } from "../observability/logger.js";
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
      readonly data: { readonly messages: readonly Message[] };
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

/**
 * 单个 Session 的 JSONL 事件日志读写器。
 * 文件路径由调用方决定(通常是 workDir/.claw/sessions/<id>.jsonl)。
 */
export class SessionStore {
  /**
   * epoch(4.3 cursor 多端同步):fork/rewind 时 bumpEpoch() 递增。
   * 同 sessionId 在 fork/rewind 后世代不同,旧 cursor 的 client 据此感知
   * 历史已被改写,需重新拉全量而非增量。纯私有字段,不影响 Session 类语义。
   */
  private epoch = 0;
  /** record 落盘监听器集合(WS 层订阅) */
  private readonly listeners = new Set<SessionRecordListener>();
  /**
   * 首次写入标志(5.8a schema 版本号)。
   * 第一次 appendLine 时先写 meta 头行,之后置 true。
   * 仅内存标志,不感知外部对文件的改动(每次新 SessionStore 实例默认未初始化)。
   */
  private initialized = false;
  private initPromise?: Promise<void>;

  constructor(
    private readonly filePath: string,
    private readonly metadata?: SessionMetadataInput,
  ) {}

  /** 递增 epoch(fork/rewind 时调用)。纯游标概念,不改写已落盘的 JSONL。 */
  bumpEpoch(): void {
    this.epoch++;
  }

  /** 读取当前 epoch(WS 层连接握手时回传给 client)。 */
  getEpoch(): number {
    return this.epoch;
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

  /** 追加一条 message 事件。失败由调用方 catch(fire-and-forget)。 */
  async appendMessage(seq: number, message: Message, volatile?: boolean): Promise<void> {
    const record: SessionRecord = {
      type: "message",
      seq,
      message,
      ...(volatile ? { volatile: true } : {}),
    };
    await this.appendLine(JSON.stringify(record));
    this.emit(record, seq);
  }

  /** 追加一条 truncate 事件(fromIndex 之前的 message 在重放时被丢弃)。 */
  async appendTruncate(seq: number, fromIndex: number): Promise<void> {
    const record: SessionRecord = { type: "truncate", seq, fromIndex };
    await this.appendLine(JSON.stringify(record));
    this.emit(record, seq);
  }

  async appendUndoEvent(seq: number, count: number): Promise<void> {
    const record: SessionRecord = { type: "undo", seq, count, at: new Date().toISOString() };
    await this.appendLine(JSON.stringify(record));
    this.emit(record, seq);
  }

  async appendRewindTo(seq: number, messageIndex: number): Promise<void> {
    const record: SessionRecord = {
      type: "rewind_to",
      seq,
      messageIndex,
      at: new Date().toISOString(),
    };
    await this.appendLine(JSON.stringify(record));
    this.emit(record, seq);
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
    await this.appendLine(JSON.stringify(record));
    this.emit(record, seq);
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
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch {
      return []; // 文件不存在(首次启动)视为空日志
    }

    const lines = content.split("\n");
    // 末尾空行(文件以 \n 结尾的正常情况)先剔掉
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const records: SessionRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parsed: SessionRecord;
      try {
        const candidate: unknown = JSON.parse(line);
        if (isRuntimeStateCandidate(candidate)) {
          const runtimeRecord = normalizeRuntimeStateRecord(candidate);
          if (!runtimeRecord) {
            logger.warn({ line: i + 1 }, `[session] 第 ${i + 1} 行 runtime_state 无效,已跳过`);
            continue;
          }
          parsed = runtimeRecord;
        } else {
          parsed = candidate as SessionRecord;
        }
      } catch (error) {
        if (i === lines.length - 1) {
          // 末行撕裂:append 写一半的典型表现,容忍跳过
          break;
        }
        // 中间行损坏:跳过该行继续解析(warn 不 throw),保住其余有效记录。
        // 旧实现 throw 会让 recover 全量丢弃,第 50 行损坏 → 前 49 条有效记录丢失(M2)。
        logger.warn({ line: i + 1 }, `[session] 第 ${i + 1} 行损坏,跳过: ${String(error)}`);
        continue;
      }
      // meta 头行(5.8a schema 版本号):不参与重放,跳过(版本信息由 getSchemaVersion 另读)。
      if (parsed.type === "meta") continue;
      records.push(parsed);
    }
    // 关键:按 seq 排序,消除 fire-and-forget 落盘乱序的影响。
    // meta 行已在上一步跳过,这里剩余元素都带 seq。
    records.sort((a, b) => ("seq" in a ? a.seq : -1) - ("seq" in b ? b.seq : -1));
    return records;
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
        const { type: _type, ...metadata } = parsed;
        return metadata;
      }
    }

    return undefined;
  }

  private async appendLine(line: string): Promise<void> {
    await this.ensureInitialized();
    await appendFile(this.filePath, line + "\n", "utf8");
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initPromise ??= this.writeMetadataOnce().catch((error: unknown) => {
      this.initPromise = undefined;
      throw error;
    });
    await this.initPromise;
  }

  private async writeMetadataOnce(): Promise<void> {
    try {
      const existing = await stat(this.filePath);
      if (existing.size > 0) {
        await chmod(this.filePath, 0o600);
        this.initialized = true;
        return;
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    const { schemaVersion: _ignored, ...identity } = this.metadata ?? {};
    const meta = JSON.stringify({
      type: "meta",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ...identity,
    });
    await appendFile(this.filePath, meta + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.filePath, 0o600);
    this.initialized = true;
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
