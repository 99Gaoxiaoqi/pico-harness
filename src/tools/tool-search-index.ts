// 工具检索引擎：TF-IDF + 关键词混合检索（升级自纯子串匹配）。
//
// search_tools 的兜底路径用（检索 MCP/Plugin 动态工具）。
// 三级匹配策略：
// 1. select: 前缀 → 精确名称选择（score = 1.0）
// 2. 名称 token 命中 → 高分（score = 0.8）
// 3. TF-IDF + 中文 bigram 关键词 → 模糊排名（score = 0-0.6）
//
// 中文无分词库依赖：query 与 haystack 均按 CJK bigram 切分，
// 英文按空白分词后 lowercase。

import type { ToolDefinition } from "../schema/message.js";

export interface ToolSearchResult {
  tool: ToolDefinition;
  score: number;
}

/** 检索结果的默认返回上限——宽召回但不倾倒。 */
const DEFAULT_TOP_K = 5;

/** TF-IDF 与关键词精确匹配的权重比（对齐 Claude Code 0.6:0.4）。 */
const TFIDF_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

/**
 * 检索工具。query 支持：
 * - "select:tool_name" 精确选择
 * - 普通关键词（中英文混合），按混合评分排名
 */
export function searchTools(
  candidates: readonly ToolDefinition[],
  query: string,
  topK: number = DEFAULT_TOP_K,
): ToolSearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith("select:")) {
    const exact = trimmed.slice("select:".length).trim();
    const hit = candidates.find((t) => t.name === exact);
    return hit ? [{ tool: hit, score: 1 }] : [];
  }

  const queryTokens = tokenize(trimmed);
  if (queryTokens.length === 0) return [];

  // 预建文档：每个候选工具的 name+description 分词结果。
  const docs = candidates.map((tool) => ({
    tool,
    tokens: tokenize(`${tool.name} ${tool.description}`),
  }));
  const totalDocs = docs.length;
  if (totalDocs === 0) return [];

  // IDF：token 出现在多少个文档中。
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  const scored = docs.map((doc) => {
    const tfidf = tfidfScore(doc.tokens, queryTokens, docFreq, totalDocs);
    const keyword = keywordScore(doc.tool, queryTokens);
    const nameHit = nameTokenHit(doc.tool, queryTokens);
    const score = nameHit ? 0.8 : tfidf * TFIDF_WEIGHT + keyword * KEYWORD_WEIGHT;
    return { tool: doc.tool, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 分词：CJK 字符两两组成 bigram；连续的非 CJK 字符（含数字、下划线）
 * 作为整体 lowercase token；其余按空白分隔。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  // 先抽出英文/数字 token，再对剩余 CJK 段做 bigram。
  const segments = normalized.split(/([\u4e00-\u9fff]+)/);
  for (const segment of segments) {
    if (!segment) continue;
    if (/^[\u4e00-\u9fff]+$/.test(segment)) {
      if (segment.length === 1) {
        tokens.push(segment);
      } else {
        for (let i = 0; i < segment.length - 1; i++) {
          tokens.push(segment.slice(i, i + 2));
        }
      }
    } else {
      for (const word of segment.split(/\s+/)) {
        if (word) tokens.push(word);
      }
    }
  }
  return tokens;
}

/** TF-IDF 得分：query token 在文档中的 tf * idf 加和，归一到 0-1。 */
function tfidfScore(
  docTokens: string[],
  queryTokens: string[],
  docFreq: Map<string, number>,
  totalDocs: number,
): number {
  const tf = new Map<string, number>();
  for (const token of docTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const termFreq = tf.get(token);
    if (!termFreq) continue;
    const df = docFreq.get(token) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
    score += (termFreq / docTokens.length) * idf;
  }
  // 归一：经验上限，防止长 description 淹没信号。
  return Math.min(1, score * 10);
}

/** 关键词得分：query token 是工具名或 description 的子串即部分命中。 */
function keywordScore(tool: ToolDefinition, queryTokens: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let hits = 0;
  for (const token of new Set(queryTokens)) {
    if (name.includes(token) || description.includes(token)) hits++;
  }
  return queryTokens.length === 0 ? 0 : hits / new Set(queryTokens).size;
}

/** 工具名直接命中 query token（如搜 "web_search" 或 "web" 命中 web_search）。 */
function nameTokenHit(tool: ToolDefinition, queryTokens: string[]): boolean {
  const name = tool.name.toLowerCase();
  return queryTokens.some((token) => token.length >= 3 && name.includes(token));
}
