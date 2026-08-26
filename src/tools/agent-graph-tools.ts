import type {
  AgentGraph,
  AgentGraphActivationClaim,
  AgentGraphActivationIntent,
  AgentGraphOperator,
  AgentGraphOperatorProvision,
  AgentGraphRecordRef,
  AgentGraphScheduleCommand,
  AgentGraphStopCommand,
  AgentGraphOperationSource,
  JsonValue,
} from "../agent-graph/core/contracts.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";

export const AGENT_GRAPH_MAX_COMMANDS = 32;
export const AGENT_GRAPH_MAX_INPUT_REFS = 64;
export const AGENT_GRAPH_MAX_SELECTED_RECORDS = 64;
export const AGENT_GRAPH_MAX_PROFILE_TOOLS = 64;
export const AGENT_GRAPH_MAX_INSTRUCTION_BYTES = 32 * 1024;
export const AGENT_GRAPH_MAX_JSON_BYTES = 64 * 1024;

const MAX_IDENTITY_BYTES = 1024;
const MAX_SHORT_TEXT_BYTES = 2 * 1024;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_POLICY_JSON_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ARRAY_ITEMS = 256;

/** Runtime-owned identity for the exact root Supervisor activation. */
export interface AgentGraphRootToolContext {
  readonly kind: "graph_root_supervisor";
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
}

/** Stable, authority-free view assembled by the Graph application service. */
export interface AgentGraphSupervisorProjection {
  readonly graph: AgentGraph;
  readonly operators: readonly AgentGraphOperator[];
  readonly intents: readonly AgentGraphActivationIntent[];
  readonly stops: readonly AgentGraphStopCommand[];
  readonly provisions: readonly AgentGraphOperatorProvision[];
  readonly claims: readonly AgentGraphActivationClaim[];
  readonly records: readonly AgentGraphRecordRef[];
}

export interface CommitAgentGraphUpdateInput {
  readonly graphId: string;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly source: AgentGraphOperationSource;
  readonly commands: readonly AgentGraphScheduleCommand[];
}

export interface CommitAgentGraphUpdateResult {
  readonly revision: number;
  readonly replayed: boolean;
  readonly projection: AgentGraphSupervisorProjection;
}

export interface ReadAgentGraphProjectionInput {
  readonly graphId: string;
  readonly rootSessionId: string;
}

export interface RegisterAgentGraphYieldInput {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly toolCallId: string;
}

export interface RegisterAgentGraphYieldResult {
  readonly permitId: string;
  readonly replayed?: boolean;
  readonly snapshot: AgentGraphSupervisorProjection;
}

/** Thin application boundary: tools never own Graph storage, reconciliation, or Runtime execution. */
export interface AgentGraphSupervisorToolPort {
  commitUpdate(input: CommitAgentGraphUpdateInput): Promise<CommitAgentGraphUpdateResult>;
  readProjection(input: ReadAgentGraphProjectionInput): Promise<AgentGraphSupervisorProjection>;
  registerYield(input: RegisterAgentGraphYieldInput): Promise<RegisterAgentGraphYieldResult>;
}

export interface CreateAgentGraphSupervisorToolsOptions {
  readonly getRootContext: () => AgentGraphRootToolContext | undefined;
  readonly port: AgentGraphSupervisorToolPort;
}

abstract class AgentGraphSupervisorTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly toolset = "agent-graph";
  abstract readonly readOnly: boolean;

  constructor(protected readonly options: CreateAgentGraphSupervisorToolsOptions) {}

  abstract name(): string;
  abstract definition(): ToolDefinition;
  abstract execute(args: string, context?: ToolExecutionContext): Promise<string>;

  accesses(_args: string): ToolAccesses {
    return ToolAccesses.none();
  }

  protected rootContext(): AgentGraphRootToolContext {
    return requireRootContext(this.options.getRootContext());
  }
}

class UpdateAgentGraphTool extends AgentGraphSupervisorTool {
  readonly readOnly = false;

  name(): string {
    return "update_agent_graph";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "以 expected_revision CAS 原子提交一批 Graph schedule 命令。只写持久调度意图，不会在工具调用中直接执行 Operator。",
      inputSchema: {
        type: "object",
        properties: {
          expected_revision: { type: "integer", minimum: 0 },
          operation_id: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: AGENT_GRAPH_MAX_COMMANDS,
            items: {
              oneOf: [addCommandSchema(), stopCommandSchema(), finishCommandSchema()],
            },
          },
        },
        required: ["expected_revision", "operation_id", "commands"],
        additionalProperties: false,
      },
    };
  }

  async execute(args: string, execution?: ToolExecutionContext): Promise<string> {
    execution?.signal?.throwIfAborted();
    const root = this.rootContext();
    const toolCallId = requiredIdentity(execution?.toolCallId, "toolCallId");
    const input = parseUpdateInput(args, root, toolCallId);
    const result = await this.options.port.commitUpdate(input);
    execution?.signal?.throwIfAborted();
    validateProjection(result.projection, root);
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) {
      throw new Error("update_agent_graph 应用服务返回了非法 revision。");
    }
    if (typeof result.replayed !== "boolean") {
      throw new Error("update_agent_graph 应用服务返回了非法 replayed。");
    }
    return JSON.stringify(result);
  }
}

class ViewAgentGraphTool extends AgentGraphSupervisorTool {
  readonly readOnly = true;

  name(): string {
    return "view_agent_graph";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "读取当前 Graph 的领域投影，包括 schedule、Operator、Intent、Provision、Claim 和 RecordRef。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  }

  async execute(args: string, execution?: ToolExecutionContext): Promise<string> {
    execution?.signal?.throwIfAborted();
    parseEmptyInput(args, this.name());
    const root = this.rootContext();
    const projection = await this.options.port.readProjection({
      graphId: root.graphId,
      rootSessionId: root.rootSessionId,
    });
    execution?.signal?.throwIfAborted();
    validateProjection(projection, root);
    return JSON.stringify(projection);
  }
}

class YieldAgentGraphTool extends AgentGraphSupervisorTool {
  readonly readOnly = false;

  name(): string {
    return "yield_agent_graph";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "先持久化当前根 Supervisor Run 的 yield permit，再返回竞态安全的 Graph snapshot。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    };
  }

  async execute(args: string, execution?: ToolExecutionContext): Promise<string> {
    execution?.signal?.throwIfAborted();
    parseEmptyInput(args, this.name());
    const root = this.rootContext();
    const toolCallId = requiredIdentity(execution?.toolCallId, "toolCallId");
    const receipt = await this.options.port.registerYield({
      graphId: root.graphId,
      rootSessionId: root.rootSessionId,
      rootTurnId: root.rootTurnId,
      rootRunId: root.rootRunId,
      toolCallId,
    });
    execution?.signal?.throwIfAborted();
    requiredIdentity(receipt.permitId, "permitId");
    if (receipt.replayed !== undefined && typeof receipt.replayed !== "boolean") {
      throw new Error("yield_agent_graph 应用服务返回了非法 replayed。");
    }
    validateProjection(receipt.snapshot, root);
    return JSON.stringify(receipt);
  }
}

export function createAgentGraphSupervisorTools(
  options: CreateAgentGraphSupervisorToolsOptions,
): readonly BaseTool[] {
  return [
    new UpdateAgentGraphTool(options),
    new ViewAgentGraphTool(options),
    new YieldAgentGraphTool(options),
  ];
}

function parseUpdateInput(
  args: string,
  root: AgentGraphRootToolContext,
  toolCallId: string,
): CommitAgentGraphUpdateInput {
  const value = parseJsonObject(args, "update_agent_graph");
  assertKeys(
    value,
    ["expected_revision", "operation_id", "commands"],
    ["expected_revision", "operation_id", "commands"],
  );
  const expectedRevision = nonNegativeInteger(value["expected_revision"], "expected_revision");
  const operationId = requiredIdentity(value["operation_id"], "operation_id");
  const rawCommands = value["commands"];
  if (!Array.isArray(rawCommands) || rawCommands.length < 1) {
    throw new Error("update_agent_graph 参数无效：commands 必须是非空数组。");
  }
  if (rawCommands.length > AGENT_GRAPH_MAX_COMMANDS) {
    throw new Error(
      `update_agent_graph 参数无效：commands 不得超过 ${AGENT_GRAPH_MAX_COMMANDS} 项。`,
    );
  }
  const source: AgentGraphOperationSource = {
    sessionId: root.rootSessionId,
    turnId: root.rootTurnId,
    runId: root.rootRunId,
    toolCallId,
  };
  const commands = rawCommands.map((command, index) =>
    parseCommand(command, index, root.graphId, expectedRevision + 1, source),
  );
  const finishIndexes = commands.flatMap((command, index) =>
    command.kind === "finish" ? [index] : [],
  );
  if (
    finishIndexes.length > 1 ||
    (finishIndexes.length === 1 && finishIndexes[0] !== commands.length - 1)
  ) {
    throw new Error("update_agent_graph 参数无效：finish 最多一条且必须是最后一条命令。");
  }
  return {
    graphId: root.graphId,
    expectedRevision,
    operationId,
    source,
    commands,
  };
}

function parseCommand(
  value: unknown,
  index: number,
  graphId: string,
  createdAtRevision: number,
  source: AgentGraphOperationSource,
): AgentGraphScheduleCommand {
  if (!isRecord(value)) {
    throw new Error(`update_agent_graph 参数无效：commands[${index}] 必须是对象。`);
  }
  const kind = value["kind"];
  if (kind === "add") return parseAddCommand(value, index, graphId, createdAtRevision, source);
  if (kind === "stop") return parseStopCommand(value, index);
  if (kind === "finish") return parseFinishCommand(value, index);
  throw new Error(
    `update_agent_graph 参数无效：commands[${index}].kind 必须是 add、stop 或 finish。`,
  );
}

function parseAddCommand(
  value: Record<string, unknown>,
  index: number,
  graphId: string,
  createdAtRevision: number,
  source: AgentGraphOperationSource,
): AgentGraphScheduleCommand {
  const path = `commands[${index}]`;
  assertKeys(value, ["kind", "operator", "intent"], ["kind", "operator", "intent"], path);
  const rawOperator = objectField(value["operator"], `${path}.operator`);
  assertKeys(
    rawOperator,
    ["operator_id", "generation", "role", "description", "profile", "workspace"],
    ["operator_id", "generation", "role", "profile", "workspace"],
    `${path}.operator`,
  );
  const rawProfile = objectField(rawOperator["profile"], `${path}.operator.profile`);
  assertKeys(
    rawProfile,
    ["profile_id", "model", "tools", "permission_policy", "system_prompt_version"],
    ["profile_id", "tools", "permission_policy", "system_prompt_version"],
    `${path}.operator.profile`,
  );
  const tools = identityArray(
    rawProfile["tools"],
    `${path}.operator.profile.tools`,
    AGENT_GRAPH_MAX_PROFILE_TOOLS,
  );
  const profile = {
    profileId: requiredIdentity(rawProfile["profile_id"], `${path}.operator.profile.profile_id`),
    ...(rawProfile["model"] === undefined
      ? {}
      : { model: requiredIdentity(rawProfile["model"], `${path}.operator.profile.model`) }),
    tools,
    permissionPolicy: boundedJsonValue(
      rawProfile["permission_policy"],
      `${path}.operator.profile.permission_policy`,
    ),
    systemPromptVersion: requiredIdentity(
      rawProfile["system_prompt_version"],
      `${path}.operator.profile.system_prompt_version`,
    ),
  };
  const rawWorkspace = objectField(rawOperator["workspace"], `${path}.operator.workspace`);
  const workspace = parseWorkspace(rawWorkspace, `${path}.operator.workspace`);
  const operatorId = requiredIdentity(rawOperator["operator_id"], `${path}.operator.operator_id`);
  const generation = positiveInteger(rawOperator["generation"], `${path}.operator.generation`);
  const operator: AgentGraphOperator = {
    graphId,
    operatorId,
    generation,
    role: requiredText(rawOperator["role"], `${path}.operator.role`, MAX_SHORT_TEXT_BYTES),
    ...(rawOperator["description"] === undefined
      ? {}
      : {
          description: requiredText(
            rawOperator["description"],
            `${path}.operator.description`,
            MAX_DESCRIPTION_BYTES,
          ),
        }),
    profileSnapshot: profile,
    workspacePolicy: workspace,
  };
  const rawIntent = objectField(value["intent"], `${path}.intent`);
  assertKeys(
    rawIntent,
    ["intent_id", "instruction", "input_record_ids"],
    ["intent_id", "instruction"],
    `${path}.intent`,
  );
  const inputRecordIds = identityArray(
    rawIntent["input_record_ids"] ?? [],
    `${path}.intent.input_record_ids`,
    AGENT_GRAPH_MAX_INPUT_REFS,
  );
  const intent: AgentGraphActivationIntent = {
    graphId,
    intentId: requiredIdentity(rawIntent["intent_id"], `${path}.intent.intent_id`),
    operatorId,
    operatorGeneration: generation,
    instruction: requiredText(
      rawIntent["instruction"],
      `${path}.intent.instruction`,
      AGENT_GRAPH_MAX_INSTRUCTION_BYTES,
    ),
    inputRefs: inputRecordIds.map((recordId) => ({ recordId })),
    createdAtRevision,
    requestedBy: source,
  };
  return { kind: "add", operator, intent };
}

function parseWorkspace(
  value: Record<string, unknown>,
  path: string,
): AgentGraphOperator["workspacePolicy"] {
  const kind = value["kind"];
  if (kind !== "shared") {
    throw new Error(`update_agent_graph 参数无效：${path}.kind 当前仅支持 shared。`);
  }
  assertKeys(value, ["kind"], ["kind"], path);
  return { kind };
}

function parseStopCommand(value: Record<string, unknown>, index: number): AgentGraphStopCommand {
  const path = `commands[${index}]`;
  assertKeys(value, ["kind", "target", "reason"], ["kind", "target"], path);
  const rawTarget = objectField(value["target"], `${path}.target`);
  let target: AgentGraphStopCommand["target"];
  if (rawTarget["kind"] === "intent") {
    assertKeys(rawTarget, ["kind", "intent_id"], ["kind", "intent_id"], `${path}.target`);
    target = {
      kind: "intent",
      intentId: requiredIdentity(rawTarget["intent_id"], `${path}.target.intent_id`),
    };
  } else if (rawTarget["kind"] === "operator") {
    assertKeys(
      rawTarget,
      ["kind", "operator_id", "generation"],
      ["kind", "operator_id", "generation"],
      `${path}.target`,
    );
    target = {
      kind: "operator",
      operatorId: requiredIdentity(rawTarget["operator_id"], `${path}.target.operator_id`),
      generation: positiveInteger(rawTarget["generation"], `${path}.target.generation`),
    };
  } else {
    throw new Error(`update_agent_graph 参数无效：${path}.target.kind 必须是 intent 或 operator。`);
  }
  return {
    kind: "stop",
    target,
    ...(value["reason"] === undefined
      ? {}
      : { reason: requiredText(value["reason"], `${path}.reason`, MAX_SHORT_TEXT_BYTES) }),
  };
}

function parseFinishCommand(
  value: Record<string, unknown>,
  index: number,
): AgentGraphScheduleCommand {
  const path = `commands[${index}]`;
  assertKeys(value, ["kind", "selected_record_ids"], ["kind"], path);
  const selectedRecordIds = identityArray(
    value["selected_record_ids"] ?? [],
    `${path}.selected_record_ids`,
    AGENT_GRAPH_MAX_SELECTED_RECORDS,
  );
  return {
    kind: "finish",
    ...(selectedRecordIds.length > 0 ? { selectedRecordIds } : {}),
  };
}

function parseEmptyInput(args: string, toolName: string): void {
  const value = parseJsonObject(args, toolName);
  assertKeys(value, [], [], toolName);
}

function parseJsonObject(args: string, toolName: string): Record<string, unknown> {
  if (Buffer.byteLength(args, "utf8") > AGENT_GRAPH_MAX_JSON_BYTES) {
    throw new Error(`${toolName} 参数无效：JSON 不得超过 ${AGENT_GRAPH_MAX_JSON_BYTES} 字节。`);
  }
  assertWellFormedString(args, `${toolName} JSON`);
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error(`${toolName} 参数解析失败：期望 JSON 对象。`);
  }
  if (!isRecord(value)) throw new Error(`${toolName} 参数无效：期望 JSON 对象。`);
  return value;
}

function objectField(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`update_agent_graph 参数无效：${path} 必须是对象。`);
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path = "update_agent_graph",
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${path} 参数无效：不支持字段 ${unknown}。`);
  const missing = required.find((key) => !(key in value));
  if (missing) throw new Error(`${path} 参数无效：缺少字段 ${missing}。`);
}

function identityArray(value: unknown, path: string, maxItems: number): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`update_agent_graph 参数无效：${path} 必须是字符串数组。`);
  }
  if (value.length > maxItems) {
    throw new Error(`update_agent_graph 参数无效：${path} 不得超过 ${maxItems} 项。`);
  }
  const items = value.map((item, index) => requiredIdentity(item, `${path}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`update_agent_graph 参数无效：${path} 不得包含重复项。`);
  }
  return items;
}

function requiredIdentity(value: unknown, path: string): string {
  const identity = requiredText(value, path, MAX_IDENTITY_BYTES);
  if (/\p{Cc}|\s/u.test(identity)) {
    throw new Error(`Agent Graph 调用上下文或参数的 ${path} 无效。`);
  }
  return identity;
}

function requiredText(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`update_agent_graph 参数无效：${path} 必须是非空字符串。`);
  }
  assertWellFormedString(value, path);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new Error(`update_agent_graph 参数无效：${path} 不得超过 ${maxBytes} 字节。`);
  }
  return normalized;
}

function assertWellFormedString(value: string, path: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`update_agent_graph 参数无效：${path} 包含非法 UTF-16/UTF-8 字符。`);
  }
}

function boundedJsonValue(value: unknown, path: string): JsonValue {
  validateJsonValue(value, path, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_POLICY_JSON_BYTES) {
    throw new Error(
      `update_agent_graph 参数无效：${path} 不得超过 ${MAX_POLICY_JSON_BYTES} 字节。`,
    );
  }
  return value as JsonValue;
}

function validateJsonValue(value: unknown, path: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`update_agent_graph 参数无效：${path} JSON 嵌套过深。`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertWellFormedString(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`update_agent_graph 参数无效：${path} 含非有限数字。`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new Error(
        `update_agent_graph 参数无效：${path} 数组不得超过 ${MAX_JSON_ARRAY_ITEMS} 项。`,
      );
    }
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertWellFormedString(key, `${path} key`);
      validateJsonValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`update_agent_graph 参数无效：${path} 必须是严格 JSON 值。`);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`update_agent_graph 参数无效：${path} 必须是非负安全整数。`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonNegativeInteger(value, path);
  if (result < 1) {
    throw new Error(`update_agent_graph 参数无效：${path} 必须是正安全整数。`);
  }
  return result;
}

function requireRootContext(
  value: AgentGraphRootToolContext | undefined,
): AgentGraphRootToolContext {
  if (!value || value.kind !== "graph_root_supervisor") {
    throw new Error("Agent Graph Supervisor 工具仅可由有效的 Graph root activation 调用。");
  }
  return {
    kind: value.kind,
    graphId: requiredExactIdentity(value.graphId, "graphId"),
    rootSessionId: requiredExactIdentity(value.rootSessionId, "rootSessionId"),
    rootTurnId: requiredExactIdentity(value.rootTurnId, "rootTurnId"),
    rootRunId: requiredExactIdentity(value.rootRunId, "rootRunId"),
  };
}

function requiredExactIdentity(value: unknown, path: string): string {
  const identity = requiredIdentity(value, path);
  if (identity !== value) {
    throw new Error(`Agent Graph 调用上下文的 ${path} 无效。`);
  }
  return identity;
}

function validateProjection(
  projection: AgentGraphSupervisorProjection,
  root: AgentGraphRootToolContext,
): void {
  if (!projection?.graph || projection.graph.graphId !== root.graphId) {
    throw new Error("Agent Graph 应用服务返回了其他 Graph 的投影。");
  }
  if (projection.graph.rootSessionId !== root.rootSessionId) {
    throw new Error("Agent Graph 应用服务返回了其他 root Session 的投影。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addCommandSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["add"] },
      operator: {
        type: "object",
        properties: {
          operator_id: { type: "string" },
          generation: { type: "integer", minimum: 1 },
          role: { type: "string" },
          description: { type: "string" },
          profile: {
            type: "object",
            properties: {
              profile_id: { type: "string" },
              model: { type: "string" },
              tools: {
                type: "array",
                maxItems: AGENT_GRAPH_MAX_PROFILE_TOOLS,
                items: { type: "string" },
              },
              permission_policy: {
                description: "冻结到 Operator provision 的 JSON 权限快照。",
              },
              system_prompt_version: { type: "string" },
            },
            required: ["profile_id", "tools", "permission_policy", "system_prompt_version"],
            additionalProperties: false,
          },
          workspace: {
            type: "object",
            properties: { kind: { type: "string", enum: ["shared"] } },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["operator_id", "generation", "role", "profile", "workspace"],
        additionalProperties: false,
      },
      intent: {
        type: "object",
        properties: {
          intent_id: { type: "string" },
          instruction: { type: "string" },
          input_record_ids: {
            type: "array",
            maxItems: AGENT_GRAPH_MAX_INPUT_REFS,
            items: { type: "string" },
          },
        },
        required: ["intent_id", "instruction"],
        additionalProperties: false,
      },
    },
    required: ["kind", "operator", "intent"],
    additionalProperties: false,
  };
}

function stopCommandSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["stop"] },
      target: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["intent"] },
              intent_id: { type: "string" },
            },
            required: ["kind", "intent_id"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["operator"] },
              operator_id: { type: "string" },
              generation: { type: "integer", minimum: 1 },
            },
            required: ["kind", "operator_id", "generation"],
            additionalProperties: false,
          },
        ],
      },
      reason: { type: "string" },
    },
    required: ["kind", "target"],
    additionalProperties: false,
  };
}

function finishCommandSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["finish"] },
      selected_record_ids: {
        type: "array",
        maxItems: AGENT_GRAPH_MAX_SELECTED_RECORDS,
        items: { type: "string" },
      },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}
