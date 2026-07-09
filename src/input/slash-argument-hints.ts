export interface SlashArgumentHint {
  value: string;
  description?: string;
}

const COMMAND_RE =
  /^\/([A-Za-z0-9_?][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*|\?)(?:\s+([\s\S]*))?$/;

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

export function getSlashArgumentHintsForInput(
  input: string,
  cursor = input.length,
): readonly SlashArgumentHint[] {
  const beforeCursor = input.slice(0, clampCursor(cursor, input.length));
  const match = COMMAND_RE.exec(beforeCursor);
  if (match === null) return [];

  const command = match[1];
  const args = match[2];
  if (command === undefined || args === undefined) return [];
  if (/\s/.test(args)) return [];

  return getSlashArgumentHints(command, args);
}

function normalizeCommand(command: string): string {
  return command.replace(/^\/+/, "").trim().toLowerCase();
}

function clampCursor(cursor: number, inputLength: number): number {
  if (!Number.isFinite(cursor)) return inputLength;
  return Math.max(0, Math.min(inputLength, Math.trunc(cursor)));
}
