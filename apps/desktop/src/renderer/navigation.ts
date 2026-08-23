export type SidebarTaskGrouping = "time" | "project";

export const appPrimaryNavigation = [
  { to: "/automations", label: "定时任务", kind: "automations", scoped: true },
] as const;

export const settingsNavigationGroups = [
  {
    label: "偏好",
    items: [
      { to: "/settings", label: "通用", kind: "general", end: true },
      { to: "/settings/workspaces", label: "工作区", kind: "workspaces", scoped: true },
    ],
  },
  {
    label: "能力",
    items: [
      { to: "/settings/models", label: "模型", kind: "models" },
      { to: "/settings/memory", label: "记忆", kind: "memory", scoped: true },
      { to: "/extensions/skills", label: "Skills", kind: "skills" },
      { to: "/extensions/mcp", label: "MCP", kind: "mcp" },
    ],
  },
  {
    label: "活动",
    items: [{ to: "/settings/usage", label: "用量", kind: "usage", scoped: true }],
  },
  {
    label: "系统",
    items: [{ to: "/settings/system", label: "权限与能力", kind: "system" }],
  },
] as const;

export function sortSidebarTasks<
  T extends { readonly pinned?: boolean; readonly updatedAt: number },
>(sessions: readonly T[]): T[] {
  return [...sessions].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      right.updatedAt - left.updatedAt,
  );
}

export function legacySurfaceHref(target: string, search: string): string {
  return `${target}${search}`;
}
