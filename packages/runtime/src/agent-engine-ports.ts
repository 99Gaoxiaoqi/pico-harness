import type { Message, ToolCall, ToolDefinition } from "@pico/core";
import type {
  RuntimeFullCompactionInMemorySession,
  FullCompactorLogger,
} from "./full-compactor.js";
import type { EngineRuntimeCapability, EngineRuntimeWriteGuard } from "./runtime-capability.js";
import type { RuntimePort, RuntimeRunPort } from "./runtime-port-contract.js";
import type {
  RuntimeToolRegistry,
  ToolExecutionContext,
  ToolRecoveryProbeResult,
} from "./runtime-tool-execution.js";
import type { ToolAccesses } from "./tool-access.js";
import type { Span } from "./trace.js";

/** Model-facing session operations; persistence and filesystem ownership stay in Host. */
export interface EngineSession
  extends RuntimeFullCompactionInMemorySession, EngineRuntimeWriteGuard {
  readonly workDir: string;
  readonly runtimeEventStore?: { readonly storageRoot: string } | undefined;
  readonly runtimeEventCapability?: EngineRuntimeCapability | undefined;
  readonly length: number;
  readonly totalCostCNY: number;
  serialize<T>(task: () => Promise<T>): Promise<T>;
  flushPersistence(): Promise<void>;
  getHistory(): Message[];
  getModelContext(): Message[];
  commitMessages(...messages: Message[]): Promise<void>;
  truncateTo(fromIndex: number): Promise<void>;
  preparePromptCacheSharding(
    routeIdentity: string,
    messages: readonly Message[],
    routeThresholdActive: boolean,
  ): { shardSeed?: string; active: boolean };
}

export type EngineToolFileSideEffects =
  | { readonly kind: "none" }
  | { readonly kind: "exact"; readonly paths: readonly string[] }
  | { readonly kind: "workspace" };

/** No registration, middleware, hooks, configuration or physical implementations. */
export interface EngineToolRegistry extends RuntimeToolRegistry {
  getAvailableTools(): ToolDefinition[];
  isReadOnlyTool?(name: string): boolean;
  getFileSideEffects?(call: ToolCall): EngineToolFileSideEffects;
  getAccesses?(call: ToolCall): ToolAccesses;
  setPreWriteHook?(hook: (toolName: string, args: string) => Promise<void>): void;
}

export type EngineRuntimeRun = RuntimeRunPort<
  EngineSession,
  EngineToolRegistry,
  ToolExecutionContext,
  ToolRecoveryProbeResult
>;
export type EngineRuntimePort = RuntimePort<
  EngineSession,
  EngineToolRegistry,
  ToolExecutionContext,
  ToolRecoveryProbeResult
>;

export interface EnginePromptLayers {
  readonly systemPrompt: string;
  readonly turnTail: string;
}

export interface EngineSkillLoader {
  loadAll(): Promise<string>;
}

export type EngineHookEvent =
  | "PreCompact"
  | "PostCompact"
  | "Stop"
  | "FileChanged"
  | "PostToolBatch"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "MessageDisplay";
export interface EngineHookService {
  dispatch(
    event: EngineHookEvent,
    payload: Record<string, unknown>,
    context?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{
    readonly decision: "allow" | "ask" | "defer" | "deny";
    readonly reason?: string;
    readonly additionalContext?: string;
  }>;
}

/** One run's physical file journal; Runtime controls ordering but cannot inspect its contents. */
export interface EngineFileHistoryScope {
  trackToolWrite(toolName: string, args: string): Promise<void>;
  beginJournal(signal?: AbortSignal): Promise<void>;
  addJournalWarning(message: string): void;
  commit(): Promise<readonly string[]>;
  finish(): void;
}

export interface EngineHostServices {
  sessionCapability(session: EngineSession): string;
  createFileHistoryScope(
    session: EngineSession,
    registry: EngineToolRegistry,
  ): EngineFileHistoryScope;
  buildPlanPrompt(signal?: AbortSignal): Promise<EnginePromptLayers>;
  exportTrace(root: Span, session: EngineSession): string;
}

export type EngineDiagnostics = FullCompactorLogger;
export const SILENT_ENGINE_DIAGNOSTICS: EngineDiagnostics = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
