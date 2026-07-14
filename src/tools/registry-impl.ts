// Registry 默认实现 + 内置工具。
// 对应课程第 05 讲:registryImpl + read_file 工具。

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  BaseTool,
  ExecutionMiddleware,
  MiddlewareFunc,
  Registry,
  RequestMiddleware,
  ToolExecutionContext,
  ToolFileSideEffects,
} from "./registry.js";
import { NO_FILE_SIDE_EFFECTS, WORKSPACE_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";
import { logger } from "../observability/logger.js";
import { ToolAccesses } from "./tool-access.js";
import {
  toModelTextView,
  materializeModelText,
  makeCarriageReturnsVisible,
} from "./line-endings.js";
import { findClosestLines, formatCandidateHint } from "./edit-hint.js";
// 跨平台 shell:Windows 上统一走 Git Bash,避免 cmd.exe 不识别 POSIX 语义。
import { isWindows, resolveShell, shellCommandArgs } from "../os/shell.js";
import { signalProcessTree } from "../os/process-tree.js";
import { BackgroundManager } from "./background-manager.js";
import type { HookRunner } from "../hooks/runner.js";
import type { HookService } from "../hooks/service.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import {
  buildSandboxSpawnPlan,
  evaluateSandboxCommand,
  SandboxViolationError,
  type SandboxSpawnPlan,
  type YoloSandboxConfig,
} from "../safety/yolo-sandbox.js";

const DEFAULT_RESULT_SIZE_CHARS = 8000;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

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
 * 只读工具使用的路径解析。
 * 保留给旧调用方的同步 helper;所有路径都必须留在 workDir 内。
 */
export function resolveReadablePath(workDir: string, path: string): string {
  return safeResolve(workDir, path);
}

function workspaceRootsFrom(input: string | WorkspaceRoots): WorkspaceRoots {
  return typeof input === "string" ? WorkspaceRoots.createSync(input) : input;
}

function exactPathSideEffects(args: string): ToolFileSideEffects {
  try {
    const { path } = JSON.parse(args) as { path?: unknown };
    return {
      kind: "exact",
      paths: typeof path === "string" && path.length > 0 ? [path] : [],
    };
  } catch {
    return { kind: "exact", paths: [] };
  }
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
  private readonly safetyMiddlewares: RequestMiddleware[] = [];
  private readonly permissionMiddlewares: RequestMiddleware[] = [];
  private readonly executionMiddlewares: ExecutionMiddleware[] = [];
  private preWriteHook?: (toolName: string, args: string) => Promise<void>;
  /**
   * 用户可配置 Shell Hooks 执行器(任务 2.6)。
   * 挂载后:PreToolUse 在工具执行前判定 allow/deny(+可改写参数);
   * PostToolUse 在工具执行后 fire-and-forget 通知。
   * 未挂载(undefined)时跳过所有 hook 逻辑,零开销。
   */
  private hookRunner?: HookRunner;
  private hookService?: HookService;
  /**
   * 传给 hook stdin 的 session_id。
   * execute(call) 签名无 sessionId 入参,故由 host 在装配时 setSessionId 注入,
   * 默认空串(hook 仍可用 cwd 做识别)。
   */
  private sessionId = "";

  constructor(opts: ToolRegistryOptions = {}) {
    this.defaultResultSizeChars = opts.defaultResultSizeChars ?? DEFAULT_RESULT_SIZE_CHARS;
    this.truncateResults = opts.truncateResults ?? true;
  }

  setPreWriteHook(hook: (toolName: string, args: string) => Promise<void>): void {
    this.preWriteHook = hook;
  }

  /** 挂载 HookRunner,启用 PreToolUse/PostToolUse 钩子(任务 2.6) */
  setHookRunner(runner: HookRunner): void {
    this.hookRunner = runner;
    logger.info("[Registry] 已挂载 HookRunner (PreToolUse/PostToolUse)");
  }

  setHookService(service: HookService): void {
    this.hookService = service;
    logger.info("[Registry] 已挂载会话级 HookService");
  }

  async drainHookEvents(): Promise<void> {
    // 新 HookService 路径不再启动裸 fire-and-forget；保留方法作为
    // Registry 生命周期的稳定 drain 边界，便于后续引入有界队列。
  }

  /** 设置传给 hook stdin 的 session_id(无则默认空串) */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      logger.warn({ tool: name }, `[Warning] 工具 '${name}' 已被注册,将被覆盖。`);
    }
    this.tools.set(name, tool);
    logger.info({ tool: name }, `[Registry] 成功挂载工具: ${name}`);
  }

  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      logger.info({ tool: name }, `[Registry] 已卸载工具: ${name}`);
    }
    return removed;
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

  useSafety(mw: RequestMiddleware): void {
    this.safetyMiddlewares.push(mw);
  }

  usePermission(mw: RequestMiddleware): void {
    this.permissionMiddlewares.push(mw);
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

  handlesAbortSignal(name: string): boolean {
    // 中间件可以选择不调 next，此时不能替整条链承诺物理收口。
    return (
      this.executionMiddlewares.length === 0 && (this.tools.get(name)?.handlesAbortSignal ?? false)
    );
  }

  getFileSideEffects(call: ToolCall): ToolFileSideEffects {
    const tool = this.tools.get(call.name);
    if (!tool) return NO_FILE_SIDE_EFFECTS;
    const declared = tool.fileSideEffects;
    if (declared !== undefined) {
      try {
        return typeof declared === "function" ? declared.call(tool, call.arguments) : declared;
      } catch (err) {
        logger.warn({ tool: call.name, err }, "[Registry] 文件副作声明解析失败，使用保守范围");
      }
    }
    return tool.readOnly ? NO_FILE_SIDE_EFFECTS : WORKSPACE_FILE_SIDE_EFFECTS;
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

  async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
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

    const runMiddlewares = async (
      middlewares: readonly RequestMiddleware[],
      source: "safety" | "permission",
      forceApproval = false,
    ): Promise<ToolResult | undefined> => {
      for (const mw of middlewares) {
        const {
          allowed,
          reason,
          call: rewrittenCall,
          denialSource,
        } = await mw(currentCall, {
          forceApproval,
        });
        if (!allowed) {
          logger.warn(
            { tool: currentCall.name, reason },
            `[Registry] ⚠ 工具 ${currentCall.name} 被 Middleware 拦截: ${reason}`,
          );
          await this.notifyPermissionDenied(
            currentCall,
            denialSource ?? source,
            reason ?? "未知原因",
            context,
          );
          return {
            toolCallId: currentCall.id,
            output: `执行被系统拦截。原因: ${reason}`,
            isError: true,
          };
        }
        if (rewrittenCall) currentCall = rewrittenCall;
      }
      return undefined;
    };

    // 2. Hardline / Plan / Trust 不可绕过安全门始终先于 Hook。
    const initialRejection = await runMiddlewares(this.safetyMiddlewares, "safety");
    if (initialRejection) return initialRejection;
    const usesLegacyHookPipeline = !this.hookService && this.hookRunner !== undefined;
    if (usesLegacyHookPipeline) {
      const legacyRequestRejection = await runMiddlewares(this.requestMiddlewares, "permission");
      if (legacyRequestRejection) return legacyRequestRejection;
    }

    // 3. 【任务 2.6】PreToolUse hook:在工具执行前判定 allow/deny。
    //    放在 requestMiddlewares 之后(审批先于用户 hook),preWriteHook/tool.execute 之前。
    //    hook 任何故障均 fail-open(由 HookRunner 内部兜底),不会阻断工具。
    let toolInput: unknown;
    let forceApproval = false;
    try {
      toolInput = JSON.parse(currentCall.arguments);
    } catch {
      toolInput = {};
    }
    if (this.hookService) {
      const hookResult = await this.hookService.dispatch(
        "PreToolUse",
        {
          tool_name: currentCall.name,
          tool_input: toolInput,
          tool_call_id: currentCall.id,
        },
        { signal: context?.signal },
      );
      if (hookResult.decision === "deny") {
        const reason = hookResult.reason ?? "(无原因)";
        await this.notifyPermissionDenied(currentCall, "hook", reason, context);
        return {
          toolCallId: currentCall.id,
          output: `🚫 被 PreToolUse hook 阻断: ${reason}`,
          isError: true,
        };
      }
      forceApproval = hookResult.decision === "ask" || hookResult.decision === "defer";
      if (hookResult.modifiedInput !== undefined) {
        currentCall = { ...currentCall, arguments: JSON.stringify(hookResult.modifiedInput) };
        toolInput = hookResult.modifiedInput;
        const rewrittenRejection = await runMiddlewares(this.safetyMiddlewares, "safety");
        if (rewrittenRejection) return rewrittenRejection;
      }
    } else if (this.hookRunner) {
      let hookResult;
      try {
        hookResult = await this.hookRunner.runPreToolUse(
          currentCall.name,
          toolInput,
          this.sessionId,
        );
      } catch (err) {
        // HookRunner 内部已 fail-open,此处防御性兜底:绝不阻断
        logger.warn(
          { err: String(err), tool: currentCall.name },
          `[Registry] PreToolUse hook 异常,fail-open 放行`,
        );
        hookResult = { decision: "allow" as const };
      }
      if (hookResult.decision === "deny") {
        logger.warn(
          { tool: currentCall.name, reason: hookResult.reason },
          `[Registry] 🚫 工具 ${currentCall.name} 被 PreToolUse hook 阻断`,
        );
        return {
          toolCallId: currentCall.id,
          output: `🚫 被 PreToolUse hook 阻断: ${hookResult.reason ?? "(无原因)"}`,
          isError: true,
        };
      }
      // modifiedInput:hook 改写了工具输入 → 替换 arguments
      if (hookResult.modifiedInput !== undefined) {
        currentCall = { ...currentCall, arguments: JSON.stringify(hookResult.modifiedInput) };
        toolInput = hookResult.modifiedInput;
        const rewrittenRejection = await runMiddlewares(this.safetyMiddlewares, "safety");
        if (rewrittenRejection) return rewrittenRejection;
        const legacyRequestRejection = await runMiddlewares(this.requestMiddlewares, "permission");
        if (legacyRequestRejection) return legacyRequestRejection;
      }
    }

    // 4. Hook 改写并重过安全门后，才进入权限 Hook/人工审批。
    const permissionRejection = await runMiddlewares(
      [...this.permissionMiddlewares, ...(usesLegacyHookPipeline ? [] : this.requestMiddlewares)],
      "permission",
      forceApproval,
    );
    if (permissionRejection) return permissionRejection;

    // 5. 执行工具逻辑:所有安全门 + Hook + 权限链都放行了
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
        tool.execute(nextCall.arguments, context);
      for (let i = this.executionMiddlewares.length - 1; i >= 0; i--) {
        const mw = this.executionMiddlewares[i]!;
        const next = chain;
        chain = (nextCall) => mw(nextCall, next, context);
      }
      const output = await chain(currentCall);
      const finalOutput = this.truncateResults
        ? truncateToolOutput(output, tool.maxResultSizeChars ?? this.defaultResultSizeChars)
        : output;

      // 5. 【任务 2.6】PostToolUse hook:工具执行成功后 fire-and-forget 通知。
      //    不阻断、不影响返回值;任何故障静默忽略。
      if (this.hookService) {
        await this.hookService.dispatch(
          "PostToolUse",
          {
            tool_name: currentCall.name,
            tool_input: toolInput,
            tool_call_id: currentCall.id,
            tool_response: finalOutput,
          },
          { signal: context?.signal },
        );
      } else if (this.hookRunner) {
        try {
          this.hookRunner
            .runPostToolUse(currentCall.name, toolInput, finalOutput, this.sessionId)
            .catch(() => {
              /* fire-and-forget */
            });
        } catch {
          /* fire-and-forget */
        }
      }

      return {
        toolCallId: currentCall.id,
        output: finalOutput,
        isError: false,
      };
    } catch (err) {
      // 6. 封装:底层物理错误也封成 isError 的 ToolResult
      if (context?.signal?.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new DOMException("aborted", "AbortError");
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.hookService) {
        await this.hookService.dispatch(
          "PostToolUseFailure",
          {
            tool_name: currentCall.name,
            tool_input: toolInput,
            tool_call_id: currentCall.id,
            error: errMsg,
          },
          { signal: context?.signal },
        );
      }
      return {
        toolCallId: currentCall.id,
        output: `Error executing ${currentCall.name}: ${errMsg}`,
        isError: true,
      };
    }
  }

  private async notifyPermissionDenied(
    call: ToolCall,
    source: string,
    reason: string,
    context?: ToolExecutionContext,
  ): Promise<void> {
    if (!this.hookService) return;
    await this.hookService.dispatch(
      "PermissionDenied",
      {
        tool_name: call.name,
        tool_input: parseToolInput(call.arguments),
        tool_call_id: call.id,
        source,
        reason,
      },
      { signal: context?.signal },
    );
  }
}

function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
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
// 防御底线:WorkDir 边界限制 + 路径穿越防护 + 行分页保护
// ==========================================

const READ_FILE_DEFAULT_LIMIT_LINES = 500;
const READ_FILE_MAX_LIMIT_LINES = 1000;
const READ_FILE_MAX_PAGE_CHARS = 30_000;
const READ_FILE_MAX_RENDERED_LINE_CHARS = 2000;
const READ_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** 行尾风格 → 展示标签(供状态行输出,帮模型识别文件格式) */
function lineEndingStyleLabel(style: "lf" | "crlf" | "mixed"): string {
  if (style === "crlf") return "CRLF";
  if (style === "mixed") return "MIXED";
  return "LF";
}

export class ReadFileTool implements BaseTool {
  readonly readOnly = true;
  // read_file 由自身的 offset/limit 和页字符上限保护，Registry 不再二次截断。
  readonly maxResultSizeChars = Number.POSITIVE_INFINITY;
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "read_file";
  }

  /** 声明读 path 归一化后的绝对路径(与 execute 的 safeResolve 一致) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "read_file",
      description:
        "按行读取指定路径的文件内容，保留原始行号。相对路径基于主工作区，绝对路径须位于已授权工作区。大文件请按 PARTIAL 提示继续分页。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径,如 src/cli/main.ts" },
          offset: {
            type: "integer",
            minimum: 1,
            description: "可选，起始行号（1-based），默认从第 1 行开始。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: READ_FILE_MAX_LIMIT_LINES,
            description: `可选，最多读取的行数，默认 ${READ_FILE_DEFAULT_LIMIT_LINES}，最大 ${READ_FILE_MAX_LIMIT_LINES}。`,
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let path: string;
    let offset: number;
    let limit: number;
    let paginationRequested: boolean;
    try {
      const input = JSON.parse(args) as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof input.path !== "string" || input.path.length === 0) {
        throw new Error("path 必须是非空字符串");
      }
      path = input.path;
      paginationRequested = input.offset !== undefined || input.limit !== undefined;
      offset = parsePositiveInteger(input.offset, "offset", 1);
      limit = parsePositiveInteger(input.limit, "limit", READ_FILE_DEFAULT_LIMIT_LINES);
      if (limit > READ_FILE_MAX_LIMIT_LINES) {
        throw new Error(`limit 不能超过 ${READ_FILE_MAX_LIMIT_LINES}`);
      }
    } catch (err) {
      const reason =
        err instanceof SyntaxError
          ? "期望 JSON 含 path 字段"
          : err instanceof Error
            ? err.message
            : "期望 JSON 含 path 字段";
      throw new Error(`参数解析失败: ${reason}`, { cause: err });
    }

    // 2. 所有文件访问统一经过共享工作区边界。
    const fullPath = await this.roots.assertAllowed(path);

    // 3. 先用不跟随符号链接的 FD 检查大小，避免分页之前就把超大文件读入内存。
    const handle = await open(fullPath, constants.O_RDONLY | NO_FOLLOW_FLAG);
    let raw: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`路径不是普通文件: ${path}`);
      if (info.size > READ_FILE_MAX_BYTES) {
        throw new Error(
          `文件大小 ${info.size} 字节，超过 read_file 上限 ${READ_FILE_MAX_BYTES} 字节；请用 grep 先缩小范围。`,
        );
      }
      raw = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }

    // 4. 模型视图归一化:纯 CRLF → LF(模型只处理一种行尾,Edit 匹配才稳定);
    //    lf/mixed 原样返回,并记录原始行尾风格供 Edit 写回还原。
    const { text, lineEndingStyle } = toModelTextView(raw);

    // 5. 空文件:只返回状态行,不输出空行号
    if (text.length === 0) {
      if (offset !== 1) {
        throw new Error(`offset ${offset} 超出文件总行数 0`);
      }
      return `共 0 行,行尾: ${lineEndingStyleLabel(lineEndingStyle)}`;
    }

    // 6. 按行分割(行号从 1 开始)。
    //    末尾换行不产生空行号:先剥掉尾部 \n 再 split。
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (offset > lines.length) {
      throw new Error(`offset ${offset} 超出文件总行数 ${lines.length}`);
    }

    // 7. 行数分页 + 页字符上限双重保护。不在字符中间切断整页，
    //    因此下一页始终能用稳定的原始行号继续。
    const startIndex = offset - 1;
    const requestedEndIndex = Math.min(lines.length, startIndex + limit);
    const renderedLines: string[] = [];
    let clippedLineCount = 0;

    for (let index = startIndex; index < requestedEndIndex; index++) {
      const rendered = renderReadLine(lines[index] ?? "", index + 1, lineEndingStyle);
      if (rendered.clipped) clippedLineCount++;
      renderedLines.push(rendered.text);

      const candidate = formatReadPage({
        renderedLines,
        path,
        offset,
        limit,
        totalLines: lines.length,
        lineEndingStyle,
        paginationRequested,
        clippedLineCount,
      });
      if (candidate.length > READ_FILE_MAX_PAGE_CHARS) {
        renderedLines.pop();
        if (rendered.clipped) clippedLineCount--;
        break;
      }
    }

    // 单行已有 2,000 chars 上限，因此正常情况不会为空；保底保留一行。
    if (renderedLines.length === 0) {
      const rendered = renderReadLine(lines[startIndex] ?? "", offset, lineEndingStyle);
      renderedLines.push(rendered.text);
      clippedLineCount = rendered.clipped ? 1 : 0;
    }

    return formatReadPage({
      renderedLines,
      path,
      offset,
      limit,
      totalLines: lines.length,
      lineEndingStyle,
      paginationRequested,
      clippedLineCount,
    });
  }
}

function parsePositiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是大于等于 1 的整数`);
  }
  return value;
}

function renderReadLine(
  line: string,
  lineNumber: number,
  lineEndingStyle: "lf" | "crlf" | "mixed",
): { text: string; clipped: boolean } {
  const content = lineEndingStyle === "mixed" ? makeCarriageReturnsVisible(line) : line;
  const prefix = `${lineNumber}\t`;
  const full = `${prefix}${content}`;
  if (full.length <= READ_FILE_MAX_RENDERED_LINE_CHARS) {
    return { text: full, clipped: false };
  }

  const marker = `...[单行超过 ${READ_FILE_MAX_RENDERED_LINE_CHARS} chars,已截断]`;
  const keepChars = Math.max(0, READ_FILE_MAX_RENDERED_LINE_CHARS - prefix.length - marker.length);
  return {
    text: `${prefix}${content.slice(0, keepChars)}${marker}`,
    clipped: true,
  };
}

function formatReadPage(input: {
  renderedLines: readonly string[];
  path: string;
  offset: number;
  limit: number;
  totalLines: number;
  lineEndingStyle: "lf" | "crlf" | "mixed";
  paginationRequested: boolean;
  clippedLineCount: number;
}): string {
  const endLine = input.offset + input.renderedLines.length - 1;
  const hasMoreLines = endLine < input.totalLines;
  const isDefaultCompleteRead = !input.paginationRequested && input.offset === 1 && !hasMoreLines;
  const status = isDefaultCompleteRead
    ? `共 ${input.totalLines} 行,行尾: ${lineEndingStyleLabel(input.lineEndingStyle)}`
    : `共 ${input.totalLines} 行,当前显示 ${input.offset}-${endLine} 行,行尾: ${lineEndingStyleLabel(input.lineEndingStyle)}`;
  const parts = [input.renderedLines.join("\n"), status];

  if (input.clippedLineCount > 0) {
    parts.push(
      `[提示: ${input.clippedLineCount} 个超长行已各自截断至 ${READ_FILE_MAX_RENDERED_LINE_CHARS} chars，请用更精确的 bash 命令定位所需片段。]`,
    );
  }
  if (hasMoreLines) {
    parts.push(
      `PARTIAL: 文件内容未全部显示。继续读取: read_file ${JSON.stringify({
        path: input.path,
        offset: endLine + 1,
        limit: input.limit,
      })}`,
    );
  }

  return parts.join("\n");
}

// ==========================================
// 内置工具 3:WriteFileTool (第 06 讲)
// 极简工具集原语之一:创建或覆盖文件。
// ==========================================
export class WriteFileTool implements BaseTool {
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "write_file";
  }

  fileSideEffects(args: string): ToolFileSideEffects {
    return exactPathSideEffects(args);
  }

  /** 声明写 path 归一化后的绝对路径 —— 不同文件的写可并行 */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.writeFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "write_file",
      description:
        "创建或覆盖写入一个文件。如果目录不存在会自动创建。支持主工作区相对路径或已授权工作区内绝对路径。",
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

    // 先校验但不消耗一次性授权；创建父目录后重新解析真实路径，
    // 防止父目录在 mkdir 期间被替换为越界符号链接。
    const initialPath = await this.roots.assertAllowed(path, { consumeAuthorization: false });
    await mkdir(dirname(initialPath), { recursive: true });
    const fullPath = await this.roots.assertAllowed(path);

    // 检查是新建还是覆盖
    let isNewFile = false;
    try {
      await stat(fullPath);
    } catch {
      isNewFile = true; // 文件不存在 → 新建
    }

    // O_NOFOLLOW 拒绝在最后一次校验后被替换的文件符号链接。
    const handle = await open(
      fullPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW_FLAG,
      0o666,
    );
    try {
      await writeAllAtStart(handle, content);
    } finally {
      await handle.close();
    }

    const action = isNewFile ? "新建" : "覆盖";
    const sizeInfo = `(${content.length} 字符)`;
    return `✅ ${action}文件: ${path} ${sizeInfo}`;
  }
}

// ==========================================
// 内置工具 4:BashTool (第 06 讲,YOLO 哲学核心)
// 极简工具集原语之一:执行任意 Shell 命令。
// 4 条驾驭底线:超时控制、工作区绑定、错误原样回传、有界执行缓冲。
// ==========================================

/** bash 命令最大执行时间,防止卡死进程 (如 top / 常驻服务) */
const BASH_TIMEOUT_MS = 30_000;
/** 前台命令可持久捕获的最大输出（bytes）。 */
const BASH_EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const BASH_KILL_GRACE_MS = 750;

export class BashTool implements BaseTool {
  // 完整已捕获输出必须交给 observation 外部化，Registry 不再提前截断。
  readonly maxResultSizeChars = Number.POSITIVE_INFINITY;
  readonly handlesAbortSignal = true;
  readonly fileSideEffects = WORKSPACE_FILE_SIDE_EFFECTS;

  constructor(
    private readonly workDir: string,
    private readonly backgroundManager = new BackgroundManager(),
    private readonly options: {
      allowBackground?: boolean;
      /** 仅由可信宿主注入；一旦注入，无 OS 后端时 Bash fail-closed。 */
      sandbox?: {
        workspaceRoots: WorkspaceRoots;
        config?: Partial<YoloSandboxConfig>;
      };
      /** 子代理 Bash 由宿主注入最小环境；主 Bash 未设置时仍继承当前用户环境。 */
      env?: NodeJS.ProcessEnv;
    } = {},
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

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    let command: string;
    let background: boolean;
    try {
      const input = JSON.parse(args) as { command?: string; background?: boolean };
      command = input.command ?? "";
      background = input.background === true;
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 command 字段");
    }

    const sandboxPlan = this.buildSandboxPlan(command);

    if (background) {
      if (this.options.allowBackground === false) {
        throw new Error("当前 bash 工具不允许后台执行");
      }
      const task = this.backgroundManager.start(
        command,
        this.workDir,
        sandboxPlan || this.options.env
          ? {
              ...(sandboxPlan ? { executable: sandboxPlan.command, args: sandboxPlan.args } : {}),
              ...(this.options.env ? { env: this.options.env } : {}),
            }
          : undefined,
      );
      return JSON.stringify({
        taskId: task.taskId,
        pid: task.pid,
        status: task.status,
        command: task.command,
        cwd: task.cwd,
        startedAt: task.startedAt.toISOString(),
      });
    }

    context?.signal?.throwIfAborted();
    const execution = await runForegroundCommand(
      command,
      this.workDir,
      context,
      sandboxPlan,
      this.options.env,
    );
    let stdout = execution.output;

    if (
      sandboxPlan?.sandboxed === true &&
      execution.exitCode !== 0 &&
      /(?:operation not permitted|permission denied|\bEPERM\b|\bEACCES\b)/iu.test(stdout)
    ) {
      throw new SandboxViolationError(
        "sandbox_runtime_denied",
        `OS 沙箱拒绝了子进程操作。${stdout.trim() ? `\n${stdout.trim()}` : ""}`,
      );
    }

    if (execution.timedOut) {
      stdout += `\n[警告: 命令执行超时(${BASH_TIMEOUT_MS / 1000}s),已终止完整子进程树。如果是启动常驻服务,请改用后台运行方式。]`;
    }
    if (execution.exceededExecutionBuffer) {
      stdout += `\n[警告: 终端输出超过执行缓冲上限 ${BASH_EXEC_MAX_BUFFER_BYTES} bytes，完整子进程树已终止；本次结果仅包含已捕获内容。请缩小命令范围或分页输出。]`;
    }
    if (execution.error && !stdout.trim()) {
      stdout = `执行报错: ${execution.error.message}`;
    } else if (execution.exitCode !== 0 && execution.exitCode !== null && !stdout.trim()) {
      stdout = `执行报错: 命令以状态码 ${execution.exitCode} 退出。`;
    }

    // 空输出给明确成功反馈
    if (!stdout.trim()) {
      return "命令执行成功,无终端输出。";
    }

    // 不在工具层截断。>30,000 chars 由 observation 完整落盘并返回摘要。
    return stdout;
  }

  private buildSandboxPlan(command: string): SandboxSpawnPlan | undefined {
    const sandbox = this.options.sandbox;
    if (!sandbox) return undefined;
    const roots = sandbox.workspaceRoots.list();
    const decision = evaluateSandboxCommand(command, this.workDir, roots, sandbox.config);
    if (!decision.allowed) {
      throw new SandboxViolationError(
        decision.code ?? "workspace_write_denied",
        decision.reason?.replace(/^\[sandbox:[^\]]+\]\s*/u, "") ?? "Bash 请求被沙箱策略拒绝。",
      );
    }
    const shell = resolveShell();
    return buildSandboxSpawnPlan({
      command,
      shell,
      shellArgs: shellCommandArgs(shell, command),
      cwd: this.workDir,
      writableRoots: roots,
      ...(sandbox.config ? { config: sandbox.config } : {}),
    });
  }
}

interface ForegroundCommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  exceededExecutionBuffer: boolean;
  error?: Error;
}

function runForegroundCommand(
  command: string,
  cwd: string,
  context?: ToolExecutionContext,
  sandboxPlan?: SandboxSpawnPlan,
  env?: NodeJS.ProcessEnv,
): Promise<ForegroundCommandResult> {
  const shell = resolveShell();

  return new Promise<ForegroundCommandResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(
        sandboxPlan?.command ?? shell,
        sandboxPlan?.args ?? shellCommandArgs(shell, command),
        {
          cwd,
          detached: !isWindows,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...(env ? { env } : {}),
        },
      );
    } catch (error) {
      resolvePromise({
        output: "",
        exitCode: null,
        timedOut: false,
        exceededExecutionBuffer: false,
        error: asError(error),
      });
      return;
    }

    const chunks: string[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let exceededExecutionBuffer = false;
    let childError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const killAttempts: Promise<boolean>[] = [];

    const signalTree = (signal: NodeJS.Signals): void => {
      killAttempts.push(signalProcessTree(child, signal).catch(() => false));
    };
    const forceKill = (): void => signalTree("SIGKILL");
    const terminateWithGrace = (): void => {
      signalTree("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(forceKill, BASH_KILL_GRACE_MS);
      killTimer.unref();
    };
    const emit = (stream: "stdout" | "stderr", chunk: string): void => {
      try {
        context?.onOutput?.({ stream, chunk });
      } catch {
        // Reporter 是观察者，不得因渲染错误中断物理命令。
      }

      if (exceededExecutionBuffer) return;
      const bytes = Buffer.byteLength(chunk);
      const remaining = BASH_EXEC_MAX_BUFFER_BYTES - capturedBytes;
      if (bytes <= remaining) {
        chunks.push(chunk);
        capturedBytes += bytes;
        return;
      }
      if (remaining > 0) {
        chunks.push(truncateUtf8Bytes(chunk, remaining));
        capturedBytes = BASH_EXEC_MAX_BUFFER_BYTES;
      }
      exceededExecutionBuffer = true;
      forceKill();
    };
    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (context?.signal && abortListener) {
        context.signal.removeEventListener("abort", abortListener);
      }
    };
    const abortListener = (): void => {
      // 中断是用户的显式意图，立即杀整组，不给孙进程继续写文件的宽限。
      forceKill();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => emit("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => emit("stderr", chunk));
    child.once("error", (error) => {
      childError = asError(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      void Promise.allSettled(killAttempts).then(() => {
        if (context?.signal?.aborted) {
          rejectPromise(abortError(context.signal));
          return;
        }
        resolvePromise({
          output: chunks.join(""),
          exitCode,
          timedOut,
          exceededExecutionBuffer,
          ...(childError ? { error: childError } : {}),
        });
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateWithGrace();
    }, BASH_TIMEOUT_MS);
    timeoutTimer.unref();

    if (context?.signal) {
      if (context.signal.aborted) {
        abortListener();
      } else {
        context.signal.addEventListener("abort", abortListener, { once: true });
      }
    }
  });
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

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
    throw new Error("参数解析失败: 期望 JSON 含 taskId 字段", { cause: err });
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
  return {
    content: lineByLineReplace(normalizedContent, normalizedOld, newText, replaceAll),
    level: 4,
  };
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
    return [
      ...contentLines.slice(0, matchStart),
      adjustedNewText,
      ...contentLines.slice(matchEnd),
    ].join("\n");
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
  private readonly roots: WorkspaceRoots;

  constructor(workDirOrRoots: string | WorkspaceRoots) {
    this.roots = workspaceRootsFrom(workDirOrRoots);
  }

  name(): string {
    return "edit_file";
  }

  fileSideEffects(args: string): ToolFileSideEffects {
    return exactPathSideEffects(args);
  }

  /** 声明对 path 的读改写(Edit 必须先读后写,与并发写同文件冲突) */
  accesses(args: string): ToolAccesses {
    const { path } = JSON.parse(args) as { path?: string };
    return ToolAccesses.readWriteFile(this.roots.resolve(path ?? ""));
  }

  definition(): ToolDefinition {
    return {
      name: "edit_file",
      description:
        "对已授权工作区内的现有文件进行局部字符串替换。比重写整个文件更安全、更快速。请提供足够的上下文(建议上下各多包含几行)以确保 old_text 在文件中唯一。请先使用 read_file 读取文件,old_text 应取自 read_file 的输出(含行号前缀需去掉)。",
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

    const fullPath = await this.roots.assertAllowed(path);
    const handle = await open(fullPath, constants.O_RDWR | NO_FOLLOW_FLAG);
    try {
      // 在同一个已校验的文件描述符上完成读改写，避免路径在读后写前被换目标。
      const raw = await handle.readFile("utf8");
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      const { content: newContent, level } = fuzzyReplace(content, oldText, newText, replaceAll);

      await writeAllAtStart(handle, materializeModelText(newContent, modelView.lineEndingStyle));

      // 5. 生成 diff 预览(简单 before/after 对比,供用户审批时查看)
      const diffPreview = generateSimpleDiff(oldText, newText);
      const allNote = replaceAll ? ", 全部替换" : "";
      return `✅ 成功修改文件: ${path} (匹配级别 L${level}${allNote})\n\n${diffPreview}`;
    } catch (err) {
      // 重新读取仅用于生成匹配失败提示，不再打开路径。
      const current = await readOpenFileFromStart(handle).catch(() => "");
      throw this.enrichNotFoundError(err, toModelTextView(current).text, oldText);
    } finally {
      await handle.close();
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

async function readOpenFileFromStart(handle: FileHandle): Promise<string> {
  const info = await handle.stat();
  if (info.size > Number.MAX_SAFE_INTEGER) throw new Error("文件过大，无法读取");
  const buffer = Buffer.alloc(Number(info.size));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

async function writeAllAtStart(handle: FileHandle, content: string): Promise<void> {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten === 0) throw new Error("文件写入未取得进展");
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
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
