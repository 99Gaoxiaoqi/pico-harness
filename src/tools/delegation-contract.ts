import type { DelegationCompletionPolicy } from "./delegation-manager.js";
import { parseEphemeralAgentSpec, type EphemeralAgentSpec } from "./subagent-spec.js";

export type SubagentRole = "leaf" | "orchestrator";
export type SubagentMode = "explore" | "worker";

export interface DelegateTaskInput {
  goal?: string;
  context?: string;
  mode?: SubagentMode;
  role?: SubagentRole;
  agent_name?: string;
  agent?: unknown;
  roots?: string[];
  max_files?: number;
  stopping_condition?: string;
  expected_output?: string;
}

export interface DelegateTaskArgs extends DelegateTaskInput {
  tasks?: DelegateTaskInput[];
  completion_policy?: DelegationCompletionPolicy;
  /** @deprecated 兼容旧模型调用；true 等价于 completion_policy=optional。 */
  background?: boolean;
}

export interface NormalizedDelegateTask {
  goal: string;
  context?: string;
  mode: SubagentMode;
  role: SubagentRole;
  agentName?: string;
  ephemeralAgent?: EphemeralAgentSpec;
  roots: string[];
  maxFiles: number;
  stoppingCondition: string;
  expectedOutput: string;
  contractExplicit: boolean;
}

export type DelegateTaskParseResult =
  | { readonly ok: true; readonly value: DelegateTaskArgs }
  | { readonly ok: false };

export const DEFAULT_DELEGATION_ROOTS = ["."] as const;
export const DEFAULT_DELEGATION_MAX_FILES = 30;
export const MAX_DELEGATION_FILES = 100;
export const DEFAULT_DELEGATION_STOPPING_CONDITION =
  "找到足以回答目标的证据，或达到文件上限时立即停止。";
export const DEFAULT_DELEGATION_EXPECTED_OUTPUT = "给出结论、关键证据路径和仍待确认的风险。";

/** 共享 JSON 边界。调用方决定 malformed JSON 是参数错误还是 fail-closed policy。 */
export function parseDelegateTaskArgs(serialized: string): DelegateTaskParseResult {
  try {
    const value: unknown = JSON.parse(serialized);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value: value as DelegateTaskArgs }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Tool execution 保留明确的参数错误语义。 */
export function requireDelegateTaskArgs(serialized: string): DelegateTaskArgs {
  const parsed = parseDelegateTaskArgs(serialized);
  if (!parsed.ok) throw new Error("解析 delegate_task 参数失败:需 JSON 格式");
  return parsed.value;
}

export function resolveDelegationCompletionPolicy(
  input: Pick<DelegateTaskArgs, "completion_policy" | "background">,
): DelegationCompletionPolicy {
  if (
    input.completion_policy === "required" ||
    input.completion_policy === "optional" ||
    input.completion_policy === "detached"
  ) {
    return input.completion_policy;
  }
  return input.background === true ? "optional" : "required";
}

/** Engine 对 malformed JSON 必须 fail closed，仍将调用视为 required。 */
export function isRequiredDelegationArguments(serialized: string): boolean {
  const parsed = parseDelegateTaskArgs(serialized);
  return !parsed.ok || resolveDelegationCompletionPolicy(parsed.value) === "required";
}

export function isExploreOnlyRequiredDelegationArguments(serialized: string): boolean {
  const parsed = parseDelegateTaskArgs(serialized);
  if (!parsed.ok || resolveDelegationCompletionPolicy(parsed.value) !== "required") return false;
  const tasks = normalizedPolicyTasks(parsed.value);
  return tasks.length > 0 && tasks.every((task) => task.mode === "explore");
}

export function delegationTaskCountFromArguments(serialized: string): number {
  const parsed = parseDelegateTaskArgs(serialized);
  return parsed.ok ? normalizedPolicyTasks(parsed.value).length : 0;
}

export function normalizeDelegateTasks(input: DelegateTaskArgs): NormalizedDelegateTask[] {
  const defaultMode = normalizeMode(input.mode);
  const defaultRole = normalizeRole(input.role);
  const defaultRoots = normalizeDelegationRoots(input.roots, DEFAULT_DELEGATION_ROOTS);
  const defaultMaxFiles = normalizeMaxFiles(input.max_files, DEFAULT_DELEGATION_MAX_FILES);
  const defaultStoppingCondition = normalizeContractText(
    input.stopping_condition,
    DEFAULT_DELEGATION_STOPPING_CONDITION,
  );
  const defaultExpectedOutput = normalizeContractText(
    input.expected_output,
    DEFAULT_DELEGATION_EXPECTED_OUTPUT,
  );
  const topLevelContractExplicit = hasExplicitTaskContract(input);
  const defaultAgent = parseDelegateAgent(input.agent, "agent");
  const rawTasks =
    input.tasks && input.tasks.length > 0
      ? input.tasks
      : [
          {
            goal: input.goal,
            context: input.context,
            mode: input.mode,
            role: input.role,
            agent_name: input.agent_name,
            agent: input.agent,
            roots: input.roots,
            max_files: input.max_files,
            stopping_condition: input.stopping_condition,
            expected_output: input.expected_output,
          },
        ];

  return rawTasks
    .filter((task): task is DelegateTaskInput & { goal: string } => Boolean(task.goal?.trim()))
    .map((task) => ({
      goal: task.goal.trim(),
      ...(task.context ? { context: task.context } : {}),
      mode: normalizeMode(task.mode, defaultMode),
      role: normalizeRole(task.role, defaultRole),
      ...(task.agent_name?.trim() ? { agentName: task.agent_name.trim() } : {}),
      ...normalizeEphemeralAgent(task.agent, defaultAgent),
      roots: normalizeDelegationRoots(task.roots, defaultRoots),
      maxFiles: normalizeMaxFiles(task.max_files, defaultMaxFiles),
      stoppingCondition: normalizeContractText(task.stopping_condition, defaultStoppingCondition),
      expectedOutput: normalizeContractText(task.expected_output, defaultExpectedOutput),
      contractExplicit: topLevelContractExplicit || hasExplicitTaskContract(task),
    }));
}

function normalizedPolicyTasks(input: DelegateTaskArgs): Array<{ mode: SubagentMode }> {
  const defaultMode = normalizeMode(input.mode);
  const rawTasks =
    Array.isArray(input.tasks) && input.tasks.length > 0
      ? input.tasks
      : typeof input.goal === "string" && input.goal.trim().length > 0
        ? [{ goal: input.goal, mode: input.mode }]
        : [];
  return rawTasks
    .filter(
      (task): task is DelegateTaskInput & { goal: string } =>
        typeof task === "object" &&
        task !== null &&
        typeof task.goal === "string" &&
        task.goal.trim().length > 0,
    )
    .map((task) => ({ mode: normalizeMode(task.mode, defaultMode) }));
}

function parseDelegateAgent(value: unknown, field: string): EphemeralAgentSpec | undefined {
  const parsed = parseEphemeralAgentSpec(value);
  if (!parsed.ok) throw new Error(`${field}: ${parsed.error}`);
  return parsed.spec;
}

function normalizeEphemeralAgent(
  value: unknown,
  fallback: EphemeralAgentSpec | undefined,
): { ephemeralAgent?: EphemeralAgentSpec } {
  if (value === undefined) return fallback ? { ephemeralAgent: fallback } : {};
  const parsed = parseDelegateAgent(value, "tasks[].agent");
  return parsed ? { ephemeralAgent: parsed } : {};
}

function normalizeDelegationRoots(
  value: string[] | undefined,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const roots = [
    ...new Set(
      value
        .filter((root): root is string => typeof root === "string")
        .map(normalizeDelegationRoot)
        .filter((root): root is string => root !== undefined),
    ),
  ].slice(0, 20);
  return roots.length > 0 ? roots : [...fallback];
}

function normalizeDelegationRoot(value: string): string | undefined {
  const root = value.trim().replaceAll("\\", "/");
  if (!root || root.includes("\0")) return undefined;
  if (root.startsWith("/") || /^[A-Za-z]:\//u.test(root)) return undefined;
  const segments = root.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return undefined;
  return (segments.length > 0 ? segments.join("/") : ".").slice(0, 240);
}

function normalizeMaxFiles(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DELEGATION_FILES, Math.max(1, Math.floor(value)));
}

function normalizeContractText(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 500) : fallback;
}

function hasExplicitTaskContract(task: DelegateTaskInput): boolean {
  return (
    task.roots !== undefined ||
    task.max_files !== undefined ||
    task.stopping_condition !== undefined ||
    task.expected_output !== undefined
  );
}

function normalizeMode(
  value: string | undefined,
  fallback: SubagentMode = "explore",
): SubagentMode {
  return value === "worker" || value === "explore" ? value : fallback;
}

function normalizeRole(value: string | undefined, fallback: SubagentRole = "leaf"): SubagentRole {
  return value === "orchestrator" || value === "leaf" ? value : fallback;
}
