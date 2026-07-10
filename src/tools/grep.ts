// Grep 工具:在工作区文件中搜索文本或正则,返回匹配行(文件:行号:内容)。
// 对应课程第 05 讲扩展工具:跨文件搜索原语。
//
// 双引擎策略:优先用 ripgrep(rg)获得工业级速度与正确性;
// 环境中未安装 rg 时自动降级为纯 Node.js 实现,保证零依赖可跑(CI / 沙箱无 rg 也能用)。
//
// 安全语义:与 ReadFileTool 一致,搜索路径经 safeResolve 锚定到工作区根,
// 不允许越界读取工作区之外的文件。

import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import { logger } from "../observability/logger.js";

/** 搜索结果默认上限,避免海量匹配撑爆 Context。 */
const DEFAULT_MAX_RESULTS = 50;
const MAX_RESULTS_LIMIT = 500;

/**
 * 递归遍历时跳过的目录:VCS、依赖、引擎自身配置、构建产物。
 * 与 SkillLoader 的 EXCLUDED_SKILL_DIRS 对齐,避免误入 node_modules 等巨型子树。
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".claw",
  "dist",
  "build",
  "__pycache__",
  ".cache",
  ".venv",
  "venv",
]);

/**
 * rg 可用性探测缓存。
 * - null:尚未探测
 * - true/false:首次探测后的结论,后续直接复用,避免每次搜索都 spawn 一次。
 *
 * 模块级变量在进程内常驻;测试通过 resetRgCache 可重置以模拟两种路径。
 */
let rgAvailable: boolean | null = null;

/** 重置 rg 可用性缓存(仅测试用,允许强制走降级路径)。 */
export function resetRgCache(): void {
  rgAvailable = null;
}

/**
 * 强制覆盖 rg 可用性结论(仅测试用)。
 * 传 false 强制走 Node.js 降级路径;传 true 强制走 rg 路径(要求环境中真有 rg)。
 */
export function setRgAvailable(value: boolean): void {
  rgAvailable = value;
}

/**
 * 探测当前环境中 ripgrep 是否可用且可执行。
 * 用 execFileSync("rg", ["--version"]) 探测:成功即可用,ENOENT 则不可用。
 * 其他异常(权限/超时等)保守视为不可用,降级到 Node.js。
 */
function detectRg(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** 解析 grep 工具入参,带类型校验。 */
function parseGrepArgs(args: string): {
  pattern: string;
  path: string;
  glob: string | undefined;
  caseSensitive: boolean;
  lineNumber: boolean;
  maxResults: number;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    throw new Error("参数解析失败:期望 JSON 对象");
  }
  if (typeof parsed["pattern"] !== "string") {
    throw new Error("grep 缺少 pattern 参数或 pattern 非字符串");
  }
  const pattern = parsed["pattern"];
  if (pattern.length === 0) {
    throw new Error("grep 缺少 pattern 参数");
  }
  const path = typeof parsed["path"] === "string" ? (parsed["path"] as string) : "";
  const glob = typeof parsed["glob"] === "string" ? (parsed["glob"] as string) : undefined;
  const caseSensitive = parsed["case_sensitive"] === true;
  const lineNumber = parsed["line_number"] !== false; // 默认 true
  const rawMax = parsed["max_results"];
  const maxResults =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(Math.floor(rawMax), MAX_RESULTS_LIMIT)
      : DEFAULT_MAX_RESULTS;
  return { pattern, path, glob, caseSensitive, lineNumber, maxResults };
}

/** 一条匹配的原始数据(未经格式化)。 */
interface RawMatch {
  /** 相对于工作区根的路径,用正斜杠(跨平台一致)。 */
  relPath: string;
  /** 行号(1-based)。 */
  lineNo: number;
  /** 命中行内容。 */
  content: string;
}

/**
 * 把一组匹配格式化为输出文本。
 * 有行号:`相对路径:行号:内容`;无行号:`相对路径:内容`。
 * 超过 maxResults 截断并附提示。无匹配返回固定提示。
 */
function formatMatches(matches: RawMatch[], maxResults: number, withLineNumber: boolean): string {
  if (matches.length === 0) {
    return "未找到匹配";
  }
  const truncated = matches.slice(0, maxResults);
  const lines = truncated.map((m) =>
    withLineNumber ? `${m.relPath}:${m.lineNo}:${m.content}` : `${m.relPath}:${m.content}`,
  );
  let out = lines.join("\n");
  if (matches.length > maxResults) {
    out += `\n...[匹配结果共 ${matches.length} 条,已截断至前 ${maxResults} 条；请缩小 path/glob/pattern 或降低 max_results]`;
  }
  return out;
}

/**
 * 把可能含正则元字符的 glob 模式(例如 .ts 后缀或前缀通配)
 * 转成匹配函数。支持单层星号、双星多层、问号单字符。
 * 这不是完整 minimatch,但覆盖最常见的后缀/前缀通配场景。
 */
function compileGlob(glob: string): (path: string) => boolean {
  // 把 glob 分段:每段里星号 / 双星 / 问号 转成正则片段,分隔符斜杠字面匹配。
  // 先转义正则元字符,再替换被保护占位符。
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // 双星 → 任意多层(含斜杠)
  const withDoubleStar = escaped.replace(/\*\*/g, "\u0000");
  // 单星 → 单层任意(不含斜杠)
  const withStar = withDoubleStar.replace(/\*/g, "[^/]*");
  // 问号 → 单字符(不含斜杠)
  const withQuestion = withStar.replace(/\?/g, "[^/]");
  // 占位符还原为通配
  const pattern = withQuestion.replaceAll("\u0000", ".*");
  const re = new RegExp(`^${pattern}$`);
  /**
   * 与 rg -g 行为对齐:不含斜杠的简单 glob(如 *.ts)匹配任意目录下的文件名;
   * 含斜杠的 glob(如 src/*.ts)按相对路径匹配。
   * 因此同时尝试 basename 与完整相对路径,任一命中即接受。
   */
  return (path: string) => {
    const norm = path.replace(/\\/g, "/");
    if (re.test(norm)) return true;
    const slashIdx = norm.lastIndexOf("/");
    const base = slashIdx === -1 ? norm : norm.slice(slashIdx + 1);
    return re.test(base);
  };
}

/**
 * 在 workDir 下递归收集所有可搜索文件的相对路径。
 * 跳过 EXCLUDED_DIRS 中的目录与符号链接环(不跟随符号链接,与 walkForSkillMd 不同 ——
 * grep 搜索全树成本敏感,跟随符号链接易引发环路与越界)。
 * glob 给定时按 basename 过滤。
 */
async function collectFiles(
  root: string,
  globFilter?: (relPath: string) => boolean,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 权限/竞态消失:静默跳过该子树
      if (isErrnoCode(err, "EACCES") || isErrnoCode(err, "ENOENT")) return;
      logger.warn({ err, dir }, "grep 扫描子目录失败,跳过");
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, join(dir, entry.name)).replace(/\\/g, "/");
      if (globFilter && !globFilter(rel)) continue;
      results.push(rel);
    }
  }

  await walk(root);
  // 稳定排序,保证输出可重现(便于测试断言)
  results.sort();
  return results;
}

/** 判断异常是否为指定 errno code */
function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * 调用 ripgrep 执行搜索。
 * 返回 rg 的 stdout 原始文本(已含 `路径:行号:内容` 格式)。
 * rg 搜索无命中时退出码 1 且 stdout 为空,本函数捕获该情况返回空串。
 */
function searchWithRg(opts: {
  pattern: string;
  searchRoot: string;
  glob: string | undefined;
  caseSensitive: boolean;
  lineNumber: boolean;
  maxResults: number;
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const args: string[] = ["--color=never", "--no-heading"];
    if (opts.lineNumber) args.push("--line-number");
    else args.push("--no-line-number");
    if (!opts.caseSensitive) args.push("--ignore-case");
    args.push("-e", opts.pattern);
    if (opts.glob) {
      args.push("-g", opts.glob);
    }
    // 限制匹配文件数与每文件行数不是 rg 的强项,这里靠后续截断 maxResults 控制
    args.push(opts.searchRoot);

    const child = execFile(
      "rg",
      args,
      {
        cwd: opts.searchRoot,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // rg 退出码:0 有匹配,1 无匹配,>1 真实错误
        if (err) {
          // ENOENT:rg 不存在(理论上探测阶段已挡,这里是双保险)
          if (err.code === "ENOENT") {
            reject(new Error("rg 未安装"));
            return;
          }
          // rg 的退出码体现在 err.code(数字)上。1 = 无匹配,返回空串而非报错
          if (err.code === 1) {
            resolvePromise("");
            return;
          }
          // 其他错误:把 stderr 带回,交上层降级
          const codeDesc =
            err.code !== undefined && err.code !== null ? String(err.code) : "unknown";
          reject(new Error(`rg 执行失败 (exit ${codeDesc}): ${stderr?.trim() ?? err.message}`));
          return;
        }
        resolvePromise(stdout ?? "");
      },
    );
    // 触发 unref,避免误判挂起(虽然 execFile 自带回调已足够)
    void child;
  });
}

/**
 * 把 rg 的原始 stdout 行解析成 RawMatch 列表。
 * rg 输出每行格式:`相对路径:行号:内容`(无 --line-number 时 `相对路径:内容`)。
 * 路径本身可能含冒号(Windows 盘符如 C:\...),故从左到右匹配第一个冒号(行号模式)
 * 或最后一个冒号前为路径(无行号模式)。rg 在 Windows 下输出用反斜杠路径,统一转正。
 */
function parseRgOutput(raw: string, lineNumber: boolean): RawMatch[] {
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (text.length === 0) return [];
  const matches: RawMatch[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (lineNumber) {
      // 格式 path:lineno:content —— 从左找第一个冒号后紧跟数字再冒号
      const m = line.match(/^(.*):(\d+):(.*)$/s);
      if (!m) continue;
      matches.push({
        relPath: m[1]!.replace(/\\/g, "/"),
        lineNo: Number(m[2]),
        content: m[3]!,
      });
    } else {
      // 格式 path:content —— 第一个冒号分割
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      matches.push({
        relPath: line.slice(0, idx).replace(/\\/g, "/"),
        lineNo: 0,
        content: line.slice(idx + 1),
      });
    }
  }
  return matches;
}

/**
 * 纯 Node.js 降级搜索:遍历目录树,逐文件读取后按行匹配。
 * pattern 默认按正则匹配(与 rg 一致);大小写不敏感时用 `i` flag。
 * 正则编译失败时退化为 String.includes 字面匹配,避免畸形 pattern 直接崩。
 */
async function searchWithNode(opts: {
  pattern: string;
  searchRoot: string;
  globFilter?: (relPath: string) => boolean;
  caseSensitive: boolean;
}): Promise<RawMatch[]> {
  const files = await collectFiles(opts.searchRoot, opts.globFilter);

  // 编译正则;失败则退化为字面匹配
  const regex = compileSearchPattern(opts.pattern, opts.caseSensitive);
  const literalNeedle = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();

  const matches: RawMatch[] = [];
  for (const rel of files) {
    const abs = join(opts.searchRoot, rel);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      // 二进制 / 权限 / 编码问题:静默跳过该文件
      if (isErrnoCode(err, "EACCES") || isErrnoCode(err, "ENOENT") || isErrnoCode(err, "EISDIR")) {
        continue;
      }
      logger.debug({ err, file: rel }, "grep 跳过不可读文件");
      continue;
    }

    // 统一用 LF 切行(CRLF 也兼容,内容本身不裁剪)
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let hit: boolean;
      if (regex) {
        hit = regex.test(line);
      } else {
        // 退化字面匹配
        hit = opts.caseSensitive
          ? line.includes(literalNeedle)
          : line.toLowerCase().includes(literalNeedle);
      }
      if (hit) {
        // 去掉行尾可能残留的 \r(CRLF 文件 split('\n') 后行尾带 \r)
        const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line;
        matches.push({ relPath: rel, lineNo: i + 1, content: cleaned });
      }
    }
  }
  return matches;
}

function compileSearchPattern(pattern: string, caseSensitive: boolean): RegExp | null {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    return null;
  }
}

export class GrepTool implements BaseTool {
  readonly readOnly = true;
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots =
      typeof workDirOrRoots === "string"
        ? WorkspaceRoots.createSync(workDirOrRoots)
        : workDirOrRoots;
  }

  name(): string {
    return "grep";
  }

  /** 只读搜索无副作用 —— 不与任何工具冲突 */
  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "grep",
      description:
        "在已授权工作区文件中搜索文本或正则,返回匹配行(格式:文件:行号:内容)。优先用 ripgrep 加速,未安装时降级为 Node.js 实现。",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "搜索模式(正则或字面文本)" },
          path: {
            type: "string",
            description: "搜索起始目录(相对工作区),默认工作区根。",
          },
          glob: {
            type: "string",
            description: "文件名 glob 过滤,如 *.ts(仅匹配该模式文件)。",
          },
          case_sensitive: {
            type: "boolean",
            description: "是否大小写敏感,默认 false(大小写不敏感)。",
          },
          line_number: {
            type: "boolean",
            description: "是否输出行号,默认 true。",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: MAX_RESULTS_LIMIT,
            description: `最多返回匹配条数,默认 ${DEFAULT_MAX_RESULTS}，最大 ${MAX_RESULTS_LIMIT}。`,
          },
        },
        required: ["pattern"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const { pattern, path, glob, caseSensitive, lineNumber, maxResults } = parseGrepArgs(args);

    // 路径防护:搜索根必须位于共享工作区根集合内
    const searchRoot = await this.roots.assertAllowed(path || ".");

    // 探测 rg(模块级缓存,只探测一次)
    if (rgAvailable === null) {
      rgAvailable = detectRg();
    }

    // 优先 rg 路径
    if (rgAvailable) {
      try {
        const raw = await searchWithRg({
          pattern,
          searchRoot,
          glob,
          caseSensitive,
          lineNumber,
          maxResults,
        });
        const matches = parseRgOutput(raw, lineNumber);
        return formatMatches(matches, maxResults, lineNumber);
      } catch (err) {
        // rg 路径异常 → 标记不可用,降级到 Node.js
        rgAvailable = false;
        logger.warn({ err }, "grep 的 rg 路径失败,降级到 Node.js 实现");
      }
    }

    // 降级 Node.js 路径
    const globFilter = glob ? compileGlob(glob) : undefined;
    const matches = await searchWithNode({
      pattern,
      searchRoot,
      globFilter,
      caseSensitive,
    });
    return formatMatches(matches, maxResults, lineNumber);
  }
}
