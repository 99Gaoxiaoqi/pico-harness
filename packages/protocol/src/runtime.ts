// Public runtime barrel: domain contracts and validators are owned by runtime/*.ts.
export * from "./runtime/subagents.js";
import { automationParamValidators, automationResultValidators } from "./runtime/automation.js";
import { isJsonValue } from "./runtime/base.js";
import {
  capabilitiesParamValidators,
  capabilitiesResultValidators,
} from "./runtime/capabilities.js";
import { subagentsParamValidators, subagentsResultValidators } from "./runtime/subagents.js";
import { configParamValidators, configResultValidators } from "./runtime/config.js";
import { invalidResult } from "./runtime/errors.js";
import { memoryParamValidators, memoryResultValidators } from "./runtime/memory.js";
import { parseRuntimeParams } from "./runtime/methods.js";
import type { RuntimeMethod, RuntimeParams, RuntimeResult } from "./runtime/methods.js";
import {
  notificationsParamValidators,
  notificationsResultValidators,
} from "./runtime/notifications.js";
import { planningParamValidators, planningResultValidators } from "./runtime/planning.js";
import { sessionParamValidators, sessionResultValidators } from "./runtime/session.js";
import { transcriptParamValidators, transcriptResultValidators } from "./runtime/transcript.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./runtime/validation.js";
import { workbarParamValidators, workbarResultValidators } from "./runtime/workbar.js";
import { workspaceParamValidators, workspaceResultValidators } from "./runtime/workspace.js";

const RUNTIME_RESULT_VALIDATORS = {
  ...sessionResultValidators,
  ...transcriptResultValidators,
  ...configResultValidators,
  ...subagentsResultValidators,
  ...memoryResultValidators,
  ...planningResultValidators,
  ...capabilitiesResultValidators,
  ...workspaceResultValidators,
  ...automationResultValidators,
  ...workbarResultValidators,
  ...notificationsResultValidators,
} satisfies Readonly<Record<RuntimeMethod, RuntimeResultRule>>;

const STRICT_RUNTIME_PARAM_VALIDATORS = {
  ...sessionParamValidators,
  ...transcriptParamValidators,
  ...configParamValidators,
  ...subagentsParamValidators,
  ...memoryParamValidators,
  ...planningParamValidators,
  ...capabilitiesParamValidators,
  ...workspaceParamValidators,
  ...automationParamValidators,
  ...workbarParamValidators,
  ...notificationsParamValidators,
} satisfies Readonly<Record<RuntimeMethod, RuntimeParamValidator>>;

/**
 * Applies the exact, method-specific request contract used at privileged UI boundaries.
 * Unlike the transport parser, this rejects unknown keys and validates nested request objects.
 */
export function parseStrictRuntimeParams<Method extends RuntimeMethod>(
  method: Method,
  input: unknown,
): RuntimeParams<Method> {
  const params = parseRuntimeParams(method, input);
  STRICT_RUNTIME_PARAM_VALIDATORS[method](params);
  return params;
}

/**
 * Applies the method-specific response contract at every Runtime client boundary.
 */
export function parseRuntimeResult<Method extends RuntimeMethod>(
  method: Method,
  value: unknown,
): RuntimeResult<Method> {
  if (!isJsonValue(value)) throw invalidResult(`${method} result 必须是 JSON 值`);
  RUNTIME_RESULT_VALIDATORS[method](value, `${method} result`);
  return value as RuntimeResult<Method>;
}

export {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  LOCAL_RUNTIME_AUTH_VERSION,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  MAX_RUNTIME_FRAME_BYTES,
  MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES,
  EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS,
  isJsonObject,
  isJsonValue,
} from "./runtime/base.js";

export type {
  JsonScalar,
  JsonObject,
  JsonValue,
  Identifier,
  SessionId,
  RunId,
  JobId,
  ApprovalId,
  PlanId,
  PromptId,
  CheckpointId,
  EmptyParams,
  WorkspaceParams,
  WorkspaceRegistrationParams,
  RuntimeRunStatus,
  RuntimeSessionStatus,
  RuntimeRewindMode,
  RuntimeJobStatus,
  SessionSendBehavior,
  SessionSendDisposition,
  RuntimeCollaborationMode,
  RuntimeOrchestrationMode,
  RuntimePermissionMode,
  RuntimeProviderKind,
  RuntimeConfigSource,
  RuntimeCredentialStatus,
  RuntimeCredentialSource,
} from "./runtime/base.js";

export type {
  RuntimeMemoryItemKind,
  RuntimeMemoryStatementType,
  RuntimeMemoryTemporalType,
  RuntimeMemoryScopeType,
  RuntimeMemoryLifecycleState,
  RuntimeMemoryItemOrigin,
  RuntimeMemoryItemSource,
  RuntimeMemoryItem,
  RuntimeMemorySettings,
  RuntimeMemoryContextBudget,
} from "./runtime/memory.js";

export type {
  RuntimeProviderInput,
  RuntimeProviderProfile,
  RuntimeUserDefaults,
  RuntimeUserConfig,
  RuntimeEffectiveConfig,
} from "./runtime/config.js";

export type {
  RuntimeSessionSettings,
  RuntimeInputAttachment,
  RuntimeTextUserInput,
  RuntimeSkillUserInput,
  RuntimeAgentUserInput,
  RuntimeUserInput,
  RuntimeQueuedInput,
  RuntimeRun,
  RuntimeSession,
} from "./runtime/session.js";

export type {
  RuntimePlanStep,
  RuntimePlanProposal,
  RuntimePlanExecution,
  RuntimePlanRevisionRequest,
  RuntimePlanProjection,
  RuntimePlanControlSnapshot,
  RuntimeDiscoveryDepth,
  RuntimeDiscoveryStatus,
  RuntimeDiscoveryRun,
  RuntimeDiscoveryProjection,
  RuntimeGoalStatus,
  RuntimeGoal,
  RuntimeGoalSnapshot,
} from "./runtime/planning.js";

export type {
  RuntimeCatalogAgent,
  RuntimeCatalogSkill,
  RuntimeCapabilityScope,
  RuntimeCapabilitySourceMetadata,
  RuntimeScopedSkill,
  RuntimeMcpServerInput,
  RuntimeScopedMcpServer,
  RuntimeCapabilityRevisions,
  RuntimePluginDiagnostic,
} from "./runtime/capabilities.js";

export { TRANSCRIPT_PROJECTOR_VERSION } from "./runtime/transcript.js";

export type {
  RuntimeTranscriptWatermark,
  RuntimeTranscriptItemRecord,
  RuntimeTranscriptItemFragment,
  RuntimeTranscriptPageCursor,
  RuntimeTranscriptAdvanceCursor,
  RuntimeTranscriptChange,
  RuntimeActiveOverlayEntry,
  RuntimeSessionSubscriptionEnvelope,
  RuntimeSessionSubscriptionFrame,
  RuntimeToolResultEnvelope,
  RuntimeConversationItem,
} from "./runtime/transcript.js";

export type {
  RuntimeSessionTaskStatus,
  RuntimeSessionTask,
  RuntimeSessionArtifact,
  RuntimeSessionContextSnapshot,
  RuntimeGitReviewSource,
  RuntimeGitReviewFile,
  RuntimeTerminalStatus,
  RuntimeTerminalCapability,
  RuntimeTerminalSession,
  RuntimeBrowserAgentAction,
  RuntimeBrowserAgentCommand,
  RuntimeChange,
} from "./runtime/workbar.js";

export type { RuntimeJob } from "./runtime/automation.js";

export type {
  RuntimeWorkspaceInitResult,
  RuntimeDiagnosticCheck,
  RuntimeDiagnosticsReport,
  RuntimeResourceDiagnosticEntry,
  RuntimeResourceDiagnosticsReport,
  EventLogStorageStatusResult,
  WorkspaceStatusResult,
} from "./runtime/workspace.js";

export {
  RUNTIME_METHODS,
  DESKTOP_RUNTIME_METHODS,
  isRuntimeMethod,
  parseRuntimeParams,
} from "./runtime/methods.js";

export type {
  RuntimeMethodMap,
  RuntimeMethod,
  RuntimeMethodName,
  RuntimeParams,
  RuntimeResult,
  DesktopRuntimeMethod,
} from "./runtime/methods.js";

export {
  isEphemeralRuntimeNotificationTopic,
  isRuntimeNotification,
  createRuntimeNotification,
  serializeRuntimeNotification,
  isDiscoveryRuntimeNotification,
  isMemoryRuntimeNotification,
} from "./runtime/notifications.js";

export type {
  RuntimeNotificationMap,
  RuntimeNotificationTopic,
  EphemeralRuntimeNotificationTopic,
  RuntimeNotification,
  RuntimeNotificationPage,
  TypedRuntimeNotification,
} from "./runtime/notifications.js";

export {
  createRuntimeAuthRequest,
  createRuntimeAuthResult,
  createRuntimeRequest,
  createTypedRuntimeRequest,
  createRuntimeError,
  encodeRuntimeFrame,
  RuntimeFrameDecoder,
  parseRuntimeMessage,
} from "./runtime/transport.js";

export type {
  RuntimeRequest,
  RuntimeSuccessResponse,
  RuntimeErrorResponse,
  RuntimeNotificationMessage,
  RuntimeAuthRequest,
  RuntimeAuthResult,
  RuntimeResponse,
  RuntimeMessage,
} from "./runtime/transport.js";

export { RUNTIME_ERROR_CODES, RuntimeProtocolError, isRuntimeErrorCode } from "./runtime/errors.js";

export type { RuntimeErrorCode } from "./runtime/errors.js";
