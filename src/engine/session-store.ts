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

/** 持久化的事件记录:每行一个,带 type 判别联合 */
export type SessionRecord =
  | { readonly type: "message"; readonly seq: number; readonly message: Message }
  | { readonly type: "truncate"; readonly seq: number; readonly fromIndex: number };

/**
 * 单个 Session 的 JSONL 事件日志读写器。
 * 文件路径由调用方决定(通常是 workDir/.claw/sessions/<id>.jsonl)。
 */
export class SessionStore {
  constructor(private readonly filePath: string) {}

  /** 追加一条 message 事件。失败由调用方 catch(fire-and-forget)。 */
  async appendMessage(seq: number, message: Message): Promise<void> {
    const record: SessionRecord = { type: "message", seq, message };
    await this.appendLine(JSON.stringify(record));
  }

  /** 追加一条 truncate 事件(fromIndex 之前的 message 在重放时被丢弃)。 */
  async appendTruncate(seq: number, fromIndex: number): Promise<void> {
    const record: SessionRecord = { type: "truncate", seq, fromIndex };
    await this.appendLine(JSON.stringify(record));
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
