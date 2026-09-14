import type { ToolDefinition } from "@pico/core";

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
    const hit = candidates.find((tool) => tool.name === exact);
    return hit ? [{ tool: hit, score: 1 }] : [];
  }

  const queryTokens = tokenize(trimmed);
  if (queryTokens.length === 0) return [];

  const docs = candidates.map((tool) => ({
    tool,
    tokens: tokenize(`${tool.name} ${tool.description}`),
  }));
  const totalDocs = docs.length;
  if (totalDocs === 0) return [];

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
    const score = nameHit ? 0.8 + 0.2 * tfidf : tfidf * TFIDF_WEIGHT + keyword * KEYWORD_WEIGHT;
    return { tool: doc.tool, score };
  });

  return scored
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase();
  const segments = normalized.split(/([\u4e00-\u9fff]+)/);
  for (const segment of segments) {
    if (!segment) continue;
    if (/^[\u4e00-\u9fff]+$/.test(segment)) {
      if (segment.length === 1) {
        tokens.push(segment);
      } else {
        for (let index = 0; index < segment.length - 1; index++) {
          tokens.push(segment.slice(index, index + 2));
        }
      }
    } else {
      for (const word of segment.split(/\s+/)) {
        if (word.length >= 2 || /[\u4e00-\u9fff]/.test(word)) tokens.push(word);
      }
    }
  }
  return tokens;
}

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
  const uniqueQuery = new Set(queryTokens);
  let score = 0;
  for (const token of uniqueQuery) {
    const termFreq = tf.get(token);
    if (!termFreq) continue;
    const df = docFreq.get(token) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
    score += (termFreq / docTokens.length) * idf;
  }
  return Math.min(1, (score / Math.max(1, uniqueQuery.size)) * 8);
}

function keywordScore(tool: ToolDefinition, queryTokens: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let hits = 0;
  let counted = 0;
  for (const token of new Set(queryTokens)) {
    if (token.length < 2 && !/[\u4e00-\u9fff]/.test(token)) continue;
    counted++;
    if (name.includes(token) || description.includes(token)) hits++;
  }
  return counted === 0 ? 0 : hits / counted;
}

function nameTokenHit(tool: ToolDefinition, queryTokens: string[]): boolean {
  const name = tool.name.toLowerCase();
  return queryTokens.some((token) => token.length >= 3 && name.includes(token));
}
