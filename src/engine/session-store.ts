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

import { appendFile, readFile } from "node:fs/promises";
import type { Message } from "../schema/message.js";
import { logger } from "../observability/logger.js";

/** 持久化的事件记录:每行一个,带 type 判别联合。 */
/**
 * message record 的可选 `volatile` 字段(4.3 cursor 多端同步):
 *   - true:易失事件(如流式片段 text-delta),仅用于 WS 实时推送,
 *     不推进 cursor seq,重放时被丢弃(不重建进 history)。
 *   - false/缺省:持久事件,推进 seq,重放时进入 history。
 *   向后兼容:旧 JSONL 无此字段,load/recover 时按 false 处理(即全部当作持久)。
 */
export type SessionRecord =
  | {
      readonly type: "message";
      readonly seq: number;
      readonly message: Message;
      readonly volatile?: boolean;
    }
  | { readonly type: "truncate"; readonly seq: number; readonly fromIndex: number }
  | { readonly type: "undo"; readonly seq: number; readonly count: number; readonly at: string }
  | { readonly type: "rewind_to"; readonly seq: number; readonly messageIndex: number; readonly at: string };

/**
 * record 落盘监听器(4.3 cursor 多端同步)。
 *
 * SessionStore 在每条 record 追加后(无论 volatile 与否)向监听器广播
 * (record, seq, epoch)。WS 层订阅它,据此向连接的 client 推送事件流:
 *   - 持久事件(message with volatile!=true)/ truncate / undo / rewind_to 推进 seq
 *   - 易失事件(message with volatile===true)不推进 seq
 *   - epoch 用于 fork/rewind 后让旧 cursor 的 client 感知"世代已变"
 *
 * 监听器同步触发(appendLine 之后),保证 seq 单调与推送顺序一致。
 */
export type SessionRecordListener = (
  record: SessionRecord,
  seq: number,
  epoch: number,
) => void;

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

  constructor(private readonly filePath: string) {}

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
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch (error) {
        if (i === lines.length - 1) {
          // 末行撕裂:append 写一半的典型表现,容忍跳过
          break;
        }
        // 中间行损坏:跳过该行继续解析(warn 不 throw),保住其余有效记录。
        // 旧实现 throw 会让 recover 全量丢弃,第 50 行损坏 → 前 49 条有效记录丢失(M2)。
        logger.warn(
          { line: i + 1 },
          `[session] 第 ${i + 1} 行损坏,跳过: ${String(error)}`,
        );
        continue;
      }
    }
    // 关键:按 seq 排序,消除 fire-and-forget 落盘乱序的影响
    records.sort((a, b) => a.seq - b.seq);
    return records;
  }

  private async appendLine(line: string): Promise<void> {
    await appendFile(this.filePath, line + "\n", "utf8");
  }
}
