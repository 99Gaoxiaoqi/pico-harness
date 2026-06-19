// 工具注册与分发接口。
// 对应课程第 05 讲 internal/tools/registry.go。
// Main Loop 永远是"瞎子聋子",不该知道工具怎么实现。
// Registry 是集线器(Hub)+ 路由器(Router):动态挂载、暴露 Schema、路由分发。

import type { ToolCall, ToolDefinition, ToolResult } from "../schema/message.js";

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
  execute(args: string): Promise<string>;
  /**
   * 是否为只读工具 (第 08 讲并发调度用)。
   * 只读工具的批次可并行执行;含写操作的批次退化为串行。
   * 默认 false (保守视为写操作)。
   */
  readOnly?: boolean;
}

/** 工具的注册与分发接口 */
export interface Registry {
  /** 挂载一个新的工具到系统中 */
  register(tool: BaseTool): void;
  /** 返回当前系统挂载的所有工具的 Schema,供 Main Loop 交给 Provider */
  getAvailableTools(): ToolDefinition[];
  /** 实际路由并执行模型请求的工具调用 */
  execute(call: ToolCall): Promise<ToolResult>;
  /**
   * 判断工具是否为只读 (第 08 讲)。
   * 引擎据此决定批次是否可并发:全只读则并行,有写操作则串行。
   * 默认返回 false (保守视为写操作)。
   */
  isReadOnlyTool?(name: string): boolean;
}

/**
 * 把 BaseTool 适配成第 02 讲遗留的 Tool 接口 (definition 属性 + execute(call))。
 * 新代码应直接实现 BaseTool;此适配器仅为过渡兼容。
 */
export interface Tool {
  definition: ToolDefinition;
  execute(call: ToolCall): Promise<ToolResult>;
}
