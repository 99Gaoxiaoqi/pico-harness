const CLAUDE_TOOL_TO_PICO: Readonly<Record<string, string>> = Object.freeze({
  Bash: "bash",
  Edit: "edit_file",
  Glob: "glob",
  Grep: "grep",
  Read: "read_file",
  Skill: "skill_view",
  TodoWrite: "todo",
  WebFetch: "fetch_url",
  WebSearch: "web_search",
  Write: "write_file",
  bash: "bash",
  edit_file: "edit_file",
  fetch_url: "fetch_url",
  glob: "glob",
  grep: "grep",
  read_file: "read_file",
  skill_view: "skill_view",
  todo: "todo",
  web_search: "web_search",
  write_file: "write_file",
});

export interface ClaudeToolMappingResult {
  readonly tools: string[];
  readonly unknown: string[];
}

/** Convert Claude resource tools once at the compatibility boundary; unknown names fail closed. */
export function mapClaudeToolNames(declaredTools: readonly string[]): ClaudeToolMappingResult {
  const tools = new Set<string>();
  const unknown = new Set<string>();
  for (const declared of declaredTools) {
    const mapped = CLAUDE_TOOL_TO_PICO[declared];
    if (mapped) tools.add(mapped);
    else unknown.add(declared);
  }
  return { tools: [...tools], unknown: [...unknown] };
}
