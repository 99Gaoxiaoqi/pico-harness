/**
 * Tool Result 摘要器:统一 head-tail 截断。
 *
 * 超过 2048 token 的工具结果原文写入 Evidence CAS（SHA-256 寻址），
 * 模型只收到一份有界预览，需要完整原文时调用 read_evidence 分页回读。
 * 因此预览不需要按工具类型做智能提取——head-tail 足够让模型了解大致内容，
 * 精确细节通过 read_evidence 按需获取。
 *
 * 原文永不丢失（CAS 兜底 + 写失败时 inline 保留），所以"预览不够精确"的代价
 * 只是模型多一次 read_evidence 调用，是按需支付的边际成本。
 */

export interface ToolResultSummaryInput {
  toolName: string;
  arguments: string;
  output: string;
  isError?: boolean;
  maxChars?: number;
}

export interface ToolResultSummary {
  text: string;
  strategy: string;
  originalChars: number;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 3000;

export function summarizeToolResult(input: ToolResultSummaryInput): ToolResultSummary {
  const maxChars = normalizeMaxChars(input.maxChars);
  const toolName = input.toolName.trim();
  const header = [
    `tool: ${toolName || "(unknown)"}`,
    `originalChars: ${input.output.length}`,
  ];

  const { text, truncated } = buildHeadTailText(input.output, header, maxChars);
  const fitted = fitToBudget(text, maxChars);
  return {
    text: fitted,
    strategy: "head-tail",
    originalChars: input.output.length,
    truncated: truncated || fitted.length < text.length,
  };
}

function normalizeMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.max(0, Math.floor(maxChars));
}

/**
 * 保留输出的头尾各一半预算，中间标注省略字符数。
 * 头部保留开头（文件 import、配置、命令开始），
 * 尾部保留结尾（exit code、错误摘要、测试结果）。
 */
function buildHeadTailText(
  output: string,
  headerLines: string[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const prefix = `${headerLines.join("\n")}\n`;
  if (prefix.length + output.length <= maxChars) {
    return { text: `${prefix}${output}`, truncated: false };
  }

  const markerBase = "\n...[omitted]...\n";
  const available = maxChars - prefix.length - markerBase.length;
  if (available <= 0) {
    return { text: fitToBudget(prefix, maxChars), truncated: true };
  }

  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  const omittedChars = Math.max(0, output.length - headChars - tailChars);
  const marker = `\n...[omitted ${omittedChars} chars]...\n`;
  const adjustedAvailable = Math.max(0, maxChars - prefix.length - marker.length);
  const adjustedHeadChars = Math.ceil(adjustedAvailable / 2);
  const adjustedTailChars = adjustedAvailable - adjustedHeadChars;
  const tail = adjustedTailChars > 0 ? output.slice(-adjustedTailChars) : "";
  return {
    text: `${prefix}${output.slice(0, adjustedHeadChars)}${marker}${tail}`,
    truncated: true,
  };
}

/** 最终字符预算兜底:超限时头尾各取一半。 */
function fitToBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length) {
    return text.slice(0, maxChars);
  }
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  const tailChars = available - headChars;
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${text.slice(0, headChars)}${marker}${tail}`;
}
