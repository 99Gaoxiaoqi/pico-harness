/** The research session cannot gain mutation tools through discovery, Code Mode or plugins. */
const RESEARCH_TOOLS = new Set([
  "read_file",
  "archive_read",
  "glob",
  "grep",
  "web_search",
  "ask_user",
  "deep_research_start",
  "deep_research_save_artifact",
  "deep_research_read_artifact",
  "deep_research_update_checklist",
  "deep_research_record_step",
  "deep_research_checkpoint",
  "deep_research_status",
  "deep_research_complete",
]);
export function isResearchToolAllowed(name: string): boolean {
  return RESEARCH_TOOLS.has(name);
}
