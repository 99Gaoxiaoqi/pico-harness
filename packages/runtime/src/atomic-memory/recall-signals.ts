import type { MemorySearchSignals } from "@pico/core/atomic-memory-contracts";
import {
  collectMemorySearchSignals,
  normalizeMemorySearchText,
} from "@pico/core/atomic-memory-search";

/** Local, versioned vocabulary only. These hints never satisfy tool/scope permissions. */
export const MEMORY_RECALL_QUERY_POLICY = "lexical-alias-v1";
const ALIASES = [
  ["build", "构建"],
  ["typecheck", "类型检查"],
  ["lint", "代码规范检查"],
  ["format", "代码格式化"],
  ["dependency", "依赖"],
  ["cache", "缓存"],
  ["timeout", "超时"],
  ["pagination", "分页"],
  ["encoding", "编码"],
  ["serialization", "序列化"],
  ["migration", "数据库迁移"],
  ["deduplication", "去重"],
] as const;

export function collectMemoryRecallSignals(query?: string): {
  readonly primary: MemorySearchSignals;
  readonly expanded: MemorySearchSignals;
  readonly aliases: MemorySearchSignals;
} {
  const primary = collectMemorySearchSignals(query);
  let plain = normalizeMemorySearchText(query ?? "").replace(/```[\s\S]*?```/gu, " ");
  for (const path of primary.paths) plain = plain.replaceAll(path, " ");
  // Paths, flags and identity assignments must not grow lexical aliases.
  plain = plain
    .replace(/(?:^|\s)--?\S+/gu, " ")
    .replace(/\b[\w-]+\s*[:=]\s*\S+/gu, " ")
    .replace(/\S*[/\\]\S*/gu, " ");
  const words = collectMemorySearchSignals(plain);
  const hints: string[] = [];
  for (const [english, chinese] of ALIASES) {
    if (words.tokens.includes(english)) hints.push(chinese);
    else if (plain.includes(chinese)) hints.push(english);
    if (hints.length === 4) break;
  }
  const proposed = collectMemorySearchSignals(hints.join(" "));
  let remaining = Math.max(
    0,
    32 - primary.paths.length - primary.tokens.length - primary.cjkBigrams.length,
  );
  const merge = (original: readonly string[], extra: readonly string[]): string[] => {
    const additions = extra.filter((term) => !original.includes(term)).slice(0, remaining);
    remaining -= additions.length;
    return [...original, ...additions];
  };
  const expanded = {
    paths: [...primary.paths],
    tokens: merge(primary.tokens, proposed.tokens),
    cjkBigrams: merge(primary.cjkBigrams, proposed.cjkBigrams),
  };
  const aliases = {
    paths: [],
    tokens: expanded.tokens.filter((term) => !primary.tokens.includes(term)),
    cjkBigrams: expanded.cjkBigrams.filter((term) => !primary.cjkBigrams.includes(term)),
  };
  return { primary, expanded, aliases };
}
