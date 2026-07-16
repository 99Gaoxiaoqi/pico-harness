/** Pico 前台 Hook 的公开事件集合。暂未具备宿主生命周期的事件仍保留类型但不伪造触发。 */
export const HOOK_EVENTS = [
  "SessionStart",
  "Setup",
  "InstructionsLoaded",
  "SessionEnd",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "MessageDisplay",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "Stop",
  "StopFailure",
  "Notification",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookSourceKind =
  | "user"
  | "project"
  | "local"
  | "legacy"
  | "skill"
  | "agent"
  | "managed"
  | "plugin";

export interface HookSource {
  kind: HookSourceKind;
  path: string;
  /** 同一路径重载时递增，便于诊断在途事件使用了哪个不可变快照。 */
  version: number;
  componentId?: string;
}

interface HookHandlerBase {
  /** Canonical 配置单位为秒；legacy 加载器会在归一化时换算为毫秒。 */
  timeout?: number;
  /** 归一化后的实际超时，运行时只读取此字段。 */
  timeoutMs?: number;
  if?: HookCondition;
  enabled?: boolean;
}

export interface CommandHookHandler extends HookHandlerBase {
  type: "command";
  command: string;
  /** 存在时直接使用 exec form；缺省时只解析静态参数，不启用 Shell。 */
  args?: readonly string[];
  async?: boolean;
  asyncRewake?: boolean;
  env?: Readonly<Record<string, string>>;
}

export interface HttpHookHandler extends HookHandlerBase {
  type: "http";
  url: string;
  headers?: Readonly<Record<string, string>>;
  allowedEnv?: readonly string[];
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface McpToolHookHandler extends HookHandlerBase {
  type: "mcp_tool";
  server: string;
  tool: string;
  input?: unknown;
}

export interface PromptHookHandler extends HookHandlerBase {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface AgentHookHandler extends HookHandlerBase {
  type: "agent";
  prompt: string;
  model?: string;
  maxTurns?: number;
}

export type HookHandler =
  | CommandHookHandler
  | HttpHookHandler
  | McpToolHookHandler
  | PromptHookHandler
  | AgentHookHandler;

export interface HookMatcherGroup {
  matcher?: string;
  if?: HookCondition;
  hooks: HookHandler[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcherGroup[]>>;

export type HookCondition =
  | { op: "equals"; path: string; value: string | number | boolean | null }
  | { op: "contains"; path: string; value: string }
  | { op: "regex"; path: string; pattern: string }
  | { op: "exists"; path: string; value?: boolean };

export interface HookEventPayloadMap {
  SessionStart: { source: "startup" | "resume" };
  Setup: { action: string };
  InstructionsLoaded: { paths: readonly string[] };
  SessionEnd: { reason: string };
  UserPromptSubmit: { prompt: string };
  UserPromptExpansion: { prompt: string; expandedPrompt: string };
  MessageDisplay: { role: string; content: string };
  PreToolUse: ToolHookPayload;
  PermissionRequest: ToolHookPayload & { reason?: string };
  PermissionDenied: ToolHookPayload & { source: string; reason: string };
  PostToolUse: ToolHookPayload & { tool_response: string };
  PostToolUseFailure: ToolHookPayload & { error: string };
  PostToolBatch: { tools: readonly ToolBatchItem[] };
  SubagentStart: { agentId: string; agentType?: string; prompt?: string };
  SubagentStop: { agentId: string; status: string; result?: string };
  TaskCreated: { taskId: string; subject: string };
  TaskCompleted: { taskId: string; status: string };
  TeammateIdle: { teammateId: string };
  Stop: { reason: string; response?: string };
  StopFailure: { category: string; error: string };
  Notification: { level: string; message: string };
  ConfigChange: { paths: readonly string[]; proposedHash: string };
  CwdChanged: { from: string; to: string };
  FileChanged: { paths: readonly string[]; origin: "internal" | "external" };
  WorktreeCreate: { path: string; branch?: string };
  WorktreeRemove: { path: string; branch?: string };
  PreCompact: { source: "auto" | "manual"; messageCount: number };
  PostCompact: { source: "auto" | "manual"; messageCount: number };
  Elicitation: { server: string; request: unknown };
  ElicitationResult: { server: string; result: unknown };
}

export interface ToolHookPayload {
  tool_name: string;
  tool_input: unknown;
  tool_call_id?: string;
}

export interface ToolBatchItem extends ToolHookPayload {
  ok: boolean;
  output?: string;
}

/** 传给 handler 的稳定 envelope；snake_case 字段兼容现有 command hook。 */
export type HookInput<E extends HookEvent = HookEvent> = {
  session_id: string;
  cwd: string;
  hook_event_name: E;
  payload: HookEventPayloadMap[E];
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: string;
};

export type HookDecision = "allow" | "ask" | "defer" | "deny";

export interface HookOutput {
  decision: HookDecision;
  reason?: string;
  modifiedInput?: unknown;
  additionalContext?: string;
  diagnostics?: readonly HookDiagnostic[];
}

export interface HookDiagnostic {
  handlerId: string;
  source: HookSource;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ResolvedHookHandler {
  id: string;
  event: HookEvent;
  source: HookSource;
  order: number;
  matcher?: string;
  groupCondition?: HookCondition;
  handler: HookHandler;
  trusted: boolean;
}

export interface HookSnapshot {
  id: string;
  version: number;
  createdAt: string;
  handlers: Readonly<Record<HookEvent, readonly ResolvedHookHandler[]>>;
  diagnostics: readonly HookDiagnostic[];
}

export interface HookExecutionContext {
  signal?: AbortSignal;
  /** 内部 prompt/agent handler 必须设为 true，禁止递归触发 Hook。 */
  suppressHooks?: boolean;
}
