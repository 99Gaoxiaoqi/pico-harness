import type { CommandSuggestion } from "@pico/cli/command-registry";

export type DesktopCommandDestination =
  | "snapshots"
  | "agents"
  | "skills"
  | "sessions"
  | "workspaces"
  | "system"
  | "usage"
  | "memory"
  | "providers"
  | "automations"
  | "mcp";
type Policy =
  | { tier: "primary" | "advanced"; session?: true }
  | { tier: "page"; destination: DesktopCommandDestination; label: string; message: string }
  | { tier: "unsupported"; message: string };

/** Desktop exposure is opt-in. New TUI commands never become desktop actions implicitly. */
export const DESKTOP_COMMAND_POLICY = {
  help: { tier: "primary" },
  model: { tier: "primary" },
  plan: { tier: "primary" },
  swarm: { tier: "primary" },
  goal: { tier: "primary" },
  compact: { tier: "primary", session: true },
  rewind: { tier: "primary", session: true },
  changes: { tier: "primary", session: true },
  resume: { tier: "primary" },
  new: { tier: "primary" },
  skill: { tier: "primary" },
  agent: { tier: "primary" },
  thinking: { tier: "advanced", session: true },
  mode: { tier: "advanced" },
  permissions: { tier: "advanced" },
  graph: { tier: "advanced" },
  status: { tier: "advanced", session: true },
  rename: { tier: "advanced", session: true },
  operations: { tier: "advanced" },
  hooks: { tier: "advanced" },
  "add-dir": { tier: "advanced", session: true },
  context: { tier: "advanced", session: true },
  fork: { tier: "advanced", session: true },
  steer: { tier: "advanced", session: true },
  queue: { tier: "advanced", session: true },
  replace: { tier: "advanced", session: true },
  interrupt: { tier: "advanced", session: true },
  snapshots: {
    tier: "page",
    destination: "snapshots",
    label: "查看检查点",
    message: "检查点列表已合并到回退选择器；选择后仍需预览和确认。",
  },
  sessions: {
    tier: "page",
    destination: "sessions",
    label: "打开会话工作库",
    message: "请在会话工作库搜索历史会话，也可使用 /resume。",
  },
  skills: {
    tier: "page",
    destination: "skills",
    label: "管理 Skills",
    message: "Skills 页面管理用户级资源；本项目的有效技能请通过 /skill 选择。",
  },
  agents: {
    tier: "page",
    destination: "agents",
    label: "选择 Agent",
    message: "请在当前项目的 Agent 选择器查看有效目录。",
  },
  init: {
    tier: "page",
    destination: "workspaces",
    label: "打开项目设置",
    message: "请在项目设置中选择目录并确认初始化；本命令不会写入项目。",
  },
  doctor: {
    tier: "page",
    destination: "system",
    label: "打开高级诊断",
    message: "请在系统设置中选择诊断项目并运行环境检查或资源扫描。",
  },
  usage: {
    tier: "page",
    destination: "usage",
    label: "打开用量统计",
    message: "用量统计按项目筛选；项目累计不等于当前会话用量。",
  },
  memory: {
    tier: "page",
    destination: "memory",
    label: "打开项目记忆",
    message: "请在项目记忆页面查看或管理内容；高级 undo 操作仍在 TUI 中使用。",
  },
  provider: {
    tier: "page",
    destination: "providers",
    label: "打开模型设置",
    message: "服务商配置由模型设置承接；终端环境变量导入仍在 TUI 中使用。参数不会在这里执行。",
  },
  cron: {
    tier: "page",
    destination: "automations",
    label: "打开定时任务",
    message:
      "定时任务页面提供基本管理；凭据导入、工具网络策略和完整运行历史仍在 TUI 中使用。参数不会在这里执行。",
  },
  mcp: {
    tier: "page",
    destination: "mcp",
    label: "打开 MCP 配置",
    message:
      "请在 MCP 页面管理用户级配置；配置状态不代表实时连接状态，项目有效覆盖及探测可在 TUI 查看。",
  },
  clear: {
    tier: "unsupported",
    message: "桌面端不提供清屏命令。历史记录保持可见；需要空白对话请使用新任务。",
  },
  exit: { tier: "unsupported", message: "请使用系统菜单“退出 Pico”；聊天命令不会关闭应用。" },
  explore: { tier: "unsupported", message: "仓库探索已内建，直接描述任务即可，无需 /explore。" },
  plugin: {
    tier: "unsupported",
    message: "桌面端不提供插件安装与信任管理命令，请在 TUI 管理；已受信插件资源仍可使用。",
  },
} as const satisfies Record<string, Policy>;

export function desktopCommandPolicy(name: string): Policy | undefined {
  return (DESKTOP_COMMAND_POLICY as Readonly<Record<string, Policy>>)[name];
}
export interface DesktopCommandSuggestion extends CommandSuggestion {
  readonly tier: "primary" | "advanced";
}
