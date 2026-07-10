// Glob 文件匹配工具。
// 按 glob 模式递归匹配工作区文件路径,返回相对路径列表。
//
// 工具放独立文件(对齐 SkillViewTool 跨文件定义模式):
// registry-impl.ts 不 import 本工具,消费者(default-registry.ts)在合并阶段统一挂载。
//
// 设计取舍:
//   - 纯只读工具,accesses 声明 none():只产出路径清单,不触碰任何文件内容,
//     与 read_file/write_file/bash 等一切工具都不冲突,可放心并行。
//   - glob→RegExp 自实现,不引入新依赖(minimatch 等)。
//   - 递归遍历显式跳过 node_modules/.git/.claw 等巨型与敏感目录。

import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import type { Dirent } from "node:fs";
import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { WorkspaceRoots } from "./workspace-roots.js";

// 递归遍历时跳过的目录:VCS、依赖、构建产物、引擎自有目录。
// 与 skill.ts 的 EXCLUDED_SKILL_DIRS 对齐,避免误入 node_modules 等巨型子树。
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".claw",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

// 结果输出上限:超过即截断并提示总数,避免撑爆模型上下文。
const MAX_RESULTS = 100;

/**
 * GlobTool:按 glob 模式匹配文件路径,返回相对路径列表。
 *
 * 支持的 glob 语法:
 *   - 双星号:匹配任意层级目录(含零层),如 src/ 双星 / *.ts
 *   - 单星号:匹配单层任意字符(不含路径分隔符),如 src/ *.ts
 *   - 问号:匹配单个字符
 *   - [abc] / [a-z] 字符集
 *   - {ts,js} 花括号展开(多选一)
 *   - 点号:字面量
 */
export class GlobTool implements BaseTool {
  readonly readOnly = true;
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots =
      typeof workDirOrRoots === "string"
        ? WorkspaceRoots.createSync(workDirOrRoots)
        : workDirOrRoots;
  }

  name(): string {
    return "glob";
  }

  definition(): ToolDefinition {
    return {
      name: "glob",
      description: "在已授权工作区内按 glob 模式匹配文件路径,返回相对路径列表(如 **/*.ts)。",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "glob 匹配模式,如 **/*.ts、src/**/*.test.ts",
          },
          path: {
            type: "string",
            description: "搜索起始目录(相对工作区,默认为工作区根)",
          },
        },
        required: ["pattern"],
      },
    };
  }

  /** 纯只读、不触碰文件内容:与一切工具都不冲突。 */
  accesses(): ToolAccesses {
    return ToolAccesses.none();
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let pattern: string;
    let basePath: string;
    try {
      const input = JSON.parse(args) as { pattern?: string; path?: string };
      pattern = input.pattern ?? "";
      basePath = input.path ?? ".";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 pattern 字段");
    }

    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error("参数解析失败: pattern 必须是非空字符串");
    }

    // 2. 路径穿越防护:搜索根必须位于共享工作区根集合内
    const root = await this.roots.assertAllowed(basePath);

    // 3. glob → RegExp(花括号展开为多个分支,合并为单一正则)
    const matcher = globToRegExp(pattern);

    // 4. 递归遍历收集相对路径
    const matches: string[] = [];
    await collect(root, root, matcher, matches);

    // 5. 无匹配提示
    if (matches.length === 0) {
      return "未找到匹配文件";
    }

    // 6. 排序
    matches.sort();

    // 7. 输出截断
    let output = matches.slice(0, MAX_RESULTS).join("\n");
    if (matches.length > MAX_RESULTS) {
      output += `\n... (共 ${matches.length} 条,已截断至前 ${MAX_RESULTS} 条；请缩小 pattern 或 path 后重试)`;
    }
    return output;
  }
}

/**
 * 递归遍历目录树,收集匹配 glob 正则的文件相对路径。
 * 跳过 IGNORED_DIRS;相对路径统一用正斜杠,跨平台一致。
 */
async function collect(dir: string, root: string, matcher: RegExp, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 权限不足或竞态消失:静默跳过该子树
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await collect(join(dir, entry.name), root, matcher, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const rel = relative(root, join(dir, entry.name)).replaceAll("\\", "/");
    if (matcher.test(rel)) {
      out.push(rel);
    }
  }
}

/** 极简 path.join(避免引入 node:path 的 join 与上面 relative 混用差异)。 */
function join(a: string, b: string): string {
  if (a === "") return b;
  if (a.endsWith("/") || a.endsWith("\\")) return a + b;
  return a + "/" + b;
}

/**
 * 把 glob 模式编译为 RegExp。
 *
 * 先展开花括号 `{ts,js}` 得到多个分支模式,各自转为正则源,
 * 再用 `(?:a|b)` 合并为单一锚定正则 `^(?:...)$`。
 *
 * 支持的语义:
 *   - 双星号 跨任意层级目录(含零层):a/ 双星 / *.ts 既匹配 a/x.ts 也匹配 a/p/q.ts
 *   - 单星号 单层任意字符(不含 /):a/ *.ts 只匹配 a/x.ts
 *   - `?`  单个字符(不含 `/`)
 *   - `[abc]` / `[a-z]` 字符集
 *   - `.` 字面量
 *
 * exported 便于单元测试。
 */
export function globToRegExp(pattern: string): RegExp {
  const branches = expandBraces(pattern);
  const sources = branches.map(branchToRegexSource);
  return new RegExp(`^(?:${sources.join("|")})$`);
}

/**
 * 展开花括号:`{a,b}` → 多个分支。支持多组与嵌套。
 * 例如 `x{a,b}y{c,d}z` → `xaycz, xaydz, xbycz, xbydz`。
 */
export function expandBraces(pattern: string): string[] {
  // 找到第一个顶层 {...} 组
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          const before = pattern.slice(0, start);
          const inner = pattern.slice(start + 1, i);
          const after = pattern.slice(i + 1);
          const options = splitTopLevelComma(inner);
          const out: string[] = [];
          for (const opt of options) {
            // 组合后递归展开,以处理 opt 内嵌套花括号与 after 中的后续组
            for (const comb of expandBraces(before + opt + after)) {
              out.push(comb);
            }
          }
          return out;
        }
      }
    }
  }
  // 无花括号
  return [pattern];
}

/** 按顶层逗号分割(不分割花括号内的逗号),如 `a,b` → [a,b],`a,{b,c}` → [a,{b,c}]。 */
function splitTopLevelComma(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "{") {
      depth++;
      buf += ch;
    } else if (ch === "}") {
      depth--;
      buf += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

/**
 * 单个分支(无花括号)转正则源。按 / 分段处理 双星 与 单星 的层级语义差异。
 */
function branchToRegexSource(branch: string): string {
  const segments = branch.split("/");
  let re = "";
  const last = segments.length - 1;
  for (const [i, seg] of segments.entries()) {
    const isLast = i === last;

    if (seg === "**") {
      // ** 匹配任意层级目录(含零层)。
      // 末尾段:** 匹配任意内容(含跨 /)。
      // 中间段:**/ 表示零个或多个目录前缀 + 分隔符。
      if (isLast) {
        re += ".*";
      } else {
        re += "(?:.*/)?";
      }
      continue;
    }

    // 普通段:逐字符转换 *, ?, [], .
    re += convertSegment(seg);

    // 段间补回分隔符 /(允许空段直接吃掉,不影响匹配)
    if (!isLast) re += "/";
  }
  return re;
}

/**
 * 单段(不含 /)glob 转 regex:只处理 *, ?, [..], 转义其他正则元字符。
 */
function convertSegment(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg.charAt(i);
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      // 字符集:复制到匹配的 ]。支持取反 ^ 与范围 -。
      const end = seg.indexOf("]", i + 1);
      if (end === -1) {
        // 未闭合的 [ 当字面量
        out += "\\[";
      } else {
        out += seg.slice(i, end + 1);
        i = end;
      }
    } else if (isRegexSpecial(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 需要转义的正则元字符(. + 在字符集外需转义)。 */
function isRegexSpecial(ch: string): boolean {
  return ".+()|^$\\{}".includes(ch);
}
