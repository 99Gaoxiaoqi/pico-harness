// Registry 默认实现 + 内置工具聚合门面。
// 对应课程第 05 讲:registryImpl。
//
// 本文件现在只保留 ToolRegistry 核心实现(工具路由表 + 中间件编排器)
// 和 ToolRegistrationOwner 归属体系。原内嵌的 7 个工具类已拆到独立文件:
//   read-file.ts / write-file.ts / edit-file.ts / bash.ts / task.ts
// 文件末尾的 re-export 段把这些工具及共享符号重新导出,保持所有现有消费方
// (8 个 src 文件 + 17 个测试文件)的 import 路径零改动。

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
import type { HookService } from "../hooks/service.js";

export interface ToolRegistrationOwner {
  readonly kind: "plugin" | "mcp" | "host";
  readonly id: string;
  readonly token: symbol;
}

export function createToolRegistrationOwner(
  kind: ToolRegistrationOwner["kind"],
  id: string,
): ToolRegistrationOwner {
  return Object.freeze({ kind, id, token: Symbol(`${kind}:${id}`) });
}

/**
 * registryImpl:Registry 接口的默认实现。
 * 用 map 以工具 name 为 key 做 O(1) 路由查找。
 * 像忠实的前台总机:接线(收 ToolCall)→ 查黄页(map)→ 转接(Execute)。
 */
export class ToolRegistry implements Registry {
  private readonly tools = new Map<string, BaseTool>();
  private readonly toolOwners = new Map<string, ToolRegistrationOwner>();
  /** 第 16 讲:全局挂载的安全拦截中间件链 */
  private readonly requestMiddlewares: RequestMiddleware[] = [];
  private readonly safetyMiddlewares: RequestMiddleware[] = [];
  private readonly permissionMiddlewares: RequestMiddleware[] = [];
  private readonly executionMiddlewares: ExecutionMiddleware[] = [];
  private preWriteHook?: (toolName: string, args: string) => Promise<void>;
  private hookService?: HookService;

  setPreWriteHook(hook: (toolName: string, args: string) => Promise<void>): void {
    this.preWriteHook = hook;
  }

  setHookService(service: HookService): void {
    this.hookService = service;
    logger.info("[Registry] 已挂载会话级 HookService");
  }

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      const owner = this.toolOwners.get(name);
      if (owner) {
        throw new Error(
          `Tool '${name}' is owned by ${owner.kind}:${owner.id} and cannot be overwritten`,
        );
      }
      logger.warn({ tool: name }, `[Warning] 工具 '${name}' 已被注册,将被覆盖。`);
    }
    this.tools.set(name, tool);
    this.toolOwners.delete(name);
    logger.info({ tool: name }, `[Registry] 成功挂载工具: ${name}`);
  }

  registerOwned(tool: BaseTool, owner: ToolRegistrationOwner): void {
    const name = tool.name();
    const existingOwner = this.toolOwners.get(name);
    if (this.tools.has(name)) {
      const ownerLabel = existingOwner
        ? `${existingOwner.kind}:${existingOwner.id}`
        : "an existing host tool";
      throw new Error(`Tool '${name}' conflicts with ${ownerLabel}`);
    }
    this.tools.set(name, tool);
    this.toolOwners.set(name, owner);
    logger.info({ tool: name, owner: `${owner.kind}:${owner.id}` }, `[Registry] 成功挂载工具`);
  }

  unregister(name: string): boolean {
    if (this.toolOwners.has(name)) return false;
    return this.unregisterForHostPolicy(name);
  }

  /** Explicit host policy boundary for pruning any tool from this per-run projection. */
  unregisterForHostPolicy(name: string): boolean {
    const removed = this.tools.delete(name);
    this.toolOwners.delete(name);
    if (removed) {
      logger.info({ tool: name }, `[Registry] 已卸载工具: ${name}`);
    }
    return removed;
  }

  unregisterOwned(name: string, owner: ToolRegistrationOwner): boolean {
    if (this.toolOwners.get(name) !== owner) return false;
    this.toolOwners.delete(name);
    const removed = this.tools.delete(name);
    if (removed) {
      logger.info({ tool: name, owner: `${owner.kind}:${owner.id}` }, `[Registry] 已卸载工具`);
    }
    return removed;
  }

  getToolOwner(name: string): ToolRegistrationOwner | undefined {
    return this.toolOwners.get(name);
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
    return [...this.tools.values()]
      .map((tool) => tool.definition())
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
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

    // 3. PreToolUse 位于不可绕过的安全门之后、权限审批与工具执行之前。
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
        const rewrittenRejection = await runMiddlewares(this.safetyMiddlewares, "safety");
        if (rewrittenRejection) return rewrittenRejection;
      }
    }

    // 4. Hook 改写并重过安全门后，才进入权限 Hook/人工审批。
    const permissionRejection = await runMiddlewares(
      [...this.permissionMiddlewares, ...this.requestMiddlewares],
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
      const executionContext: ToolExecutionContext = {
        ...(context ?? {}),
        toolCallId: currentCall.id,
      };
      let chain: (nextCall: ToolCall) => Promise<string> = async (nextCall) =>
        tool.execute(nextCall.arguments, executionContext);
      for (let i = this.executionMiddlewares.length - 1; i >= 0; i--) {
        const mw = this.executionMiddlewares[i]!;
        const next = chain;
        chain = (nextCall) => mw(nextCall, next, executionContext);
      }
      return {
        toolCallId: currentCall.id,
        output: await chain(currentCall),
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

// ==========================================
// 内置工具聚合门面:从独立文件 re-export,保持所有现有消费方 import 路径不变。
// 消费方(8 个 src 文件 + 17 个测试文件)继续从 "./registry-impl.js" 导入即可。
// ==========================================

export { ReadFileTool } from "./read-file.js";
export { WriteFileTool } from "./write-file.js";
export { EditFileTool, generateSimpleDiff } from "./edit-file.js";
export { TaskListTool, TaskOutputTool, TaskStopTool } from "./task.js";
export {
  BashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  resolveBashTimeoutMs,
} from "./bash.js";
export { safeResolve } from "./file-helpers.js";
