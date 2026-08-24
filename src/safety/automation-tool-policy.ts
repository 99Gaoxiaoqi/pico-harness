/**
 * Automation/Cron tool authority is intentionally independent from the general
 * background host surface. Adding or exposing a new tool elsewhere must never
 * grant it unattended YOLO authority automatically.
 */
export const AUTOMATION_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "glob",
  "grep",
  "todo",
  "task_list",
  "task_create",
  "task_update",
  "task_get",
  "task_output",
  "task_stop",
  "code_definition",
  "code_references",
  "code_symbols",
  "code_diagnostics",
  "code_call_hierarchy",
  "repo_map",
  "explore_repo",
  "fetch_url",
  "web_search",
  "create_goal",
  "get_goal",
  "update_goal",
  "skill_view",
]);

const AUTOMATION_TOOL_ALLOWLIST_SET: ReadonlySet<string> = new Set(AUTOMATION_TOOL_ALLOWLIST);

export function isAutomationToolAllowed(toolName: string): boolean {
  return AUTOMATION_TOOL_ALLOWLIST_SET.has(toolName);
}

export function filterAutomationAllowedTools(tools: readonly string[]): string[] {
  return [...new Set(tools.filter((tool) => tool && isAutomationToolAllowed(tool)))].sort();
}

export function automationDeniedTools(tools: readonly string[]): string[] {
  return [...new Set(tools.filter((tool) => tool && !isAutomationToolAllowed(tool)))].sort();
}
