import type { WorkbarDock, WorkbarTab, WorkbarToolKind } from "./types.js";

export interface WorkbarToolDefinition {
  readonly kind: WorkbarToolKind;
  readonly label: string;
  readonly description: string;
  readonly shortcut?: string;
  readonly defaultDock: WorkbarDock;
  readonly multiple: boolean;
  readonly persistsAcrossRestart: boolean;
}

export interface WorkbarShortcutEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export const WORKBAR_TOOL_REGISTRY = [
  {
    kind: "side-chat",
    label: "侧边对话",
    description: "从最近完成的回合建立临时分支对话",
    shortcut: "Mod+Alt+S",
    defaultDock: "right",
    multiple: true,
    persistsAcrossRestart: false,
  },
  {
    kind: "review",
    label: "变更",
    description: "查看工作区实时 Git 变更和差异",
    shortcut: "Ctrl+Shift+G",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
  {
    kind: "terminal",
    label: "终端",
    description: "打开一个任务终端",
    shortcut: "Ctrl+`",
    defaultDock: "bottom",
    multiple: true,
    persistsAcrossRestart: false,
  },
  {
    kind: "browser",
    label: "浏览器",
    description: "打开用户与 Agent 共用的任务浏览器",
    shortcut: "Mod+T",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
  {
    kind: "files",
    label: "生成文件",
    description: "查看当前任务生成的产物",
    shortcut: "Mod+P",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
  {
    kind: "tasks",
    label: "待办",
    description: "查看和管理当前任务的待办账本",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
  {
    kind: "inspector",
    label: "追踪",
    description: "查看执行追踪、上下文组成和工具详情",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
  {
    kind: "graph",
    label: "Graph",
    description: "查看调度周期、Operator、产出与唤醒时间线",
    defaultDock: "right",
    multiple: false,
    persistsAcrossRestart: true,
  },
] as const satisfies readonly WorkbarToolDefinition[];

export function getWorkbarTool(kind: WorkbarToolKind): WorkbarToolDefinition {
  const tool = WORKBAR_TOOL_REGISTRY.find((candidate) => candidate.kind === kind);
  if (!tool) throw new Error(`Unknown Workbar tool: ${kind}`);
  return tool;
}

export function createWorkbarToolTab(kind: WorkbarToolKind): WorkbarTab {
  const tool = getWorkbarTool(kind);
  return { id: kind, kind, label: tool.label };
}

export function isStaticWorkbarToolTab(tab: WorkbarTab): boolean {
  if (tab.preview || tab.pinned) return false;
  const tool = WORKBAR_TOOL_REGISTRY.find((candidate) => candidate.kind === tab.kind);
  return Boolean(tool && !tool.multiple && tool.persistsAcrossRestart && tab.id === tool.kind);
}

/** Resolves global shortcuts without coupling the Registry to a browser event type. */
export function resolveWorkbarShortcut(event: WorkbarShortcutEvent): WorkbarToolKind | undefined {
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (event.ctrlKey && event.shiftKey && !event.altKey && key === "g") return "review";
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && key === "`") {
    return "terminal";
  }
  if (mod && !event.shiftKey && !event.altKey && key === "t") return "browser";
  if (mod && !event.shiftKey && !event.altKey && key === "p") return "files";
  if (mod && event.altKey && !event.shiftKey && key === "s") return "side-chat";
  return undefined;
}
