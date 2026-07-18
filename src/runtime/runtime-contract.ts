import type { CliSessionSelection } from "../cli/session-resolver.js";
import type { ImagePart, Message } from "../schema/message.js";
import type { ProviderKind } from "../provider/factory.js";
import type { CredentialRef } from "../provider/credential-vault.js";
import type { ModelRouteCapabilities } from "../provider/model-capabilities.js";
import type { SessionSettings } from "../input/session-settings.js";
import type { BackgroundYoloPolicySnapshotData } from "../safety/background-yolo-policy-schema.js";

/** Runtime execution mode selected by the host. */
export type RuntimeExecution =
  | { readonly kind: "foreground" }
  | { readonly kind: "background"; readonly policy: BackgroundYoloPolicySnapshotData };

/** Options consumed by the already-assembled RuntimeRun executor. */
export interface RuntimeRunOptions {
  /** TUI 中用户实际发送的文本，用作 /rewind 的可见名称。 */
  rewindPrompt?: string;
  /** 用户消息写入可见 transcript 前的条目下标。 */
  rewindTranscriptIndex?: number;
  /** 宿主可选记录该消息发送时的交互模式。 */
  rewindInteractionMode?: SessionSettings["mode"];
  /** 该消息在 plan 模式下发送时，记录进入 plan 前的模式。 */
  rewindPrePlanMode?: NonNullable<SessionSettings["prePlanMode"]>;
  /** 图片附件路径:读取为 ImagePart 附到本轮 user 消息。 */
  imagePath?: string;
  /** TUI/宿主已解析好的图片附件。 */
  images?: ImagePart[];
}

/** Public request accepted by AgentRuntime and its host adapters. */
export interface RunAgentCliOptions extends RuntimeRunOptions {
  prompt: string;
  /** 默认 foreground；daemon/Cron 必须显式提供完整 background policy。 */
  execution?: RuntimeExecution;
  dir?: string;
  /** 兼容旧 --session:按指定 id 恢复会话 */
  session?: string;
  /** Continue the latest session in the current project. */
  continueSession?: boolean;
  /** Resume a specific session. */
  resumeSession?: string;
  /** 从指定会话派生一个新会话 */
  forkSession?: string;
  /** 已解析的 session 选择结果(TUI/宿主可复用,避免每轮重新生成 id) */
  sessionSelection?: CliSessionSelection;
  provider?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  /** 后台执行只持有非秘密引用；明文由 Runtime Host 在系统凭证库边界解析。 */
  credentialRef?: CredentialRef;
  model?: string;
  modelRouteId?: string;
  modelCapabilities?: ModelRouteCapabilities;
  /** Active model reasoning level. Legacy CLI callers still pass off/low/medium/high. */
  thinkingEffort?: string;
  planMode?: boolean;
  /** Enable per-request JSON trace export. Also enabled by PICO_TRACE=1. */
  trace?: boolean;
  /** MCP 配置文件路径(--mcp-config)。提供则启动时连接所有 MCP server 并注册工具 */
  mcpConfigPath?: string;
  /** Steer text injected once before the run starts. */
  steer?: string;
  /** Claude Code 风格附加工作目录；可重复传入，当前会话内生效。 */
  addDirs?: string[];
  /** Per-run command restriction. Unknown names fail before the first provider call. */
  allowedTools?: readonly string[];
}

export interface RunAgentUsage {
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
}

export interface RunAgentCliResult {
  sessionId: string;
  sessionSelection: CliSessionSelection;
  workDir: string;
  finalMessage: string;
  usage: RunAgentUsage;
  messages: readonly Message[];
  tracePath?: string;
}

/** A UI-neutral lifecycle event for a runtime host. */
export interface RuntimeLifecycleEvent {
  type: "run.started" | "run.finished" | "run.failed";
  sessionId?: string;
  workDir?: string;
  at: number;
  detail?: string;
}
