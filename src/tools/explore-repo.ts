/**
 * explore_repo：一次性有界仓库侦察工具。
 *
 * 确定性纯算法，零 LLM 调用。自己做 DFS 文件遍历（不依赖 repo_map 的渐进式索引），
 * 复用 repo_map 的 parseSymbols 解析符号，叠加项目结构启发式打分 + 行级内容匹配，
 * 一次调用返回：打分排序的候选文件（含符号清单）、行级证据锚点和可读文本报告。
 *
 * 与 repo_map 的区别：repo_map 按字母序渐进索引（适合多次调用建全量索引），
 * explore_repo 自己做 DFS 遍历（适合一次性侦察，不受字母序限制）。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, relative, basename, extname } from "node:path";
import {
  parseSymbols,
  SUPPORTED_EXTENSIONS,
  IGNORED_DIRECTORIES,
} from "../code-intelligence/repo-map.js";
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
const MAX_DISCOVERED_FILES = 250;

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

const TEXT_EXTENSIONS = new Set([
  ...SUPPORTED_EXTENSIONS,
  ".md", ".json", ".yaml", ".yml", ".toml", ".sh", ".bash",
  ".sql", ".html", ".css", ".scss", ".less", ".vue", ".svelte",
  ".xml", ".ini", ".cfg", ".conf", ".env.example", ".gitignore",
]);

const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i, /\.pem$/i, /\.key$/i, /\.p12$/i,
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

  constructor(private readonly rootDir: string, _service: unknown) {}

  name(): string {
    return "explore_repo";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "一次性有界仓库侦察。扫描文件名+符号+内容，返回打分排序的候选文件、行级证据锚点和符号清单。" +
        "适用于目标位置未知的探索；已知文件请直接 read_file。" +
        "大型仓库（>500文件）建议先用 glob 查看目录结构，再用 roots 参数缩小扫描范围。",
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
    const rootDirs = Array.isArray(input.roots)
      ? (input.roots as string[]).map(String)
      : ["."];
    const signal = context?.signal;

    // Step 1：DFS 文件遍历（自己的遍历，不受 repo_map 字母序限制）
    const discovered: string[] = [];
    for (const root of rootDirs.slice(0, 5)) {
      signal?.throwIfAborted();
      const absRoot = resolve(this.rootDir, root);
      await collectFiles(absRoot, discovered, signal);
      if (discovered.length >= MAX_DISCOVERED_FILES) break;
    }
    signal?.throwIfAborted();

    // Step 2：打分排序（项目结构 + 路径匹配 + 符号匹配）
    const candidates: Candidate[] = [];
    for (const absPath of discovered) {
      const relPath = relative(this.rootDir, absPath).replace(/\\/g, "/");
      const structural = scoreStructure(relPath);
      const pathMatch = scorePathQuery(relPath, queries);
      const totalScore = structural.score + pathMatch.score;
      candidates.push({
        filePath: relPath,
        symbols: [],
        score: totalScore,
        reasons: [...structural.reasons, ...pathMatch.reasons],
        matches: [],
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

    // Step 3：逐文件读取 + 符号解析 + 行级匹配（只对高分候选）
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

      // 符号解析（仅对代码文件）
      if (SUPPORTED_EXTENSIONS.has(extname(candidate.filePath))) {
        const lines = content.split(/\r?\n/);
        const symbols = parseSymbols(candidate.filePath, lines);
        candidate.symbols = symbols.map((s) => ({ kind: s.kind, name: s.name }));
      }

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
      filesDiscovered: discovered.length,
      filesInspected: filesInspected,
      totalMatches,
      totalBytes,
      sensitiveSkipped,
    });

    return report;
  }
}

// ============================================================
// 文件遍历（DFS，跳过噪声目录和符号链接）
// ============================================================

async function collectFiles(dir: string, output: string[], signal?: AbortSignal): Promise<void> {
  if (output.length >= MAX_DISCOVERED_FILES) return;
  signal?.throwIfAborted();

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // 按名称排序保证确定性
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= MAX_DISCOVERED_FILES) return;
    signal?.throwIfAborted();

    // 跳过符号链接（防穿越）
    if (entry.isSymbolicLink()) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await collectFiles(fullPath, output, signal);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      output.push(fullPath);
    }
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

/** 路径级 query 匹配：路径包含查询词时加分。 */
export function scorePathQuery(filePath: string, queries: readonly string[]): { score: number; reasons: string[] } {
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
  stats: { filesDiscovered: number; filesInspected: number; totalMatches: number; totalBytes: number; sensitiveSkipped: number },
): string {
  const lines: string[] = [
    `explore_repo: objective="${objective.slice(0, 80)}"`,
    `queries: ${queries.join(", ")}`,
    `discovered: ${stats.filesDiscovered} files | inspected: ${stats.filesInspected} | matches: ${stats.totalMatches} | bytes: ${stats.totalBytes} | sensitive skipped: ${stats.sensitiveSkipped}`,
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
