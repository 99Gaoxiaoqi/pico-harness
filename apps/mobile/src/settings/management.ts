import type {
  RuntimeProviderInput,
  RuntimeProviderProfile,
  RuntimeSubagentPreset,
  RuntimeSubagentSettingsSnapshot,
  RuntimeUserDefaults,
} from "@pico/protocol/mobile";
import type { RuntimePort } from "../core.js";

export type ScheduleKind = "daily" | "weekdays" | "weekly" | "advanced";
export function scheduleCron(kind: ScheduleKind, time: string, weekday: string, advanced: string) {
  if (kind === "advanced") {
    if (!advanced.trim()) throw new Error("请输入 Cron 日程");
    return advanced.trim();
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error("时间格式为 HH:mm，例如 09:00");
  if (kind === "weekly" && !/^[0-6]$/.test(weekday)) throw new Error("请选择每周执行日");
  return `${Number(match[2])} ${Number(match[1])} * * ${kind === "daily" ? "*" : kind === "weekdays" ? "1-5" : weekday}`;
}
export function scheduleDraft(cron: string): {
  kind: ScheduleKind;
  time: string;
  weekday: string;
  advanced: string;
} {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|[0-6])$/.exec(cron.trim());
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    return { kind: "advanced", time: "09:00", weekday: "1", advanced: cron };
  return {
    kind: match[3] === "*" ? "daily" : match[3] === "1-5" ? "weekdays" : "weekly",
    time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`,
    weekday: /^[0-6]$/.test(match[3]) ? match[3] : "1",
    advanced: cron,
  };
}

export async function saveAutomation(
  port: RuntimePort,
  input: { jobId?: string; name: string; prompt: string; schedule: string },
) {
  const { jobId, ...fields } = input;
  return jobId
    ? port.request("jobs.update", { jobId, ...fields })
    : port.request("jobs.create", { ...fields, enabled: false });
}

export function providerInput(provider: RuntimeProviderProfile): RuntimeProviderInput {
  return {
    id: provider.id,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    models: [...provider.models],
    discoverModels: provider.discoverModels,
    ...(provider.auth === undefined ? {} : { auth: provider.auth }),
    ...(provider.modelProtocols === undefined ? {} : { modelProtocols: provider.modelProtocols }),
    ...(provider.disabledModels === undefined
      ? {}
      : { disabledModels: [...provider.disabledModels] }),
    ...(provider.modelCapabilities === undefined
      ? {}
      : { modelCapabilities: provider.modelCapabilities }),
  };
}
export function availableProviderModels(provider: RuntimeProviderProfile): string[] {
  const available = provider["availableModels"];
  return [
    ...new Set([
      ...provider.models,
      ...(Array.isArray(available)
        ? available.filter((x): x is string => typeof x === "string")
        : []),
    ]),
  ];
}
export function modelChoices(providers: readonly RuntimeProviderProfile[]) {
  return providers.flatMap((provider) =>
    availableProviderModels(provider)
      .filter((model) => !provider.disabledModels?.includes(model))
      .map((model) => ({
        id: `${provider.id}/${model}`,
        label: `${model} · ${provider.id}`,
        reasoningLevels: provider.resolvedModelCapabilities?.[model]?.reasoningLevels ?? [],
      })),
  );
}
export async function saveUserDefaults(
  port: RuntimePort,
  config: { config: { defaults: RuntimeUserDefaults }; revision: string },
  patch: Partial<Pick<RuntimeUserDefaults, "modelRouteId" | "thinkingEffort" | "webSearch">>,
) {
  const defaults = Object.fromEntries(
    Object.entries({ ...config.config.defaults, ...patch }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as RuntimeUserDefaults;
  return port.request("config.user.update", { defaults, expectedRevision: config.revision });
}
export function subagentForWrite(preset: RuntimeSubagentPreset): RuntimeSubagentPreset {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    profile: preset.profile,
    connectionSlug: preset.connectionSlug,
    model: preset.model,
    enabled: preset.enabled,
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
  };
}
export async function saveSubagentPresets(
  port: RuntimePort,
  presets: readonly RuntimeSubagentPreset[],
  expectedRevision: RuntimeSubagentSettingsSnapshot["revision"],
) {
  return port.request("subagents.update", {
    presets: presets.map(subagentForWrite),
    expectedRevision,
  });
}
function dateBoundary(value: string, end: boolean): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("日期格式为 YYYY-MM-DD");
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  )
    throw new Error("请输入有效日期");
  if (end) date.setHours(23, 59, 59, 999);
  return date.getTime();
}
export function usageDateRange(fromText: string, toText: string) {
  const from = dateBoundary(fromText, false),
    to = dateBoundary(toText, true);
  if (from !== undefined && to !== undefined && from > to)
    throw new Error("开始日期不能晚于结束日期");
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}
export async function queryWorkspaceUsage(
  port: RuntimePort,
  authorizedIds: readonly string[],
  workspaceId: string,
  from: string,
  to: string,
) {
  if (!authorizedIds.includes(workspaceId)) throw new Error("请选择已授权的项目");
  return port.request("usage.get", usageDateRange(from, to), workspaceId);
}
