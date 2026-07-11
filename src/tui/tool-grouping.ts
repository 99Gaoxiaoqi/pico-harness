import type { TuiEntry } from "./tui-reporter.js";
import { compactCommand, compactText, summarizeToolTarget } from "./tool-format.js";
import { isAgentToolName } from "./tool-card.js";

type ToolEntry = Extract<TuiEntry, { kind: "tool" }>;

export function groupConsecutiveToolEntries(entries: TuiEntry[]): TuiEntry[] {
  const result: TuiEntry[] = [];
  let group: ToolEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "tool" && canGroupTool(entry, group[0])) {
      group.push(entry);
      continue;
    }

    flushGroup(result, group);
    group = entry.kind === "tool" && canStartGroup(entry) ? [entry] : [];
    if (group.length === 0) result.push(entry);
  }

  flushGroup(result, group);
  return result;
}

export const groupToolEntries = groupConsecutiveToolEntries;

function canStartGroup(entry: ToolEntry): boolean {
  return !isAgentToolName(entry.name) && !isRunning(entry);
}

function canGroupTool(entry: ToolEntry, first: ToolEntry | undefined): boolean {
  if (!first) return false;
  return canStartGroup(entry) && entry.name === first.name;
}

function flushGroup(result: TuiEntry[], group: ToolEntry[]): void {
  if (group.length === 0) return;
  if (group.length === 1) {
    result.push(group[0]!);
    return;
  }

  result.push({
    kind: "tool",
    uiEntryId: groupedEntryId(group),
    ...groupedToolCallIds(group),
    name: group[0]!.name,
    args: JSON.stringify({
      groupedCount: group.length,
      calls: group.map((entry) => callLine(entry)),
    }),
    status: groupStatus(group),
    summary: groupSummary(group),
  });
}

function groupedEntryId(group: readonly ToolEntry[]): string | undefined {
  const ids = group.flatMap((entry) => (entry.uiEntryId ? [entry.uiEntryId] : []));
  return ids.length === group.length ? `tool-group:${ids.join("|")}` : undefined;
}

function groupedToolCallIds(
  group: readonly ToolEntry[],
): Pick<ToolEntry, "uiToolCallId" | "uiToolCallIds"> {
  const ids = group.flatMap((entry) =>
    entry.uiToolCallIds ? [...entry.uiToolCallIds] : entry.uiToolCallId ? [entry.uiToolCallId] : [],
  );
  if (ids.length === 0) return {};
  return { uiToolCallId: ids[ids.length - 1]!, uiToolCallIds: Object.freeze(ids) };
}

function groupStatus(group: ToolEntry[]): ToolEntry["status"] {
  if (group.some((entry) => entry.status === "denied")) return "denied";
  if (group.some((entry) => entry.status === "error" || entry.status === "failed")) return "error";
  return "success";
}

function groupSummary(group: ToolEntry[]): string {
  const status = groupStatus(group);
  const ok = group.filter((entry) => entry.status === "success" || entry.status === "done").length;
  const failed = group.length - ok;
  const parts = [`${group.length} calls`, failed > 0 ? `${failed} failed` : `${ok} success`];
  const first = callLine(group[0]!);
  if (first) parts.push(first);
  if (status === "denied") parts.push("denied");
  return compactText(parts.join(" · "), 160);
}

function callLine(entry: ToolEntry): string {
  const target = summarizeToolTarget(entry.name, entry.args, 44);
  if (target) return target;
  if (entry.name === "bash") return compactCommand(entry.args, 44);
  return compactText(entry.summary ?? entry.name, 44);
}

function isRunning(entry: ToolEntry): boolean {
  return entry.status === "queued" || entry.status === "running" || entry.status === "approval";
}
