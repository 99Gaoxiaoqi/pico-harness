// 用户可配置 Shell Hooks 的类型定义。
//
// 对应任务 2.6:PreToolUse / PostToolUse 钩子协议。
// 协议事实标准(对齐 Claude Code / Codex / Kimi Code 三家):
//   - stdin 传 JSON:{session_id, cwd, hook_event_name, tool_name, tool_input}
//   - exit code:0=放行,2=阻断(stderr 给模型),其他=fail-open 放行
//   - stdout JSON:{permissionDecision:"deny",...} 或 {decision:"block",...} → 阻断
//   - **fail-open 铁律**:任何故障都不能阻断工具

/**
 * 钩子事件类型。
 * - PreToolUse:工具执行前触发,可阻断或改写工具输入
 * - PostToolUse:工具执行后触发,fire-and-forget,不阻断
 */
export type HookEvent = "PreToolUse" | "PostToolUse";

/**
 * 单个钩子处理器。
 * 当前仅支持 "command" 类型:执行一段 shell 命令,通过 stdin 传 JSON,靠 exit code / stdout JSON 判定。
 */
export interface HookHandler {
  type: "command";
  /** shell 命令文本,会经 child_process.spawn({shell:true}) 执行 */
  command: string;
  /** 超时(毫秒),默认 60s。超时后 kill 子进程并 fail-open 放行 */
  timeout?: number;
}

/**
 * 一组带 matcher 的钩子。
 * matcher 控制这组 hooks 命中哪些工具名:
 *   - 省略 / "*" / 空 → 全匹配
 *   - 纯 [A-Za-z0-9_|] → 精确 | 分隔匹配
 *   - 其他 → 作为正则匹配 tool_name
 */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

/**
 * 完整 hooks 配置:每个事件下挂多组 matcher+hooks。
 * 来源:<workDir>/.claw/settings.json 的 `hooks` 字段。
 */
export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

/**
 * 传给 hook 子进程 stdin 的输入 JSON。
 * 对齐三家协议:{session_id, cwd, hook_event_name, tool_name, tool_input}。
 * PostToolUse 额外带 tool_response。
 */
export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: HookEvent;
  tool_name: string;
  tool_input: unknown;
  /** PostToolUse 才有:工具返回的输出文本 */
  tool_response?: string;
}

/**
 * Hook 执行结果(仅 PreToolUse 有意义;PostToolUse 为 fire-and-forget)。
 * - decision:"deny" → 阻断工具执行,reason 反馈给模型
 * - decision:"allow" → 放行
 * - modifiedInput:若 PreToolUse hook 改写了工具输入,registry 会替换 arguments
 */
export interface HookOutput {
  decision: "allow" | "deny";
  reason?: string;
  modifiedInput?: unknown;
}
