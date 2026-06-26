// Registry 默认实现 + 内置工具。
// 对应课程第 05 讲:registryImpl + read_file 工具。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  BaseTool,
  ExecutionMiddleware,
  MiddlewareFunc,
  Registry,
  RequestMiddleware,
} from "./registry.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";
import { logger } from "../observability/logger.js";
// 跨平台 shell:Windows 上统一走 Git Bash,避免 cmd.exe 不识别 POSIX 语义。
import { execAsync, execOptions } from "../os/shell.js";

const DEFAULT_RESULT_SIZE_CHARS = 8000;

export interface ToolRegistryOptions {
  defaultResultSizeChars?: number;
  truncateResults?: boolean;
}

/**
 * 路径安全检查:确保路径在 workDir 之内,防路径穿越。
 * 返回规范化的绝对路径;越界则抛错。
 */
function safeResolve(workDir: string, path: string): string {
  const base = resolve(workDir);
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界: '${path}' 不在工作区 ${base} 之内`);
  }
  return fullPath;
}

/**
 * registryImpl:Registry 接口的默认实现。
 * 用 map 以工具 name 为 key 做 O(1) 路由查找。
 * 像忠实的前台总机:接线(收 ToolCall)→ 查黄页(map)→ 转接(Execute)。
 */
export class ToolRegistry implements Registry {
  private readonly tools = new Map<string, BaseTool>();
  private readonly defaultResultSizeChars: number;
  private readonly truncateResults: boolean;
  /** 第 16 讲:全局挂载的安全拦截中间件链 */
  private readonly requestMiddlewares: RequestMiddleware[] = [];
  private readonly executionMiddlewares: ExecutionMiddleware[] = [];

  constructor(opts: ToolRegistryOptions = {}) {
    this.defaultResultSizeChars = opts.defaultResultSizeChars ?? DEFAULT_RESULT_SIZE_CHARS;
    this.truncateResults = opts.truncateResults ?? true;
  }

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      logger.warn({ tool: name }, `[Warning] 工具 '${name}' 已被注册,将被覆盖。`);
    }
    this.tools.set(name, tool);
    logger.info({ tool: name }, `[Registry] 成功挂载工具: ${name}`);
  }

  /** 挂载一个安全拦截中间件 (第 16 讲) */
  use(mw: MiddlewareFunc): void {
    this.useRequest(mw);
  }

  useRequest(mw: RequestMiddleware): void {
    this.requestMiddlewares.push(mw);
    logger.info(
      { count: this.requestMiddlewares.length },
      `[Registry] 已挂载 Request Middleware (共 ${this.requestMiddlewares.length} 个)`,
    );
  }

  useExecution(mw: ExecutionMiddleware): void {
    this.executionMiddlewares.push(mw);
    logger.info(
      { count: this.executionMiddlewares.length },
      `[Registry] 已挂载 Execution Middleware (共 ${this.executionMiddlewares.length} 个)`,
    );
  }

  getAvailableTools(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition());
  }

  /** 判断工具是否只读 (默认 false,保守视为写操作) */
  isReadOnlyTool(name: string): boolean {
    return this.tools.get(name)?.readOnly ?? false;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    // 1. 路由查找:找不到说明模型幻觉,返回 isError 让模型自纠
    let currentCall = call;
    const tool = this.tools.get(currentCall.name);
    if (!tool) {
      return {
        toolCallId: currentCall.id,
        output: `Error: 系统中不存在名为 '${currentCall.name}' 的工具。`,
        isError: true,
      };
    }

    // 2. 【核心防御】第 16 讲:在执行底层逻辑前,依次运行所有 Middleware。
    //    任一中间件返回 allowed=false,工具的底层 execute 就绝对不会被触发。
    //    异步签名以支持人工审批挂起 (Human-in-the-loop)。
    for (const mw of this.requestMiddlewares) {
      const { allowed, reason, call: rewrittenCall } = await mw(currentCall);
      if (!allowed) {
        logger.warn(
          { tool: currentCall.name, reason },
          `[Registry] ⚠ 工具 ${currentCall.name} 被 Middleware 拦截: ${reason}`,
        );
        return {
          toolCallId: currentCall.id,
          output: `执行被系统拦截。原因: ${reason}`,
          isError: true, // 必须返回 Error,强制大模型阅读拒绝理由
        };
      }
      if (rewrittenCall) {
        currentCall = rewrittenCall;
      }
    }

    // 3. 执行工具逻辑:所有 Middleware 都放行了
    try {
      let chain: (nextCall: ToolCall) => Promise<string> = async (nextCall) =>
        tool.execute(nextCall.arguments);
      for (let i = this.executionMiddlewares.length - 1; i >= 0; i--) {
        const mw = this.executionMiddlewares[i]!;
        const next = chain;
        chain = (nextCall) => mw(nextCall, next);
      }
      const output = await chain(currentCall);
      const finalOutput = this.truncateResults
        ? truncateToolOutput(output, tool.maxResultSizeChars ?? this.defaultResultSizeChars)
        : output;
      return {
        toolCallId: currentCall.id,
        output: finalOutput,
        isError: false,
      };
    } catch (err) {
      // 4. 封装:底层物理错误也封成 isError 的 ToolResult
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: currentCall.id,
        output: `Error executing ${currentCall.name}: ${errMsg}`,
        isError: true,
      };
    }
  }
}

function truncateToolOutput(output: string, limit: number): string {
  if (output.length <= limit) {
    return output;
  }
  return `${output.slice(0, limit)}\n\n...[工具输出过长,已截断至前 ${limit} 字符]...`;
}

// ==========================================
// 内置工具 1:EchoTool (验证用,第 04 讲遗留)
// ==========================================
export class EchoTool implements BaseTool {
  readonly readOnly = true;
  name(): string {
    return "echo";
  }
  definition(): ToolDefinition {
    return {
      name: "echo",
      description: "原样回显输入的文本。用于验证工具调用链路是否打通。",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "要回显的文本" } },
        required: ["text"],
      },
    };
  }
  async execute(args: string): Promise<string> {
    let text: string;
    try {
      const input = JSON.parse(args) as { text?: string };
      text = input.text ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 text 字段");
    }
    return `echo: ${text}`;
  }
}

// ==========================================
// 内置工具 2:ReadFileTool (第 05 讲核心)
// 防御底线:WorkDir 边界限制 + 路径穿越防护 + 长度截断保护
// ==========================================

/** 读取文件的最大字节数,防止超大文件撑爆 Context (OOM) */
const READ_FILE_MAX_BYTES = 8000;

export class ReadFileTool implements BaseTool {
  readonly readOnly = true;
  constructor(private readonly workDir: string) {}

  name(): string {
    return "read_file";
  }

  definition(): ToolDefinition {
    return {
      name: "read_file",
      description: "读取指定路径的文件内容。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径,如 src/cli/main.ts" },
        },
        required: ["path"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let path: string;
    try {
      const input = JSON.parse(args) as { path?: string };
      path = input.path ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path 字段");
    }

    // 2. 路径穿越防护:确保最终路径在 workDir 之内
    const fullPath = safeResolve(this.workDir, path);

    // 3. 物理 IO
    const content = await readFile(fullPath, "utf8");

    // 4. 【核心防线】长度截断保护
    // 绝不把系统安全寄希望于大模型理智,底层工具强制兜底。
    // Token 是金钱,Context 是生命线。
    if (content.length > READ_FILE_MAX_BYTES) {
      return (
        content.slice(0, READ_FILE_MAX_BYTES) +
        `\n\n...[由于内容过长,已被系统截断至前 ${READ_FILE_MAX_BYTES} 字节]`
      );
    }
    return content;
  }
}

// ==========================================
// 内置工具 3:WriteFileTool (第 06 讲)
// 极简工具集原语之一:创建或覆盖文件。
// ==========================================
export class WriteFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "write_file";
  }

  definition(): ToolDefinition {
    return {
      name: "write_file",
      description: "创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件路径,如 src/main.ts" },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let content: string;
    try {
      const input = JSON.parse(args) as { path?: string; content?: string };
      path = input.path ?? "";
      content = input.content ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path 和 content 字段");
    }

    // 安全防线:限制在 WorkDir 下
    const fullPath = safeResolve(this.workDir, path);

    // 自动创建缺失的父级目录
    await mkdir(resolve(fullPath, ".."), { recursive: true });

    // 写入文件,权限 0644
    await writeFile(fullPath, content, "utf8");

    return `成功将内容写入到文件: ${path}`;
  }
}

// ==========================================
// 内置工具 4:BashTool (第 06 讲,YOLO 哲学核心)
// 极简工具集原语之一:执行任意 Shell 命令。
// 4 条驾驭底线:超时控制、工作区绑定、错误原样回传、长度截断。
// ==========================================

/** bash 命令最大执行时间,防止卡死进程 (如 top / 常驻服务) */
const BASH_TIMEOUT_MS = 30_000;
/** bash 输出截断长度,防 OOM */
const BASH_MAX_BYTES = 8000;

export class BashTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "bash";
  }

  definition(): ToolDefinition {
    return {
      name: "bash",
      description:
        "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)、管道和环境变量。返回标准输出与错误的合并结果。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令,例如: ls -la 或 npm test" },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let command: string;
    try {
      const input = JSON.parse(args) as { command?: string };
      command = input.command ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 command 字段");
    }

    // 驾驭底线 1+2:超时控制 + 工作区绑定
    // 注意:命令执行失败时绝不抛异常,而是原样回传(底线 3),交给模型自纠。
    let stdout: string;
    let timedOut = false;
    try {
      const { stdout: out } = await execAsync(
        command,
        execOptions({
          cwd: this.workDir,
          maxBuffer: 1024 * 1024,
          timeout: BASH_TIMEOUT_MS,
        }),
      );
      stdout = out;
    } catch (err) {
      const e = err as {
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // 判断是否超时
      if (e.killed && e.signal === "SIGTERM") {
        timedOut = true;
      }
      // 合并 stdout/stderr,原样回传让模型分析
      const parts = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean);
      stdout = parts.length > 0 ? parts.join("\n") : `执行报错: ${e.message ?? String(err)}`;
    }

    if (timedOut) {
      stdout += `\n[警告: 命令执行超时(${BASH_TIMEOUT_MS / 1000}s),已被系统强制终止。如果是启动常驻服务,请改用后台运行方式。]`;
    }

    // 空输出给明确成功反馈
    if (!stdout.trim()) {
      return "命令执行成功,无终端输出。";
    }

    // 驾驭底线 4:长度截断保护
    if (stdout.length > BASH_MAX_BYTES) {
      return (
        stdout.slice(0, BASH_MAX_BYTES) +
        `\n\n...[终端输出过长,已截断至前 ${BASH_MAX_BYTES} 字节]...`
      );
    }

    return stdout;
  }
}

// ==========================================
// 内置工具 5:EditFileTool (第 07 讲)
// 极简工具集原语之一:外科手术式局部替换。
// 核心:多级模糊匹配链,吸收大模型的"缩进幻觉"格式误差。
// ==========================================

/**
 * 多级模糊匹配链 (Chain of Responsibility):四级容错降级替换。
 * L1 精确匹配 → L2 换行符归一化 → L3 Trim 首尾空白 → L4 逐行去缩进。
 * 安全底线:匹配结果 > 1 时拒绝替换,要求模型提供更多上下文。
 */
function fuzzyReplace(
  originalContent: string,
  oldText: string,
  newText: string,
): { content: string; level: number } {
  // L1: 精确匹配
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount === 1) {
    return { content: originalContent.replace(oldText, newText), level: 1 };
  }
  if (exactCount > 1) {
    throw new Error(`old_text 精确匹配到了 ${exactCount} 处,请提供更多的上下文代码以确保唯一性`);
  }

  // L2: 换行符归一化 (\r\n → \n)
  const normalizedContent = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  const l2Count = countOccurrences(normalizedContent, normalizedOld);
  if (l2Count === 1) {
    return { content: normalizedContent.replace(normalizedOld, newText), level: 2 };
  }

  // L3: Trim Space 匹配 (忽略首尾空行和空格)
  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== "") {
    const l3Count = countOccurrences(normalizedContent, trimmedOld);
    if (l3Count === 1) {
      return { content: normalizedContent.replace(trimmedOld, newText), level: 3 };
    }
  }

  // L4: 逐行去缩进匹配 (最强容错,消除模型遗漏缩进的幻觉)
  return { content: lineByLineReplace(normalizedContent, normalizedOld, newText), level: 4 };
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

/** L4: 按行切割,去除每行首尾空白后滑动窗口匹配 */
function lineByLineReplace(content: string, oldText: string, newText: string): string {
  const contentLines = content.split("\n");
  const oldLines = oldText
    .trim()
    .split("\n")
    .map((l) => l.trim());

  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段");
  }

  let matchCount = 0;
  let matchStart = -1;
  // 滑动窗口在原文件中寻找匹配块
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trim() !== oldLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      matchCount++;
      matchStart = i;
    }
  }

  if (matchCount === 0) {
    throw new Error("在文件中未找到 old_text,请先调用 read_file 仔细确认要替换的内容");
  }
  if (matchCount > 1) {
    throw new Error(`模糊匹配到了 ${matchCount} 处相似代码,请提供更多上下文行代码以精确定位`);
  }

  const matchEnd = matchStart + oldLines.length;
  // 将匹配到的原始行范围替换为 newText
  return [...contentLines.slice(0, matchStart), newText, ...contentLines.slice(matchEnd)].join(
    "\n",
  );
}

export class EditFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "edit_file";
  }

  definition(): ToolDefinition {
    return {
      name: "edit_file",
      description:
        "对现有文件进行局部的字符串替换。比重写整个文件更安全、更快速。请提供足够的上下文(建议上下各多包含几行)以确保 old_text 在文件中唯一。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要修改的文件路径" },
          old_text: {
            type: "string",
            description: "文件中原有的文本。必须包含足够的上下文以确保唯一匹配。",
          },
          new_text: { type: "string", description: "要替换成的新文本" },
        },
        required: ["path", "old_text", "new_text"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let oldText: string;
    let newText: string;
    try {
      const input = JSON.parse(args) as { path?: string; old_text?: string; new_text?: string };
      path = input.path ?? "";
      oldText = input.old_text ?? "";
      newText = input.new_text ?? "";
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path、old_text、new_text 字段");
    }

    const fullPath = safeResolve(this.workDir, path);

    // 1. 读取原文件
    const originalContent = await readFile(fullPath, "utf8");

    // 2. 多级模糊替换
    const { content: newContent, level } = fuzzyReplace(originalContent, oldText, newText);

    // 3. 写回磁盘
    await writeFile(fullPath, newContent, "utf8");

    return `✅ 成功修改文件: ${path} (匹配级别 L${level})`;
  }
}
