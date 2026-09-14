/** Stable native tool-name allowlist used by declarative Agent and Graph profiles. */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "skill_view",
  "glob",
  "grep",
  "todo",
  "fetch_url",
  "web_search",
  "repo_map",
  "code_definition",
  "code_references",
  "code_symbols",
  "code_diagnostics",
  "code_call_hierarchy",
]);
