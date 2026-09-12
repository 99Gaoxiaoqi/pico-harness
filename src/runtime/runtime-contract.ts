import type { CliSessionSelection } from "../cli/session-resolver.js";
import type { ImagePart, Message } from "../schema/message.js";
import type { ProviderKind } from "../provider/factory.js";
import type { CredentialRef } from "../provider/credential-vault.js";
import type { ModelRouteCapabilities } from "../provider/model-capabilities.js";
import type { CollaborationMode, PermissionMode } from "../input/session-settings.js";
import type { BackgroundAutonomousPolicySnapshotData } from "../safety/background-autonomous-policy-schema.js";
import type { PlanHandoff } from "../engine/plan-handoff.js";

/** Runtime execution mode selected by the host. */
export type RuntimeExecution =
  | { readonly kind: "foreground" }
  | { readonly kind: "background"; readonly policy: BackgroundAutonomousPolicySnapshotData };

/** Options consumed by the already-assembled RuntimeRun executor. */
export interface RuntimeRunOptions {
  /** Host-resolved, durable source of Swarm authorization for this Run. */
  agentSwarmAuthorization?: import("../engine/session-runtime-event.js").AgentSwarmAuthorizationSource;

  /** TUI 中用户实际发送的文本，用作 /rewind 的可见名称。 */
  rewindPrompt?: string;
  /** 用户消息写入可见 transcript 前的条目下标。 */
  rewindTranscriptIndex?: number;
  /** 宿主可选记录该消息发送时的协作轴。必须与 permissionMode 成对提供。 */
  rewindCollaborationMode?: CollaborationMode;
  /** 宿主可选记录该消息发送时的权限轴。必须与 collaborationMode 成对提供。 */
  rewindPermissionMode?: PermissionMode;
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
  /** Host-resolved canonical Session selection. */
  sessionSelection: CliSessionSelection;
  provider?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  auth?: "api-key" | "none";
  /** 后台执行只持有非秘密引用；明文由 Runtime Host 在系统凭证库边界解析。 */
  credentialRef?: CredentialRef;
  model?: string;
  /** Stable providerID/modelID identity required by every durable Runtime Session. */
  modelRouteId: string;
  modelCapabilities?: ModelRouteCapabilities;
  /** Host-selected collaboration policy for a new foreground Session. */
  collaborationMode?: CollaborationMode;
  /** Host-selected permission policy for a new foreground Session. */
  permissionMode?: PermissionMode;
  /** Active model reasoning level. Legacy CLI callers still pass off/low/medium/high. */
  thinkingEffort?: string;
  /** Turn-level orchestration override: "graph" or "swarm" enables coordinated execution for this run. */
  orchestrationMode?: "default" | "graph" | "swarm";
  /** Enable per-request JSON trace export. Also enabled by PICO_TRACE=1. */
  trace?: boolean;
  /** MCP 配置文件路径。提供则启动时连接所有 MCP server 并注册工具 */
  mcpConfigPath?: string;
  /** Steer text injected once before the run starts. */
  steer?: string;
  /** Claude Code 风格附加工作目录；可重复传入，当前会话内生效。 */
  addDirs?: string[];
  /** Per-run command restriction. Unknown names fail before the first provider call. */
  allowedTools?: readonly string[];
  /** Internal/public host entry for a newly approved execution Run. */
  approvedPlan?: {
    readonly planId: string;
    readonly revision: number;
    readonly expectedSessionSequence: number;
    readonly operationId?: string;
    readonly claimOperationId?: string;
    readonly transition?: "start" | "resume";
  };
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
  /** Pending plan review emitted by a normally completed planning run. */
  handoff?: PlanHandoff;
  /** Present when an idempotent control operation was replayed without starting another Run. */
  replayedOperationId?: string;
}

/** A UI-neutral lifecycle event for a runtime host. */
export interface RuntimeLifecycleEvent {
  type: "run.started" | "run.finished" | "run.failed";
  sessionId?: string;
  workDir?: string;
  at: number;
  detail?: string;
}
