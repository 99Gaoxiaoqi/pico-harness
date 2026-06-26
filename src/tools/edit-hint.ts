// 匹配全失败时,在文件里找最相似的几段,附在错误信息里帮模型重定位。
// 对标 hermes find_closest_lines / format_no_match_hint,但用无依赖的字符 Dice
// 系数替代 difflib SequenceMatcher,并改用"按 oldText 行数滑动窗口"的整段相似度,
// 更贴近编辑工具"整段替换"的匹配语义。

/** 候选段提示:一段与 oldText 最相似的文件片段 */
export interface CandidateHint {
  /** 起始行号(1-based, 含上下文扩展) */
  readonly lineStart: number;
  /** 结束行号(1-based, 含上下文扩展, inclusive) */
  readonly lineEnd: number;
  /** 带行号的预览文本,如 "3 | func main() {\n4 |   ..." */
  readonly preview: string;
  /** 与 oldText 的相似度, 0~1 */
  readonly similarity: number;
}

/** 相似度下限:低于此值的窗口不作为候选(与 hermes 的 0.3 阈值一致) */
const DEFAULT_MIN_SIMILARITY = 0.3;

/**
 * 字符级 Dice 系数:2*|字符频率交集| / (|a| + |b|)。
 * 公式与 difflib SequenceMatcher.ratio() 同形(2*M/(T1+T2)),
 * 不引入新依赖,简单但足以给模型指方向。
 */
function charDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const fa = new Map<string, number>();
  const fb = new Map<string, number>();
  for (const ch of a) fa.set(ch, (fa.get(ch) ?? 0) + 1);
  for (const ch of b) fb.set(ch, (fb.get(ch) ?? 0) + 1);

  let inter = 0;
  for (const [ch, count] of fa) {
    const other = fb.get(ch);
    if (other !== undefined) inter += Math.min(count, other);
  }
  return (2 * inter) / (a.length + b.length);
}

/**
 * 两段文本(按行)的相似度:逐行 trim 后算 charDice,取平均。
 * 行数不等时按较短的对齐(滑动窗口保证等长,这里只是防御)。
 */
function linesSimilarity(windowLines: string[], oldLines: string[]): number {
  const n = Math.min(windowLines.length, oldLines.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += charDice(windowLines[i]!.trim(), oldLines[i]!.trim());
  }
  return sum / n;
}

/** 生成带行号的预览片段,行号右对齐到最大行号位数 */
function buildPreview(lines: string[], start: number, end: number): string {
  const width = String(end).length;
  const parts: string[] = [];
  for (let i = start; i <= end; i++) {
    parts.push(`${String(i).padStart(width, " ")} | ${lines[i - 1] ?? ""}`);
  }
  return parts.join("\n");
}

/**
 * 在 content 里找与 oldText 最相似的候选段。
 * 策略:按 oldText 行数划滑动窗口,算每个窗口与 oldText 的行级相似度,
 * 取 top N(默认 3)。每个候选前后各扩展 contextLines 行上下文。
 */
export function findClosestLines(
  content: string,
  oldText: string,
  contextLines: number = 2,
  maxResults: number = 3,
): CandidateHint[] {
  if (!oldText || !content) return [];

  const contentLines = content.split("\n");
  // trim 去掉 oldText 首尾空行干扰,保留中间行结构用于窗口对齐
  const oldLines = oldText.trim().split("\n");
  const windowSize = oldLines.length;
  if (windowSize === 0 || contentLines.length < windowSize) return [];

  // 滑动窗口打分
  const scored: Array<{ sim: number; start: number }> = [];
  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const window = contentLines.slice(i, i + windowSize);
    const sim = linesSimilarity(window, oldLines);
    if (sim > DEFAULT_MIN_SIMILARITY) {
      scored.push({ sim, start: i });
    }
  }
  if (scored.length === 0) return [];

  // 取 top N, 按相似度降序
  scored.sort((a, b) => b.sim - a.sim || a.start - b.start);
  const limit = Math.max(1, maxResults);
  const top = scored.slice(0, limit);

  // 扩展上下文 + 去重重叠窗口
  const hints: CandidateHint[] = [];
  const seen = new Set<string>();
  for (const { sim, start } of top) {
    const lineStart = Math.max(1, start + 1 - contextLines);
    const lineEnd = Math.min(contentLines.length, start + windowSize + contextLines);
    const key = `${lineStart}:${lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      lineStart,
      lineEnd,
      preview: buildPreview(contentLines, lineStart, lineEnd),
      similarity: sim,
    });
  }
  return hints;
}

/**
 * 格式化候选提示字符串,可拼接到错误信息末尾。
 * 空列表返回空串(调用方据此判断是否拼接)。
 * 输出形如:
 *
 *   \n\n你是否想编辑以下位置之一?
 *     第 3-7 行:
 *       3 | func main() {
 *       4 |   if err != nil {
 *       ...
 *   ---
 *     第 12-16 行:
 *       ...
 */
export function formatCandidateHint(hints: CandidateHint[]): string {
  if (hints.length === 0) return "";
  const blocks = hints.map((h) => {
    const indentedPreview = h.preview.replaceAll("\n", "\n    ");
    return `  第 ${h.lineStart}-${h.lineEnd} 行:\n    ${indentedPreview}`;
  });
  return `\n\n你是否想编辑以下位置之一?\n${blocks.join("\n  ---\n")}`;
}
