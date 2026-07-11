export const MAIN_AGENT_ID = "main";

export type AgentNavigationStatus = "idle" | "queued" | "running" | "completed" | "failed";

export type AgentTimelineItem =
  | { id: string; kind: "thinking"; content?: string }
  | { id: string; kind: "message"; content: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      status: "running" | "completed" | "failed";
      summary?: string;
    };

/** App 层只需把权威投影适配成该受控 ViewModel。 */
export interface AgentNavigationItem {
  id: string;
  kind: "main" | "subagent";
  status: AgentNavigationStatus;
  agentName?: string;
  task?: string;
  mode?: "explore" | "worker";
  currentAction?: string;
  summary?: string;
  unreadCount?: number;
  timeline?: readonly AgentTimelineItem[];
}

export type AgentNavigationFocus = "input" | "picker";

export interface AgentNavigationState {
  focus: AgentNavigationFocus;
  selectedId: string;
  activeId: string;
}

export type AgentNavigationEvent =
  | { type: "focus-picker" }
  | { type: "focus-input" }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "open" }
  | { type: "escape" }
  | { type: "select"; id: string }
  | { type: "open-item"; id: string }
  | { type: "items-changed" };

export function createMainAgentItem(
  overrides: Partial<Omit<AgentNavigationItem, "id" | "kind">> = {},
): AgentNavigationItem {
  return { id: MAIN_AGENT_ID, kind: "main", status: "idle", agentName: "Main", ...overrides };
}

export function createAgentNavigationState(): AgentNavigationState {
  return { focus: "input", selectedId: MAIN_AGENT_ID, activeId: MAIN_AGENT_ID };
}

/** Main 始终在首位，并且丢弃重复 ID，避免键盘循环落入歧义。 */
export function normalizeAgentNavigationItems(
  items: readonly AgentNavigationItem[],
): AgentNavigationItem[] {
  const main = items.find((item) => item.id === MAIN_AGENT_ID || item.kind === "main");
  const result = [
    main ? { ...main, id: MAIN_AGENT_ID, kind: "main" as const } : createMainAgentItem(),
  ];
  const seen = new Set([MAIN_AGENT_ID]);
  for (const item of items) {
    if (item.kind === "main" || item.id === MAIN_AGENT_ID || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function reconcileAgentNavigationState(
  state: AgentNavigationState,
  items: readonly AgentNavigationItem[],
): AgentNavigationState {
  const ids = new Set(normalizeAgentNavigationItems(items).map((item) => item.id));
  return {
    ...state,
    selectedId: ids.has(state.selectedId) ? state.selectedId : MAIN_AGENT_ID,
    activeId: ids.has(state.activeId) ? state.activeId : MAIN_AGENT_ID,
  };
}

export function reduceAgentNavigation(
  state: AgentNavigationState,
  event: AgentNavigationEvent,
  sourceItems: readonly AgentNavigationItem[],
): AgentNavigationState {
  const items = normalizeAgentNavigationItems(sourceItems);
  const current = reconcileAgentNavigationState(state, items);
  const ids = items.map((item) => item.id);

  switch (event.type) {
    case "focus-picker":
      return { ...current, focus: "picker" };
    case "focus-input":
      return { ...current, focus: "input" };
    case "items-changed":
      return current;
    case "move-up":
      return current.focus === "picker" ? moveSelection(current, ids, -1) : current;
    case "move-down":
      return current.focus === "picker" ? moveSelection(current, ids, 1) : current;
    case "open":
      return current.focus === "picker" ? { ...current, activeId: current.selectedId } : current;
    case "select":
      return ids.includes(event.id)
        ? { ...current, focus: "picker", selectedId: event.id }
        : current;
    case "open-item":
      return ids.includes(event.id)
        ? { ...current, focus: "picker", selectedId: event.id, activeId: event.id }
        : current;
    case "escape":
      if (current.activeId !== MAIN_AGENT_ID) {
        return { ...current, activeId: MAIN_AGENT_ID, selectedId: MAIN_AGENT_ID, focus: "picker" };
      }
      return current.focus === "picker" ? { ...current, focus: "input" } : current;
  }
}

function moveSelection(
  state: AgentNavigationState,
  ids: readonly string[],
  delta: -1 | 1,
): AgentNavigationState {
  const currentIndex = Math.max(0, ids.indexOf(state.selectedId));
  const nextIndex = (currentIndex + delta + ids.length) % ids.length;
  return { ...state, selectedId: ids[nextIndex] ?? MAIN_AGENT_ID };
}
