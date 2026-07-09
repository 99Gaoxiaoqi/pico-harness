export interface SlashArgumentHint {
  value: string;
  description?: string;
}

const ARGUMENT_HINTS: Record<string, readonly SlashArgumentHint[]> = {
  model: [
    { value: "glm-5.2", description: "OpenAI-compatible default model" },
    { value: "kimi-k2.5", description: "OpenAI-compatible fallback model" },
    { value: "claude-3-5-sonnet", description: "Claude default model" },
    { value: "gemini-2.0-flash", description: "Gemini default model" },
  ],
  thinking: [
    { value: "off", description: "Disable native thinking effort" },
    { value: "low", description: "Use low thinking effort" },
    { value: "medium", description: "Use medium thinking effort" },
    { value: "high", description: "Use high thinking effort" },
  ],
  permissions: [
    { value: "ask", description: "Ask before actions that need approval" },
    { value: "default", description: "Use the default permission policy" },
    { value: "auto", description: "Auto-approve supported actions" },
    { value: "yolo", description: "Auto-approve the session" },
    { value: "plan", description: "Use plan-oriented permissions" },
  ],
  mode: [
    { value: "default", description: "Normal interactive mode" },
    { value: "plan", description: "Plan before acting" },
    { value: "auto", description: "Autonomous mode" },
    { value: "yolo", description: "YOLO mode" },
  ],
  yolo: [
    { value: "on", description: "Enable YOLO mode" },
    { value: "off", description: "Disable YOLO mode" },
  ],
  auto: [
    { value: "on", description: "Enable auto mode" },
    { value: "off", description: "Disable auto mode" },
  ],
};

const COMMAND_ALIASES: Record<string, string> = {
  models: "model",
  effort: "thinking",
  permission: "permissions",
};

export function getSlashArgumentHints(
  command: string,
  argPrefix = "",
): readonly SlashArgumentHint[] {
  const normalizedCommand = normalizeCommand(command);
  const targetCommand = COMMAND_ALIASES[normalizedCommand] ?? normalizedCommand;
  const hints = ARGUMENT_HINTS[targetCommand] ?? [];
  const normalizedPrefix = argPrefix.trimStart().toLowerCase();

  return hints
    .filter((hint) => hint.value.toLowerCase().startsWith(normalizedPrefix))
    .map((hint) => ({ ...hint }));
}

function normalizeCommand(command: string): string {
  return command.replace(/^\/+/, "").trim().toLowerCase();
}
