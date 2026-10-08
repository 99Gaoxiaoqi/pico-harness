import type { MemorySearchSignals } from "./atomic-memory-contracts.js";

const TOKEN_STOP_WORDS = new Set([
  "please", "remember", "memory", "project", "use", "using", "with", "that", "this", "the", "and", "for",
  "what", "which", "how", "when", "where", "does", "did", "was", "were", "are", "is", "of", "to", "in", "my", "our",
]);
const CJK_STOP_WORDS = new Set(["请记", "记住", "请使", "使用", "项目", "好的", "继续", "之前", "什么", "哪个", "如何", "我们"]);
const NON_EXPANSIVE = new Set(["ok", "okay", "yes", "go ahead", "continue", "好", "好的", "继续", "收到", "明白", "可以", "行", "对", "是的", "嗯"]);

export function normalizeMemorySearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function trimPunctuation(value: string): string {
  return value.replace(/^[.,:;!?()[\]{}]+|[.,:;!?()[\]{}]+$/gu, "");
}

export function collectMemorySearchSignals(value?: string): MemorySearchSignals {
  const text = normalizeMemorySearchText(value ?? "").trim();
  if (!text || NON_EXPANSIVE.has(text) || /^\/[a-z][\w:-]*(?:\s.*)?$/iu.test(text))
    return { paths: [], tokens: [], cjkBigrams: [] };
  const paths = [...new Set(text.match(/(?:\.{0,2}\/|\/)[^\s"'<>]+/gu)?.map(trimPunctuation) ?? [])]
    .filter((term) => [...term].length <= 256);
  const tokens = [...new Set((text.match(/[\p{L}\p{N}_@.-]+/gu) ?? []).map(trimPunctuation))]
    .filter((term) => term.length >= 2 && [...term].length <= 256 && !TOKEN_STOP_WORDS.has(term) && !/^\p{Script=Han}+$/u.test(term));
  const cjk = new Set<string>();
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    const points = [...run];
    for (let index = 0; index + 1 < points.length; index++) {
      const term = `${points[index]}${points[index + 1]}`;
      if (!CJK_STOP_WORDS.has(term)) cjk.add(term);
    }
  }
  let remaining = 32;
  const take = (terms: readonly string[]): string[] => {
    const selected = terms.slice(0, remaining);
    remaining -= selected.length;
    return selected;
  };
  return { paths: take(paths), tokens: take(tokens), cjkBigrams: take([...cjk]) };
}

/** Full-token/path matching and at least two informative CJK bigrams; no semantic inference. */
export function scoreMemoryContent(content: string, signals: MemorySearchSignals): number {
  const text = normalizeMemorySearchText(content);
  // Most scanned rows cannot match. Only tokenize positive substring candidates;
  // the final full-token/path checks keep the exact same matching semantics.
  const tokenTerms = signals.tokens.filter((term) => text.includes(term));
  const pathTerms = signals.paths.filter((term) => text.includes(term));
  const tokens = tokenTerms.length ? new Set((text.match(/[\p{L}\p{N}_@.-]+/gu) ?? []).map(trimPunctuation)) : new Set<string>();
  const paths = pathTerms.length ? new Set((text.match(/(?:\.{0,2}\/|\/)[^\s"'<>]+/gu) ?? []).map(trimPunctuation)) : new Set<string>();
  const pathCount = pathTerms.filter((term) => paths.has(term)).length;
  const tokenCount = tokenTerms.filter((term) => tokens.has(term)).length;
  const cjkCount = signals.cjkBigrams.filter((term) => text.includes(term)).length;
  return pathCount * 8 + tokenCount * 4 + (cjkCount >= 2 ? Math.min(cjkCount, 8) : 0);
}
