/**
 * 一次性子代理定义。该结构可由主 Agent 根据用户自然语言生成，但不携带
 * endpoint、凭证或工具白名单；运行时仍负责模型路由与权限校验。
 */
export interface EphemeralAgentSpec {
  readonly name?: string;
  /** 只允许追加到默认子代理安全骨架，不表示完整 system prompt 覆盖。 */
  readonly instructions?: string;
  readonly modelRouteId?: string | "inherit";
  readonly thinkingEffort?: string;
  readonly maxTurns?: number;
}

export type EphemeralAgentSpecParseResult =
  | { readonly ok: true; readonly spec?: EphemeralAgentSpec }
  | { readonly ok: false; readonly error: string };

export const MAX_EPHEMERAL_AGENT_NAME_CHARS = 80;
export const MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS = 8_000;
export const MAX_SUBAGENT_TURNS = 50;
const EPHEMERAL_AGENT_KEYS = new Set([
  "name",
  "instructions",
  "model_route",
  "thinking_effort",
  "max_turns",
]);

/**
 * 解析 delegate_task 暴露的 snake_case agent 对象。
 *
 * 此处只做形状和硬预算校验；model_route 是否存在、是否歧义以及对应凭证
 * 是否可用，必须由可信宿主的 ModelRouter 在 Provider 调用前校验。
 */
export function parseEphemeralAgentSpec(value: unknown): EphemeralAgentSpecParseResult {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return invalid("agent 必须是对象");
  const unknownKey = Object.keys(value).find((key) => !EPHEMERAL_AGENT_KEYS.has(key));
  if (unknownKey) return invalid(`agent 不支持字段 ${unknownKey}`);

  const name = optionalString(value["name"], "agent.name");
  if (!name.ok) return name;
  if (name.value && name.value.length > MAX_EPHEMERAL_AGENT_NAME_CHARS) {
    return invalid(`agent.name 不能超过 ${MAX_EPHEMERAL_AGENT_NAME_CHARS} 个字符`);
  }

  const instructions = optionalString(value["instructions"], "agent.instructions");
  if (!instructions.ok) return instructions;
  if (instructions.value && instructions.value.length > MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS) {
    return invalid(`agent.instructions 不能超过 ${MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS} 个字符`);
  }

  const modelRoute = optionalString(value["model_route"], "agent.model_route");
  if (!modelRoute.ok) return modelRoute;
  const thinkingEffort = optionalString(value["thinking_effort"], "agent.thinking_effort");
  if (!thinkingEffort.ok) return thinkingEffort;

  const maxTurns = optionalPositiveInteger(value["max_turns"], "agent.max_turns");
  if (!maxTurns.ok) return maxTurns;

  const spec: EphemeralAgentSpec = {
    ...(name.value ? { name: name.value } : {}),
    ...(instructions.value ? { instructions: instructions.value } : {}),
    ...(modelRoute.value ? { modelRouteId: modelRoute.value } : {}),
    ...(thinkingEffort.value ? { thinkingEffort: thinkingEffort.value } : {}),
    ...(maxTurns.value !== undefined
      ? { maxTurns: Math.min(maxTurns.value, MAX_SUBAGENT_TURNS) }
      : {}),
  };

  if (Object.keys(spec).length === 0) {
    return invalid(
      "agent 至少需要 name、instructions、model_route、thinking_effort 或 max_turns 之一",
    );
  }
  return { ok: true, spec };
}

function optionalString(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return invalid(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) return invalid(`${field} 不能为空`);
  return { ok: true, value: normalized };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value?: number } | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return invalid(`${field} 必须是正整数`);
  }
  return { ok: true, value };
}

function invalid(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
