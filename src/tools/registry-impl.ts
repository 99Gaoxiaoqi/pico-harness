// Registry 默认实现 + 内置工具。
// 对应课程第 05 讲:registryImpl + read_file 工具。

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
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
import { ToolAccesses } from "./tool-access.js";
import { toModelTextView, materializeModelText, makeCarriageReturnsVisible } from "./line-endings.js";
import { findClosestLines, formatCandidateHint } from "./edit-hint.js";
// 跨平台 shell:Windows 上统一走 Git Bash,避免 cmd.exe 不识别 POSIX 语义。
import { execAsync, execOptions } from "../os/shell.js";
import { BackgroundManager } from "./background-manager.js";

const DEFAULT_RESULT_SIZE_CHARS = 8000;

export interface ToolRegistryOptions {
  defaultResultSizeChars?: number;
  truncateResults?: boolean;
}

/**
 * 路径安全检查:确保路径在 workDir 之内,防路径穿越。
 * 返回规范化的绝对路径;越界则抛错。
 */
export function safeResolve(workDir: string, path: string): string {
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
  private preWriteHook?: (toolName: string, args: string) => Promise<void>;

  constructor(opts: ToolRegistryOptions = {}) {
    this.defaultResultSizeChars = opts.defaultResultSizeChars ?? DEFAULT_RESULT_SIZE_CHARS;
    this.truncateResults = opts.truncateResults ?? true;
  }

  setPreWriteHook(hook: (toolName: string, args: string) => Promise<void>): void {
    this.preWriteHook = hook;
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

  /**
   * 按名称获取已注册的工具实例(可能为 undefined)。
   * 供 host 注入运行时依赖(如 ExitPlanModeTool 的 onExit 回调),
   * 工具实例本身的修改不影响 registry 路由。
   */
  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /** 判断工具是否只读 (默认 false,保守视为写操作) */
  isReadOnlyTool(name: string): boolean {
    return this.tools.get(name)?.readOnly ?? false;
  }

  /**
   * 按 ToolCall 计算资源访问集(资源冲突图调度用)。
   * 委托给工具自报的 accesses() 方法;工具未实现或参数解析失败时,
   * 保守返回 ToolAccesses.all()(全局互斥),宁可损失并发不可错判冲突。
   */
  getAccesses(call: ToolCall): ToolAccesses {
    const tool = this.tools.get(call.name);
    if (!tool?.accesses) return ToolAccesses.all();
    try {
      return tool.accesses(call.arguments);
    } catch (err) {
      logger.warn({ tool: call.name, err }, `[Registry] accesses 声明失败,降级为 all() 保守`);
      return ToolAccesses.all();
    }
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
    if (this.preWriteHook) {
      try {
        await this.preWriteHook(currentCall.name, currentCall.arguments);
      } catch (err) {
        logger.warn(
          { err: String(err), tool: currentCall.name },
          `[Registry] preWriteHook 失败,继续执行工具 ${currentCall.name}`,
        );
      }
    }
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
  /** 原样回显,无任何副作用 —— 不与任何工具冲突 */
  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
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

/** 读取文件的最大字节数,防止超大文件撑爆 Context (OOM)。
 *  加行号前缀后同样信息量字节数增加,阈值从 8000 放宽到 12000。 */
const READ_FILE_MAX_BYTES = 12000;

/** 行尾风格 → 展示标签(供状态行输出,帮模型识别文件格式) */
function lineEndingStyleLabel(style: "lf" | "crlf" | "mixed"): string {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "MIXED";
  return "LF";
}

export class ReadFileTool implements BaseTool {
  readonly readOnly = true;
  constructor(private readonly workDir: string) {}

  name(): string {
    return "read_file";
  }

  /** 声明读 path 归一化后的绝对路径(与 execute 的 safeResolve 一致) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readFile(safeResolve(this.workDir, path ?? ""));
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
    const raw = await readFile(fullPath, "utf8");

    // 4. 模型视图归一化:纯 CRLF → LF(模型只处理一种行尾,Edit 匹配才稳定);
    //    lf/mixed 原样返回,并记录原始行尾风格供 Edit 写回还原。
    const { text, lineEndingStyle } = toModelTextView(raw);

    // 5. 空文件:只返回状态行,不输出空行号
    if (text.length === 0) {
      return `共 0 行,行尾: ${lineEndingStyleLabel(lineEndingStyle)}`;
    }

    // 6. 按行分割并加行号前缀(对齐 kimi-code renderLine: "行号\t内容",行号从 1 开始)。
    //    末尾换行不产生空行号:先剥掉尾部 \n 再 split。
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const renderedLines = lines.map((line, i) => {
      // mixed 行尾:每行 \r 显形为字面 "\r",提醒模型该文件含杂散 CR,Edit 匹配可能失败。
      const content =
        lineEndingStyle === "mixed" ? makeCarriageReturnsVisible(line) : line;
      return `${i + 1}\t${content}`;
    });
    let output = renderedLines.join("\n");

    // 7. 【核心防线】长度截断保护(作用于渲染后文本)。
    //    绝不把系统安全寄希望于大模型理智,底层工具强制兜底。
    //    Token 是金钱,Context 是生命线。
    if (output.length > READ_FILE_MAX_BYTES) {
      output =
        output.slice(0, READ_FILE_MAX_BYTES) +
        `\n\n...[由于内容过长,已被系统截断至前 ${READ_FILE_MAX_BYTES} 字节]`;
    }

    // 8. 末尾状态行:帮助模型了解文件行数与行尾格式
    output += `\n共 ${lines.length} 行,行尾: ${lineEndingStyleLabel(lineEndingStyle)}`;
    return output;
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

  /** 声明写 path 归一化后的绝对路径 —— 不同文件的写可并行 */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.writeFile(safeResolve(this.workDir, path ?? ""));
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

    // 检查是新建还是覆盖
    let isNewFile = false;
    try {
      await stat(fullPath);
    } catch {
      isNewFile = true; // 文件不存在 → 新建
    }

    // 写入文件
    await writeFile(fullPath, content, "utf8");

    const action = isNewFile ? "新建" : "覆盖";
    const sizeInfo = `(${content.length} 字符)`;
    return `✅ ${action}文件: ${path} ${sizeInfo}`;
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
const REDIRECT_RE = /(?:>>|>)\s*(\S+)/g;

export function extractBashRedirectTargets(workDir: string, command: string): string[] {
  const targets: string[] = [];
  REDIRECT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REDIRECT_RE.exec(command)) !== null) {
    const target = match[1]!.replace(/[;|&]+$/u, "");
    if (target) targets.push(safeResolve(workDir, target));
  }
  return targets;
}

export class BashTool implements BaseTool {
  constructor(
    private readonly workDir: string,
    private readonly backgroundManager = new BackgroundManager(),
    private readonly options: { allowBackground?: boolean } = {},
  ) {}

  name(): string {
    return "bash";
  }

  /**
   * bash 命令是任意 shell 文本,无法静态分析出访问哪些文件。
   * 保守策略:声明全资源互斥(kind:"all"),与同批次任何工具都串行。
   * 宁可损失并发,不可错判冲突。
   */
  accesses(): ToolAccesses {
    return ToolAccesses.all();
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
          background: {
            type: "boolean",
            description: "为 true 时后台启动命令并立即返回 taskId/pid/status,不等待命令结束。",
          },
        },
        required: ["command"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let command: string;
    let background = false;
    try {
      const input = JSON.parse(args) as { command?: string; background?: boolean };
      command = input.command ?? "";
      background = input.background === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 command 字段");
    }

    if (background) {
      if (this.options.allowBackground === false) {
        throw new Error("当前 bash 工具不允许后台执行");
      }
      const task = this.backgroundManager.start(command, this.workDir);
      return JSON.stringify({
        taskId: task.taskId,
        pid: task.pid,
        status: task.status,
        command: task.command,
        cwd: task.cwd,
        startedAt: task.startedAt.toISOString(),
      });
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
// 内置工具 4.5:后台任务控制工具
// ==========================================

export class TaskListTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_list";
  }

  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "task_list",
      description: "列出当前会话中由 bash background=true 启动的后台任务。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };
  }

  async execute(_args: string): Promise<string> {
    return JSON.stringify(
      this.backgroundManager.list().map((task) => ({
        ...task,
        startedAt: task.startedAt.toISOString(),
        endedAt: task.endedAt?.toISOString() ?? null,
      })),
    );
  }
}

export class TaskOutputTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_output";
  }

  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "task_output",
      description: "读取指定后台任务的 stdout/stderr 环形缓冲输出。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 ID。" },
          tail: { type: "number", description: "可选,只返回 stdout/stderr 末尾 N 个字符。" },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseTaskIdArgs(args);
    return JSON.stringify(this.backgroundManager.output(input.taskId, input.tail));
  }
}

export class TaskStopTool implements BaseTool {
  readonly readOnly = false;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_stop";
  }

  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.all();
  }

  definition(): ToolDefinition {
    return {
      name: "task_stop",
      description: "停止指定后台任务。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 ID。" },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseTaskIdArgs(args);
    const task = await this.backgroundManager.stop(input.taskId);
    return JSON.stringify({
      ...task,
      startedAt: task.startedAt.toISOString(),
      endedAt: task.endedAt?.toISOString() ?? null,
    });
  }
}

function parseTaskIdArgs(args: string): { taskId: string; tail?: number } {
  try {
    const input = JSON.parse(args) as { taskId?: string; tail?: number };
    if (!input.taskId) {
      throw new Error("缺少 taskId 字段");
    }
    return {
      taskId: input.taskId,
      ...(input.tail !== undefined ? { tail: input.tail } : {}),
    };
  } catch (err) {
    if (err instanceof Error && err.message === "缺少 taskId 字段") {
      throw err;
    }
    throw new Error("参数解析失败: 期望 JSON 含 taskId 字段");
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
  replaceAll?: boolean,
): { content: string; level: number } {
  // L1: 精确匹配
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount >= 1) {
    if (exactCount === 1 || replaceAll) {
      // split/join 全替换:replaceAll 时换所有,单处时也只换一处(等价)
      return { content: originalContent.split(oldText).join(newText), level: 1 };
    }
    throw new Error(`old_text 精确匹配到了 ${exactCount} 处,请提供更多的上下文代码以确保唯一性`);
  }

  // L2: 换行符归一化 (\r\n → \n)
  const normalizedContent = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  const l2Count = countOccurrences(normalizedContent, normalizedOld);
  if (l2Count >= 1) {
    if (l2Count === 1 || replaceAll) {
      return { content: normalizedContent.split(normalizedOld).join(newText), level: 2 };
    }
  }

  // L3: Trim Space 匹配 (忽略首尾空行和空格)
  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== "") {
    const l3Count = countOccurrences(normalizedContent, trimmedOld);
    if (l3Count >= 1) {
      if (l3Count === 1 || replaceAll) {
        return { content: normalizedContent.split(trimmedOld).join(newText), level: 3 };
      }
    }
  }

  // L4: 逐行去缩进匹配 (最强容错,消除模型遗漏缩进的幻觉)
  return { content: lineByLineReplace(normalizedContent, normalizedOld, newText, replaceAll), level: 4 };
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

/** 取行首空白前缀 (空格/制表符) */
function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i++;
  }
  return line.slice(0, i);
}

/** 取文本中第一个非空行 (含原始缩进);全空白返回 null */
function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim()) return line;
  }
  return null;
}

/**
 * L4 缩进重对齐 (对标 hermes _reindent_replacement)。
 * 非精确匹配命中后,模型 old_text/new_text 的缩进可能与文件实际缩进不一致
 * (如模型用 2 空格、文件用 4 空格)。直接写 new_text 会破坏文件缩进风格。
 *
 * 策略:以 old_text 第一个非空行的缩进为"模型基准缩进",
 *      以 fileRegion(文件中匹配到的实际区域)第一个非空行的缩进为"文件基准缩进"。
 * 两者相同 → 无需调整,原样返回 new_text。
 * 两者不同 → 遍历 new_text 每行:
 *   - 空行:保留原样(含纯空白行)
 *   - 行缩进以模型基准开头:替换基准前缀为文件基准前缀,保留额外嵌套
 *     (fileBaseIndent + line.slice(llmBaseIndent.length))
 *   - 行缩进不以模型基准开头(dedent 行):锚定到文件基准
 *     (fileBaseIndent + line 去首空白)
 */
function reindentReplacement(fileRegion: string, oldText: string, newText: string): string {
  if (!newText) return newText;

  const oldFirst = firstMeaningfulLine(oldText);
  const fileFirst = firstMeaningfulLine(fileRegion);
  if (oldFirst === null || fileFirst === null) return newText;

  const llmBaseIndent = leadingWhitespace(oldFirst);
  const fileBaseIndent = leadingWhitespace(fileFirst);

  // 缩进一致,无需重对齐
  if (llmBaseIndent === fileBaseIndent) return newText;

  const outLines: string[] = [];
  for (const line of newText.split("\n")) {
    if (!line.trim()) {
      // 空行:保留原样(含纯空白行)
      outLines.push(line);
      continue;
    }
    const lineIndent = leadingWhitespace(line);
    if (lineIndent.startsWith(llmBaseIndent)) {
      // 常见情况:行带有模型基准缩进(可能还有额外嵌套)。
      // 把基准前缀换成文件基准前缀,保留额外嵌套。
      const remainder = line.slice(llmBaseIndent.length);
      outLines.push(fileBaseIndent + remainder);
    } else {
      // dedent 行:比模型基准缩进更少。锚定到文件基准。
      outLines.push(fileBaseIndent + line.replace(/^[ \t]+/, ""));
    }
  }
  return outLines.join("\n");
}

/** L4: 按行切割,去除每行首尾空白后滑动窗口匹配
 *  返回所有匹配区间(每段 [startLine, endLine))的起始行索引列表 */
function findAllMatchRanges(contentLines: string[], oldLines: string[]): number[] {
  const starts: number[] = [];
  if (oldLines.length === 0 || contentLines.length < oldLines.length) return starts;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let isMatch = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j]!.trim() !== oldLines[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) starts.push(i);
  }
  return starts;
}

/** L4: 按行切割,去除每行首尾空白后滑动窗口匹配。
 *  replaceAll=false(默认):仅当唯一匹配时替换,多处抛错(唯一性保护)。
 *  replaceAll=true:收集所有匹配区间,从后往前逐个替换,
 *  每个区间分别调 reindentReplacement 做缩进重对齐(基于该区间所在行的缩进)。 */
function lineByLineReplace(
  content: string,
  oldText: string,
  newText: string,
  replaceAll?: boolean,
): string {
  const contentLines = content.split("\n");
  const oldLines = oldText
    .trim()
    .split("\n")
    .map((l) => l.trim());

  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段");
  }

  const matchStarts = findAllMatchRanges(contentLines, oldLines);
  const matchCount = matchStarts.length;

  if (matchCount === 0) {
    throw new Error("在文件中未找到 old_text,请先调用 read_file 仔细确认要替换的内容");
  }
  if (matchCount > 1 && !replaceAll) {
    throw new Error(`模糊匹配到了 ${matchCount} 处相似代码,请提供更多上下文行代码以精确定位`);
  }

  if (!replaceAll) {
    // 唯一匹配:原逻辑
    const matchStart = matchStarts[0]!;
    const matchEnd = matchStart + oldLines.length;
    const fileRegion = contentLines.slice(matchStart, matchEnd).join("\n");
    const adjustedNewText = reindentReplacement(fileRegion, oldText, newText);
    return [...contentLines.slice(0, matchStart), adjustedNewText, ...contentLines.slice(matchEnd)].join(
      "\n",
    );
  }

  // replaceAll:从后往前逐区间替换(倒序避免行号偏移),每个区间独立缩进重对齐
  let lines = [...contentLines];
  for (let k = matchStarts.length - 1; k >= 0; k--) {
    const matchStart = matchStarts[k]!;
    const matchEnd = matchStart + oldLines.length;
    const fileRegion = lines.slice(matchStart, matchEnd).join("\n");
    const adjustedNewText = reindentReplacement(fileRegion, oldText, newText);
    lines = [...lines.slice(0, matchStart), adjustedNewText, ...lines.slice(matchEnd)];
  }
  return lines.join("\n");
}

export class EditFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "edit_file";
  }

  /** 声明对 path 的读改写(Edit 必须先读后写,与并发写同文件冲突) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readWriteFile(safeResolve(this.workDir, path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "edit_file",
      description:
        "对现有文件进行局部的字符串替换。比重写整个文件更安全、更快速。请提供足够的上下文(建议上下各多包含几行)以确保 old_text 在文件中唯一。请先使用 read_file 读取文件,old_text 应取自 read_file 的输出(含行号前缀需去掉)。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要修改的文件路径" },
          old_text: {
            type: "string",
            description:
              "文件中原有的文本,取自 read_file 输出(去掉行号前缀)。必须包含足够的上下文以确保唯一匹配。",
          },
          new_text: { type: "string", description: "要替换成的新文本" },
          replace_all: {
            type: "boolean",
            description:
              "是否替换所有匹配处(默认 false,仅替换唯一匹配)。多处匹配且此项为 false 时会报错,设为 true 则全部替换。",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let path: string;
    let oldText: string;
    let newText: string;
    let replaceAll: boolean;
    try {
      const input = JSON.parse(args) as {
        path?: string;
        old_text?: string;
        new_text?: string;
        replace_all?: boolean;
      };
      path = input.path ?? "";
      oldText = input.old_text ?? "";
      newText = input.new_text ?? "";
      replaceAll = input.replace_all === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 path、old_text、new_text 字段");
    }

    const fullPath = safeResolve(this.workDir, path);

    // 1. 读取原文件(原始字节流)
    const raw = await readFile(fullPath, "utf8");

    // 2. 模型视图归一化:纯 CRLF → LF 视图(模型只处理一种行尾,匹配才稳定);
    //    lf/mixed 原样返回,并记录原始行尾风格供写回还原。
    const modelView = toModelTextView(raw);
    const content = modelView.text;

    // 3. 多级模糊替换(在 LF 视图上操作)
    try {
      const { content: newContent, level } = fuzzyReplace(content, oldText, newText, replaceAll);

      // 4. 写回磁盘:按记录的原始行尾风格还原(CRLF 文件写回仍是 CRLF)
      await writeFile(fullPath, materializeModelText(newContent, modelView.lineEndingStyle), "utf8");

      // 5. 生成 diff 预览(简单 before/after 对比,供用户审批时查看)
      const diffPreview = generateSimpleDiff(oldText, newText);
      const allNote = replaceAll ? ", 全部替换" : "";
      return `✅ 成功修改文件: ${path} (匹配级别 L${level}${allNote})\n\n${diffPreview}`;
    } catch (err) {
      // 匹配全失败时附候选上下文,帮模型重定位(仅对"未找到"类错误生效)
      throw this.enrichNotFoundError(err, content, oldText);
    }
  }

  /**
   * 匹配失败时增强错误信息:对"未找到 old_text / 找不到该代码片段"类错误,
   * 用 findClosestLines 在文件里找最相似的几段,附在错误信息末尾帮模型重定位。
   * 其他错误(如 IO 失败、多处匹配、参数解析失败)原样返回,不附候选。
   */
  private enrichNotFoundError(err: unknown, content: string, oldText: string): Error {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!/未找到|找不到|not found/i.test(errMsg)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const hints = findClosestLines(content, oldText);
    if (hints.length === 0) {
      return err instanceof Error ? err : new Error(String(err));
    }
    return new Error(`${errMsg}${formatCandidateHint(hints)}`);
  }
}

// ==========================================
// Diff 预览生成 (第 1.3 讲: Diff 预览)
// 简单的 before/after 对比,不做完整 diff 算法。
// 用于 edit_file 返回结果和审批通知,让用户看到改了什么。
// ==========================================

/** diff 预览最大行数,超出截断 */
const DIFF_MAX_LINES = 30;

/**
 * 生成简单的 before/after diff 预览。
 * 格式类似 unified diff 但更简化:
 *   --- 修改前 (N 行)
 *   +++ 修改后 (M 行)
 *   - 旧行
 *   + 新行
 */
export function generateSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // 找到公共前缀
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  // 找到公共后缀
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

  const lines: string[] = [
    `--- 修改前 (${oldChanged.length} 行变更)`,
    `+++ 修改后 (${newChanged.length} 行变更)`,
  ];

  for (const line of oldChanged) {
    lines.push(`- ${line}`);
  }
  for (const line of newChanged) {
    lines.push(`+ ${line}`);
  }

  // 截断过长的 diff
  if (lines.length > DIFF_MAX_LINES) {
    const kept = lines.slice(0, DIFF_MAX_LINES);
    kept.push(`... (共 ${lines.length} 行,已截断)`);
    return kept.join("\n");
  }

  return lines.join("\n");
}
