// EditFileTool:外科手术式局部替换。
// 对应课程第 07 讲,极简工具集原语之一。
//
// 核心:多级模糊匹配链,吸收大模型的"缩进幻觉"格式误差。
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。
// generateSimpleDiff 经 registry-impl 门面 re-export,供 approval/diff.ts 消费。

import { access, constants } from "node:fs/promises";
import type { BaseTool, ToolFileSideEffects } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { materializeModelText, toModelTextView } from "./line-endings.js";
import { findClosestLines, formatCandidateHint } from "./edit-hint.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import { readBoundedFileSnapshot, writeAtomicWorkspaceFile } from "./atomic-workspace-file.js";
import {
  READ_FILE_MAX_BYTES,
  assertSameResolvedTarget,
  exactPathSideEffects,
  workspaceRootsFrom,
} from "./file-helpers.js";

/**
 * 多级模糊匹配链 (Chain of Responsibility):四级容错降级替换。
 * L1 精确匹配 → L2 换行符归一化 → L3 Trim 首尾空白 → L4 逐行去缩进。
 * 安全底线:匹配结果 > 1 时拒绝替换,要求模型提供更多上下文。
 */
function fuzzyReplace(
  originalContent: string,
  oldText: string,
  newText: string,
  replaceAll?: boolean,
): { content: string; level: number } {
  // L1: 精确匹配
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount >= 1) {
    if (exactCount === 1 || replaceAll) {
      // split/join 全替换:replaceAll 时换所有,单处时也只换一处(等价)
      return { content: originalContent.split(oldText).join(newText), level: 1 };
    }
    throw new Error(`old_text 精确匹配到了 ${exactCount} 处,请提供更多的上下文代码以确保唯一性`);
  }

  // L2: 换行符归一化 (\r\n → \n)
  const normalizedContent = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  const l2Count = countOccurrences(normalizedContent, normalizedOld);
  if (l2Count >= 1) {
    if (l2Count === 1 || replaceAll) {
      return { content: normalizedContent.split(normalizedOld).join(newText), level: 2 };
    }
  }

  // L3: Trim Space 匹配 (忽略首尾空行和空格)
  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== "") {
    const l3Count = countOccurrences(normalizedContent, trimmedOld);
    if (l3Count >= 1) {
      if (l3Count === 1 || replaceAll) {
        return { content: normalizedContent.split(trimmedOld).join(newText), level: 3 };
      }
    }
  }

  // L4: 逐行去缩进匹配 (最强容错,消除模型遗漏缩进的幻觉)
  return {
    content: lineByLineReplace(normalizedContent, normalizedOld, newText, replaceAll),
    level: 4,
  };
}

/** 统计子串出现次数 (不重叠) */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 取行首空白前缀 (空格/制表符) */
function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i++;
  }
  return line.slice(0, i);
}

/** 取文本中第一个非空行 (含原始缩进);全空白返回 null */
function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim()) return line;
  }
  return null;
}

/**
 * L4 缩进重对齐 (对标 hermes _reindent_replacement)。
 * 非精确匹配命中后,模型 old_text/new_text 的缩进可能与文件实际缩进不一致
 * (如模型用 2 空格、文件用 4 空格)。直接写 new_text 会破坏文件缩进风格。
 *
 * 策略:以 old_text 第一个非空行的缩进为"模型基准缩进",
 *      以 fileRegion(文件中匹配到的实际区域)第一个非空行的缩进为"文件基准缩进"。
 * 两者相同 → 无需调整,原样返回 new_text。
 * 两者不同 → 遍历 new_text 每行:
 *   - 空行:保留原样(含纯空白行)
 *   - 行缩进以模型基准开头:替换基准前缀为文件基准前缀,保留额外嵌套
 *     (fileBaseIndent + line.slice(llmBaseIndent.length))
 *   - 行缩进不以模型基准开头(dedent 行):锚定到文件基准
 *     (fileBaseIndent + line 去首空白)
 */
function reindentReplacement(fileRegion: string, oldText: string, newText: string): string {
  if (!newText) return newText;

  const oldFirst = firstMeaningfulLine(oldText);
  const fileFirst = firstMeaningfulLine(fileRegion);
  if (oldFirst === null || fileFirst === null) return newText;

  const llmBaseIndent = leadingWhitespace(oldFirst);
  const fileBaseIndent = leadingWhitespace(fileFirst);

  // 缩进一致,无需重对齐
  if (llmBaseIndent === fileBaseIndent) return newText;

  const outLines: string[] = [];
  for (const line of newText.split("\n")) {
    if (!line.trim()) {
      // 空行:保留原样(含纯空白行)
      outLines.push(line);
      continue;
    }
    const lineIndent = leadingWhitespace(line);
    if (lineIndent.startsWith(llmBaseIndent)) {
      // 常见情况:行带有模型基准缩进(可能还有额外嵌套)。
      // 把基准前缀换成文件基准前缀,保留额外嵌套。
      const remainder = line.slice(llmBaseIndent.length);
      outLines.push(fileBaseIndent + remainder);
    } else {
      // dedent 行:比模型基准缩进更少。锚定到文件基准。
      outLines.push(fileBaseIndent + line.replace(/^[ \t]+/, ""));
    }
  }
  return outLines.join("\n");
}

/** L4: 按行切割,去除每行首尾空白后滑动窗口匹配
 *  返回所有匹配区间(每段 [startLine, endLine))的起始行索引列表 */
function findAllMatchRanges(contentLines: string[], oldLines: string[]): number[] {
  const starts: number[] = [];
  if (oldLines.length === 0 || contentLines.length < oldLines.length) return starts;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trim() !== oldLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) starts.push(i);
  }
  return starts;
}

/** L4: 按行切割,去除每行首尾空白后滑动窗口匹配。
 *  replaceAll=false(默认):仅当唯一匹配时替换,多处抛错(唯一性保护)。
 *  replaceAll=true:收集所有匹配区间,从后往前逐个替换,
 *  每个区间分别调 reindentReplacement 做缩进重对齐(基于该区间所在行的缩进)。 */
function lineByLineReplace(
  content: string,
  oldText: string,
  newText: string,
  replaceAll?: boolean,
): string {
  const contentLines = content.split("\n");
  const oldLines = oldText
    .trim()
    .split("\n")
    .map((l) => l.trim());

  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段");
  }

  const matchStarts = findAllMatchRanges(contentLines, oldLines);
  const matchCount = matchStarts.length;

  if (matchCount === 0) {
    throw new Error("在文件中未找到 old_text,请先调用 read_file 仔细确认要替换的内容");
  }
  if (matchCount > 1 && !replaceAll) {
    throw new Error(`模糊匹配到了 ${matchCount} 处相似代码,请提供更多上下文行代码以精确定位`);
  }

  if (!replaceAll) {
    // 唯一匹配:原逻辑
    const matchStart = matchStarts[0]!;
    const matchEnd = matchStart + oldLines.length;
    const fileRegion = contentLines.slice(matchStart, matchEnd).join("\n");
    const adjustedNewText = reindentReplacement(fileRegion, oldText, newText);
    return [
      ...contentLines.slice(0, matchStart),
      adjustedNewText,
      ...contentLines.slice(matchEnd),
    ].join("\n");
  }

  // replaceAll:从后往前逐区间替换(倒序避免行号偏移),每个区间独立缩进重对齐
  let lines = [...contentLines];
  for (let k = matchStarts.length - 1; k >= 0; k--) {
    const matchStart = matchStarts[k]!;
    const matchEnd = matchStart + oldLines.length;
    const fileRegion = lines.slice(matchStart, matchEnd).join("\n");
    const adjustedNewText = reindentReplacement(fileRegion, oldText, newText);
    lines = [...lines.slice(0, matchStart), adjustedNewText, ...lines.slice(matchEnd)];
  }
  return lines.join("\n");
}

export class EditFileTool implements BaseTool {
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "edit_file";
  }

  fileSideEffects(args: string): ToolFileSideEffects {
    return exactPathSideEffects(args);
  }

  /** 声明对 path 的读改写(Edit 必须先读后写,与并发写同文件冲突) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readWriteFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "edit_file",
      description:
        "对已授权工作区内的现有文件进行局部字符串替换。比重写整个文件更安全、更快速。请提供足够的上下文(建议上下各多包含几行)以确保 old_text 在文件中唯一。请先使用 read_file 读取文件,old_text 应取自 read_file 的输出(含行号前缀需去掉)。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要修改的文件路径" },
          old_text: {
            type: "string",
            description:
              "文件中原有的文本,取自 read_file 输出(去掉行号前缀)。必须包含足够的上下文以确保唯一匹配。",
          },
          new_text: { type: "string", description: "要替换成的新文本" },
          replace_all: {
            type: "boolean",
            description:
              "是否替换所有匹配处(默认 false,仅替换唯一匹配)。多处匹配且此项为 false 时会报错,设为 true 则全部替换。",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let oldText: string;
    let newText: string;
    let replaceAll: boolean;
    try {
      const input = JSON.parse(args) as {
        path?: string;
        old_text?: string;
        new_text?: string;
        replace_all?: boolean;
      };
      path = input.path ?? "";
      oldText = input.old_text ?? "";
      newText = input.new_text ?? "";
      replaceAll = input.replace_all === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path、old_text、new_text 字段");
    }

    const fullPath = await this.roots.assertAllowed(path);
    const snapshot = await readBoundedFileSnapshot(fullPath, READ_FILE_MAX_BYTES, path);
    await access(fullPath, constants.W_OK);
    const modelView = toModelTextView(snapshot.content);
    const content = modelView.text;
    let replacement: { content: string; level: number };
    try {
      replacement = fuzzyReplace(content, oldText, newText, replaceAll);
    } catch (err) {
      throw this.enrichNotFoundError(err, content, oldText);
    }

    await writeAtomicWorkspaceFile({
      targetPath: fullPath,
      content: materializeModelText(replacement.content, modelView.lineEndingStyle),
      precondition: snapshot.precondition,
      revalidateTarget: () => assertSameResolvedTarget(this.roots, path, fullPath),
    });

    // 5. 生成 diff 预览(简单 before/after 对比,供用户审批时查看)
    const diffPreview = generateSimpleDiff(oldText, newText);
    const allNote = replaceAll ? ", 全部替换" : "";
    return `✅ 成功修改文件: ${path} (匹配级别 L${replacement.level}${allNote})\n\n${diffPreview}`;
  }

  /**
   * 匹配失败时增强错误信息:对"未找到 old_text / 找不到该代码片段"类错误,
   * 用 findClosestLines 在文件里找最相似的几段,附在错误信息末尾帮模型重定位。
   * 其他错误(如 IO 失败、多处匹配、参数解析失败)原样返回,不附候选。
   */
  private enrichNotFoundError(err: unknown, content: string, oldText: string): Error {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!/未找到|找不到|not found/i.test(errMsg)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const hints = findClosestLines(content, oldText);
    if (hints.length === 0) {
      return err instanceof Error ? err : new Error(String(err));
    }
    return new Error(`${errMsg}${formatCandidateHint(hints)}`);
  }
}

// ==========================================
// Diff 预览生成 (第 1.3 讲: Diff 预览)
// 简单的 before/after 对比,不做完整 diff 算法。
// 用于 edit_file 返回结果和审批通知,让用户看到改了什么。
// ==========================================

/** diff 预览最大行数,超出截断 */
const DIFF_MAX_LINES = 30;

/**
 * 生成简单的 before/after diff 预览。
 * 格式类似 unified diff 但更简化:
 *   --- 修改前 (N 行)
 *   +++ 修改后 (M 行)
 *   - 旧行
 *   + 新行
 */
export function generateSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // 找到公共前缀
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  // 找到公共后缀
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

  const lines: string[] = [
    `--- 修改前 (${oldChanged.length} 行变更)`,
    `+++ 修改后 (${newChanged.length} 行变更)`,
  ];

  for (const line of oldChanged) {
    lines.push(`- ${line}`);
  }
  for (const line of newChanged) {
    lines.push(`+ ${line}`);
  }

  // 截断过长的 diff
  if (lines.length > DIFF_MAX_LINES) {
    const kept = lines.slice(0, DIFF_MAX_LINES);
    kept.push(`... (共 ${lines.length} 行,已截断)`);
    return kept.join("\n");
  }

  return lines.join("\n");
}
