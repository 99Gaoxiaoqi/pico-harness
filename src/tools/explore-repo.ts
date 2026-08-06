/**
 * explore_repo：一次性有界仓库侦察工具。
 *
 * 确定性纯算法，零 LLM 调用。复用 RepoMapService 的符号扫描能力，
 * 叠加项目结构启发式打分 + 行级内容匹配，一次调用返回：
 * - 打分排序的候选文件（含符号清单）
 * - 行级证据锚点（含行号和 snippet）
 * - 可读文本报告
 *
 * 设计参考 maka-agent ExploreAgent，但 pico 有 repo_map 的符号级能力，
 * 所以打分维度更丰富（符号匹配 + 项目结构 + 内容匹配三层）。
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { RepoMapService } from "../code-intelligence/repo-map.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";

// ============================================================
// 常量
// ============================================================

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_MATCHES = 60;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MATCH_CONTEXT_CHARS = 220;
const MAX_CANDIDATES = 20;
const MAX_EVIDENCE = 10;

const PROJECT_MANIFEST_FILES = new Set([
  "package.json", "pnpm-workspace.yaml", "turbo.json", "tsconfig.json",
  "vite.config.ts", "vite.config.js",
  "Cargo.toml", "go.mod", "pyproject.toml", "Package.swift",
  "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt",
]);

const DOCUMENTATION_FILES = new Set([
  "README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "ARCHITECTURE.md",
]);

const ENTRYPOINT_NAMES = new Set([
  "main.ts", "main.tsx", "main.js", "main.jsx",
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "server.ts", "server.js", "app.ts", "app.tsx", "app.js", "app.jsx",
  "main.go", "main.py", "main.rs",
  "application.java", "main.java", "app.java",
]);

const SENSITIVE_FILE_PATTERNS = [
  /\.env/i, /\.pem$/i, /\.key$/i, /\.p12$/i,
  /id_rsa/i, /credentials/i, /\.secret/i,
];

const COMMON_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "project", "please",
  "的", "了", "和", "是", "在", "找", "到", "看", "下", "这个", "那个",
]);

// ============================================================
// 工具类
// ============================================================

export class ExploreRepoTool implements BaseTool {
  readonly readOnly = true;
  private readonly repoMap: RepoMapService;

  constructor(private readonly rootDir: string, service: unknown) {
    this.repoMap = service instanceof RepoMapService ? service : new RepoMapService(rootDir);
  }

  name(): string {
    return "explore_repo";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "一次性有界仓库侦察。扫描文件名+符号+内容，返回打分排序的候选文件、行级证据锚点和符号清单。" +
        "适用于目标位置未知的探索；已知文件请直接 read_file。",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "研究目标（4-600 字符）" },
          queries: {
            type: "array",
            items: { type: "string" },
            description: "可选的搜索词，省略则从 objective 自动派生",
          },
          roots: {
            type: "array",
            items: { type: "string" },
            description: "相对根目录（默认 [\".\"]）",
          },
          max_files: { type: "number", minimum: 1, maximum: 80, description: "最多读取文件数（默认 30）" },
          max_matches: { type: "number", minimum: 1, maximum: 120, description: "最多内容命中数（默认 60）" },
        },
        required: ["objective"],
      },
    };
  }

  accesses(): ToolAccessSet {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = JSON.parse(args) as Record<string, unknown>;
    const objective = String(input.objective ?? "").trim().slice(0, 600);
    if (objective.length < 4) {
      return "错误：objective 至少 4 个字符。";
    }

    const queries = deriveQueries(
      objective,
      Array.isArray(input.queries) ? (input.queries as string[]).map(String) : undefined,
    );
    const maxFiles = clampInt(input.max_files, DEFAULT_MAX_FILES, 1, 80);
    const maxMatches = clampInt(input.max_matches, DEFAULT_MAX_MATCHES, 1, 120);
    const signal = context?.signal;

    // Step 1：repo_map 符号扫描
    // 先用 query 精确匹配；如果没命中（文件名/符号名不含查询词），fallback 到全量索引扫描，
    // 靠 Step 3 的内容匹配来找。这解决了"目标代码的文件名/符号名不含查询词"的常见场景。
    // 全量 fallback 时索引 maxFiles×5（上限 200），确保大仓库的关键文件被覆盖。
    const queryStr = queries.join(" ");
    let snapshot = await this.repoMap.snapshot({ query: queryStr, maxFiles, signal });
    signal?.throwIfAborted();
    if (snapshot.files.length === 0) {
      const indexBudget = Math.min(200, maxFiles * 5);
      snapshot = await this.repoMap.snapshot({ maxFiles: indexBudget, signal });
      signal?.throwIfAborted();
    }

    // Step 2：项目结构启发式 + 路径级 query 匹配叠加打分
    const candidates: Candidate[] = snapshot.files.map((f) => {
      const structural = scoreStructure(f.filePath);
      const pathMatch = scorePathQuery(f.filePath, queries);
      return {
        filePath: f.filePath,
        symbols: f.symbols,
        score: f.score + structural.score + pathMatch.score,
        reasons: [...f.reasons, ...structural.reasons, ...pathMatch.reasons],
        matches: [] as MatchEntry[],
      };
    });

    // Step 3：行级内容匹配（只对高分候选读内容）
    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    const toInspect = candidates.slice(0, maxFiles);
    let totalMatches = 0;
    let totalBytes = 0;
    let filesInspected = 0;
    let sensitiveSkipped = 0;

    for (const candidate of toInspect) {
      signal?.throwIfAborted();
      if (totalMatches >= maxMatches || totalBytes >= MAX_TOTAL_BYTES) break;

      const absPath = resolve(this.rootDir, candidate.filePath);
      const lowerPath = candidate.filePath.toLowerCase();

      // 敏感文件跳过
      if (SENSITIVE_FILE_PATTERNS.some((p) => p.test(lowerPath))) {
        sensitiveSkipped++;
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        continue;
      }
      if (fileStat.size > MAX_FILE_BYTES || totalBytes + fileStat.size > MAX_TOTAL_BYTES) continue;

      let content: string;
      try {
        content = await readFile(absPath, "utf8");
      } catch {
        continue;
      }
      totalBytes += content.length;
      filesInspected++;

      // 行级匹配
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && totalMatches < maxMatches; i++) {
        const lowerLine = lines[i]!.toLowerCase();
        const hit = queries.find((q) => lowerLine.includes(q.toLowerCase()));
        if (!hit) continue;
        candidate.matches.push({
          path: candidate.filePath,
          line: i + 1,
          query: hit,
          snippet: capSnippet(lines[i]!),
        });
        candidate.score += 3;
        if (!candidate.reasons.includes("content match")) candidate.reasons.push("content match");
        totalMatches++;
      }
    }

    // Step 4：汇总输出
    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    const top = candidates.filter((c) => c.score > 0 || c.matches.length > 0).slice(0, MAX_CANDIDATES);
    const evidence = buildEvidence(top);
    const report = buildReport(objective, queries, top, evidence, {
      filesInspected,
      totalMatches,
      totalBytes,
      sensitiveSkipped,
      indexed: snapshot.indexedFiles,
      total: snapshot.totalFiles,
    });

    return report;
  }
}

// ============================================================
// 辅助类型和函数
// ============================================================

interface MatchEntry {
  path: string;
  line: number;
  query: string;
  snippet: string;
}

export interface Candidate {
  filePath: string;
  symbols: readonly { kind: string; name: string }[];
  score: number;
  reasons: string[];
  matches: MatchEntry[];
}

/** 从 objective 自动派生搜索词（Unicode 感知切分 + 中英文停用词过滤）。 */
export function deriveQueries(objective: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) {
    return explicit.slice(0, 8).map((q) => q.trim()).filter((q) => q.length > 0);
  }
  const words = objective
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !COMMON_WORDS.has(w.toLowerCase()));
  return words.length > 0 ? words.slice(0, 8) : [objective.slice(0, 80)];
}

/** 项目结构启发式打分：manifest/文档/入口/测试/源码面。 */
export function scoreStructure(filePath: string): { score: number; reasons: string[] } {
  const base = basename(filePath);
  const lowerBase = base.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (hasIgnoreCase(PROJECT_MANIFEST_FILES, base)) {
    score += 12;
    reasons.push("project manifest");
  }
  if (hasIgnoreCase(DOCUMENTATION_FILES, base)) {
    score += 10;
    reasons.push("project documentation");
  }
  if (ENTRYPOINT_NAMES.has(lowerBase)) {
    score += 8;
    reasons.push("project entrypoint");
  }
  if (/\b(__tests__|tests?|specs?|e2e)\b/i.test(filePath) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(lowerBase)) {
    score += 6;
    reasons.push("project test surface");
  }
  if (/\b(src|app|packages|apps)\b/i.test(filePath)) {
    score += 2;
    reasons.push("project source surface");
  }
  return { score, reasons };
}

/** 大小写不敏感的 Set 匹配。 */
function hasIgnoreCase(set: ReadonlySet<string>, value: string): boolean {
  return set.has(value) || set.has(value.toLowerCase());
}

/** 路径级 query 匹配：路径包含查询词时加分（子串匹配，大小写不敏感）。 */
function scorePathQuery(filePath: string, queries: readonly string[]): { score: number; reasons: string[] } {
  const lowerPath = filePath.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const q of queries) {
    if (q.length < 2) continue;
    if (lowerPath.includes(q.toLowerCase())) {
      score += 5;
      reasons.push(`path contains "${q}"`);
    }
  }
  return { score, reasons };
}

/** snippet 截取：压空白 + 码点安全截断。 */
export function capSnippet(line: string): string {
  const cleaned = line.replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, MATCH_CONTEXT_CHARS).join("");
}

/** 构造证据锚点：优先内容命中，补候选文件，封顶 10。 */
export function buildEvidence(candidates: readonly Candidate[]): readonly { path: string; line?: number; label: string }[] {
  const evidence: { path: string; line?: number; label: string }[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    for (const m of c.matches) {
      const key = `${m.path}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ path: m.path, line: m.line, label: `内容命中：${m.query}` });
      if (evidence.length >= MAX_EVIDENCE) return evidence;
    }
  }
  for (const c of candidates) {
    if (seen.has(c.filePath)) continue;
    seen.add(c.filePath);
    evidence.push({ path: c.filePath, label: evidenceLabel(c.reasons) });
    if (evidence.length >= MAX_EVIDENCE) return evidence;
  }
  return evidence;
}

function evidenceLabel(reasons: readonly string[]): string {
  if (reasons.includes("project manifest")) return "项目配置锚点";
  if (reasons.includes("project documentation")) return "项目文档锚点";
  if (reasons.includes("project entrypoint")) return "入口文件锚点";
  if (reasons.includes("content match")) return "内容命中锚点";
  if (reasons.includes("project test surface")) return "测试线索锚点";
  return "候选阅读锚点";
}

function buildReport(
  objective: string,
  queries: readonly string[],
  candidates: readonly Candidate[],
  evidence: readonly { path: string; line?: number; label: string }[],
  stats: { filesInspected: number; totalMatches: number; totalBytes: number; sensitiveSkipped: number; indexed: number; total: number },
): string {
  const lines: string[] = [
    `explore_repo: objective="${objective.slice(0, 80)}"`,
    `queries: ${queries.join(", ")}`,
    `indexed: ${stats.indexed}/${stats.total} files | inspected: ${stats.filesInspected} | matches: ${stats.totalMatches} | bytes: ${stats.totalBytes} | sensitive skipped: ${stats.sensitiveSkipped}`,
    "",
  ];

  if (evidence.length > 0) {
    lines.push("=== 证据锚点 ===");
    for (const e of evidence.slice(0, 8)) {
      lines.push(e.line ? `- ${e.path}:${e.line} — ${e.label}` : `- ${e.path} — ${e.label}`);
    }
    lines.push("");
  }

  if (candidates.length > 0) {
    lines.push("=== 候选文件（按相关度排序）===");
    for (const c of candidates.slice(0, 10)) {
      const symbols = c.symbols.map((s) => `${s.kind} ${s.name}`).slice(0, 5).join(", ");
      const matchInfo = c.matches.length > 0 ? ` | ${c.matches.length} 处命中` : "";
      lines.push(`${c.filePath} (score=${c.score}) [${c.reasons.join(", ")}]${symbols ? `: ${symbols}` : ""}${matchInfo}`);
    }
    const allMatches = candidates.flatMap((c) => [...c.matches]).slice(0, 5);
    if (allMatches.length > 0) {
      lines.push("", "=== 内容命中片段 ===");
      for (const m of allMatches) {
        lines.push(`${m.path}:${m.line} [${m.query}] ${m.snippet}`);
      }
    }
  } else {
    lines.push("（未找到匹配的候选文件）");
  }

  return lines.join("\n");
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
