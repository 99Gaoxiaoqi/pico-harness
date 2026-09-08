import {
  type RuntimeConfiguredSubagent,
  type RuntimeSubagentConnection,
  type RuntimeSubagentPreset,
  type SubagentProfile,
  type SubagentThinkingLevel,
} from "@pico/protocol";

export interface SubagentEditorDraft {
  id: string;
  name: string;
  description: string;
  profile: SubagentProfile;
  connectionSlug: string;
  model: string;
  thinkingLevel: SubagentThinkingLevel | "";
  enabled: boolean;
}

export const SUBAGENT_PROFILE_COPY = {
  local_read: {
    label: "代码阅读",
    description: "只读访问当前工作区，适合搜索、理解和总结代码。",
  },
  web_research: {
    label: "网络研究",
    description: "搜索网络资料并总结研究结果。",
  },
  implementation: {
    label: "实现代码",
    description: "可以读写文件并执行命令，在隔离 worktree 中完成改动。",
  },
} satisfies Record<SubagentProfile, { label: string; description: string }>;

export function selectableSubagentConnection(connection: RuntimeSubagentConnection): boolean {
  return connection.enabled && !connection.retired;
}

export function createSubagentDraft(
  preset: RuntimeSubagentPreset | undefined,
  connections: readonly RuntimeSubagentConnection[],
): SubagentEditorDraft {
  const initialConnection = preset
    ? connections.find((connection) => connection.id === preset.connectionSlug)
    : connections.find(selectableSubagentConnection);
  return {
    id: preset?.id ?? "",
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    profile: preset?.profile ?? "local_read",
    connectionSlug: preset?.connectionSlug ?? initialConnection?.id ?? "",
    model: preset?.model ?? initialConnection?.models.find((model) => model.offerable)?.id ?? "",
    thinkingLevel: preset?.thinkingLevel ?? "",
    enabled: preset?.enabled ?? true,
  };
}

export function suggestSubagentPresetId(name: string, existingIds: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "subagent";
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Match the persisted trim limits without making leading whitespace spend the allowance. */
export function limitSubagentText(value: string, maxChars: number): string {
  return value.slice(0, maxChars + value.length - value.trimStart().length);
}

/** Keep Host-only availability metadata out of configuration writes. */
export function subagentPresetForWrite(preset: RuntimeSubagentPreset): RuntimeSubagentPreset {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    profile: preset.profile,
    connectionSlug: preset.connectionSlug,
    model: preset.model,
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
    enabled: preset.enabled,
  };
}

export function subagentProblem(preset: RuntimeConfiguredSubagent): string | undefined {
  if (!preset.enabled || preset.availability.status === "available") return undefined;
  const messages: Record<string, string> = {
    missing_connection: "连接已删除",
    provider_retired: "服务商已停止支持",
    connection_disabled: "连接已停用",
    model_disabled: "模型不可用",
    model_unavailable: "模型不可用",
    unsupported_thinking_level: "思考级别不可用",
  };
  return messages[preset.availability.reason] ?? `暂不可用：${preset.availability.reason}`;
}
