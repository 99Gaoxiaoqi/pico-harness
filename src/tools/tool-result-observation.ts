import { createHash } from "node:crypto";
import type { RuntimeToolResultProjection } from "../engine/tool-result-contract.js";
import type { ToolCall, ToolResult } from "../schema/message.js";

/**
 * 入口上限门(ADR 26 §2.2,对齐 maka maxToolOutputBytes):单次工具结果
 * 超过 1MB 时在门口拒绝——原始输出不落盘,inline 正文与 Provider 投影均
 * 替换为带重取指引的合成错误。写入不再做 token 阈值分叉;上下文瘦身全部
 * 移到读取侧(ADR 26 §2.3,票 E2)。
 */
export const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

export type { RuntimeToolResultProjection } from "../engine/tool-result-contract.js";

export interface RuntimeToolResultProjectionResult {
  /** true 表示原始输出超过 MAX_TOOL_RESULT_BYTES 被入口门拒绝,原文永久丢弃(ADR 26 §4)。 */
  readonly overLimit: boolean;
  /** canonical inline 正文(= tool.result.recorded body.content):正常为工具物理输出;超限时为合成错误文本。 */
  readonly inlineContent: string;
  /** inline 正文的完整性元数据;正常路径即描述工具物理输出——Recovery 文本只进投影,不改哈希语义。 */
  readonly rawSha256: string;
  readonly rawSizeBytes: number;
  readonly projection: RuntimeToolResultProjection;
}

export interface BuildRuntimeToolResultProjectionInput {
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
  /** Provider-visible output after deterministic Recovery guidance has been injected. */
  readonly modelOutput: string;
}

/**
 * Build the deterministic Provider projection without persisting or mutating ToolResult facts.
 *
 * ADR 26(入口定形):所有结果全文 inline 入库,投影只有两种写入形态——
 * - mode "full":正文即模型可见输出(Recovery 注入只体现在投影策略标记);
 * - mode "synthetic":超过 MAX_TOOL_RESULT_BYTES 的结果被入口门拒绝,投影为
 *   指引模型用管道(grep/head/tail)或 read_file 分段重取的合成错误。
 * 旧账本中的 mode "preview" / storage "evidence" 形态仅在读取侧容忍(票 E1/E3)。
 * Integrity metadata always describes the persisted inline content; Recovery text is projection-only.
 */
export function buildRuntimeToolResultProjection(
  input: BuildRuntimeToolResultProjectionInput,
): RuntimeToolResultProjectionResult {
  const rawBytes = Buffer.from(input.result.output, "utf8");
  if (rawBytes.byteLength > MAX_TOOL_RESULT_BYTES) {
    return buildOverLimitResult(input.toolCall.name, rawBytes.byteLength);
  }

  const inlineContent = input.result.output;
  const recoveryInjected = input.modelOutput !== input.result.output;
  return {
    overLimit: false,
    inlineContent,
    rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
    rawSizeBytes: rawBytes.byteLength,
    projection: {
      version: 1,
      mode: "full",
      text: input.modelOutput,
      strategy: recoveryInjected ? "recovery-injected" : "original",
      truncated: false,
    },
  };
}

/**
 * 超限合成错误:描述性元数据(哈希/字节数)随 inline 正文描述合成事实本身,
 * 原始字节数写进错误文本保留审计线索——原文已按 ADR 26 §4 永久丢弃。
 */
function buildOverLimitResult(
  toolName: string,
  rawSizeBytes: number,
): RuntimeToolResultProjectionResult {
  const inlineContent = buildOverLimitRejectionText(`工具 ${toolName} `, rawSizeBytes);
  const inlineBytes = Buffer.from(inlineContent, "utf8");
  return {
    overLimit: true,
    inlineContent,
    rawSha256: createHash("sha256").update(inlineBytes).digest("hex"),
    rawSizeBytes: inlineBytes.byteLength,
    projection: {
      version: 1,
      mode: "synthetic",
      text: inlineContent,
      strategy: "output-limit-gate",
      truncated: true,
    },
  };
}

/**
 * 入口上限门的统一拒绝文案(票 E3):工具结果与子代理报告共用同一语义——
 * 超限事实 + 有界重取指引,原文不落盘。
 */
export function buildOverLimitRejectionText(subjectLabel: string, rawSizeBytes: number): string {
  return [
    `输出超限: ${subjectLabel}的原始结果 ${rawSizeBytes} 字节,超过单次入库上限 ${MAX_TOOL_RESULT_BYTES} 字节(1MB)。`,
    "该结果已被入口上限门拒绝,原文未保存。",
    "",
    "请改用有界方式重取需要的内容:",
    '- 用 bash 管道截取片段,如: grep -n "关键词" <文件> | head -50、<命令> | head -200、<命令> | tail -100;',
    "- 目标是文件时,用 read_file 的 offset/limit 参数分段读取,不要一次性读取全文。",
  ].join("\n");
}
