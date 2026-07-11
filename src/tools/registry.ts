// 工具注册与分发接口。
// 对应课程第 05 讲 internal/tools/registry.go。
// Main Loop 永远是"瞎子聋子",不该知道工具怎么实现。
// Registry 是集线器(Hub)+ 路由器(Router):动态挂载、暴露 Schema、路由分发。

import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";

export type ToolOutputStream = "stdout" | "stderr";

export interface ToolOutputChunk {
  readonly stream: ToolOutputStream;
  readonly chunk: string;
}

/**
 * 单次工具调用的运行时上下文。
 *
 * 上下文由 Engine 按 tool call 创建，Registry 只负责透传。工具实现应在
 * 可中断的物理操作中直接使用 signal，不要只在 execute() 返回后检查。
 */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: ToolOutputChunk) => void;
}

/**
 * Middleware 中间件签名 (第 16 讲)。
 * 在 Registry 收到 ToolCall 后、真正调用 tool.execute() 之前运行。
 * 返回 allowed=false 则拦截,reason 作为 Error 反馈给大模型;
 * 返回 allowed=true 则放行,继续下一个中间件或执行工具。
 *
 * 异步签名以支持人工审批挂起 (Human-in-the-loop):中间件可阻塞等待
 * 飞书审批结果,大模型甚至不知道自己被挂起了。
 */
export interface RequestMiddlewareResult {
  allowed: boolean;
  reason?: string;
  call?: ToolCall;
}

export type RequestMiddleware = (call: ToolCall) => Promise<RequestMiddlewareResult>;
export type ExecutionMiddleware = (
  call: ToolCall,
  next: (call: ToolCall) => Promise<string>,
  context?: ToolExecutionContext,
) => Promise<string>;
export type MiddlewareFunc = RequestMiddleware;

/**
 * BaseTool:所有具体工具必须实现的通用接口。
 * 一个工具必须能说出自己的名字、给出参数 Schema,并接收原始 JSON 参数执行。
 * 参数是原始 JSON 字符串,反序列化由各工具内部自行处理 —— 延迟解析、极致解耦。
 */
export interface BaseTool {
  /** 返回工具的全局唯一名称 (大模型通过这个名字调用它) */
  name(): string;
  /** 返回提交给大模型的工具元信息和参数 JSON Schema */
  definition(): ToolDefinition;
  /** 接收大模型吐出的 JSON 参数,执行具体业务逻辑 */
  execute(args: string, context?: ToolExecutionContext): Promise<string>;
  /** true 表示工具会在 signal abort 后终止物理操作并 settle execute Promise。 */
  handlesAbortSignal?: boolean;
  /**
   * 是否为只读工具 (第 08 讲并发调度用)。
   * 只读工具的批次可并行执行;含写操作的批次退化为串行。
   * 默认 false (保守视为写操作)。
   */
  readOnly?: boolean;
  /**
   * 声明本次调用要访问的资源(资源冲突图调度用,对标 kimi-code ToolAccesses)。
   *
   * 接收原始 JSON 参数字符串(与 execute 一致,延迟解析),返回资���访问集。
   * 调度器据此判定同批次工具能否并行:
   *   - 不冲突(read+read / write 不同文件)→ 并行
   *   - 冲突(同文件含写 / kind:"all")→ 串行
   *
   * 未实现此方法的工具按 ToolAccesses.all() 保守处理(全局互斥)。
   * readOnly 字段仍保留,供 Guardrail 无进展告警等布尔语义场景使用。
   */
  accesses?(args: string): ToolAccesses;
  /** 该工具单次返回的最大字符数;未设置时使用 Registry 默认值 */
  maxResultSizeChars?: number;
  /** 工具所属工具集,供未来 subagent/MCP 分组授权 */
  toolset?: string;
}

/** 工具的注册与分发接口 */
export interface Registry {
  /** 挂载一个新的工具到系统中 */
  register(tool: BaseTool): void;
  /** 按名称卸载工具,用于动态工具生命周期清理 */
  unregister?(name: string): boolean;
  /** 【第 16 讲】全局挂载一个安全拦截中间件 */
  use(mw: MiddlewareFunc): void;
  /** request 阶段中间件:可拦截或改写参数 */
  useRequest?(mw: RequestMiddleware): void;
  /** execution 阶段中间件:可包裹实际执行 */
  useExecution?(mw: ExecutionMiddleware): void;
  /** 返回当前系统挂载的所有工具的 Schema,供 Main Loop 交给 Provider */
  getAvailableTools(): ToolDefinition[];
  /** 实际路由并执行模型请求的工具调用 */
  execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>;
  /**
   * 判断工具是否为只读 (第 08 讲)。
   * 引擎据此决定批次是否可并发:全只读则并行,有写操作则串行。
   * 默认返回 false (保守视为写操作)。
   */
  isReadOnlyTool?(name: string): boolean;
  /** 工具是否会在 abort 后自主收口，供调度器决定是否等待物理终止。 */
  handlesAbortSignal?(name: string): boolean;
  /**
   * 按 ToolCall 计算资源访问集(资源冲突图调度用)。
   * 带完整 call 而非仅 name,因为路径信息在 call.arguments 里。
   * 未实现则调度器按 ToolAccesses.all() 保守处理。
   */
  getAccesses?(call: ToolCall): ToolAccesses;
  setPreWriteHook?(hook: (toolName: string, args: string) => Promise<void>): void;
  /** 【任务 2.6】挂载 HookRunner,启用 PreToolUse/PostToolUse 钩子 */
  setHookRunner?(runner: import("../hooks/runner.js").HookRunner): void;
  /** 【任务 2.6】设置传给 hook stdin 的 session_id */
  setSessionId?(sessionId: string): void;
}

/**
 * 把 BaseTool 适配成第 02 讲遗留的 Tool 接口 (definition 属性 + execute(call))。
 * 新代码应直接实现 BaseTool;此适配器仅为过渡兼容。
 */
export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolResult>;
}
