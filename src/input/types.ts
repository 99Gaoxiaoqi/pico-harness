export interface ParsedSlashInput {
  raw: string;
  name: string;
  args: string;
  argv: readonly string[];
}

export type LocalUiPanel = "help" | "model" | "sessions" | "rewind";

export type LocalUiSelector = "model" | "session" | "rewind";

export type LocalUiCommandAction =
  | {
      kind: "open-panel";
      panel: LocalUiPanel;
    }
  | {
      kind: "open-selector";
      selector: LocalUiSelector;
    };

export type LocalCommandAction =
  | "help"
  | "clear"
  | "exit"
  | "status"
  | "model"
  | "thinking"
  | "tools"
  | "skills"
  | "agents"
  | "message";

export interface LocalCommandResult {
  type: "local";
  action: LocalCommandAction;
  message?: string;
  data?: unknown;
  ui?: LocalUiCommandAction;
}

export interface PromptCommandResult {
  type: "prompt";
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface CommandRegistryView {
  list(options?: CommandListOptions): readonly SlashCommand[];
}

export interface CommandExecutionContext {
  registry?: CommandRegistryView;
}

export type SlashCommandKind = "local" | "prompt" | "local-jsx";

export type SlashCommandSource =
  | "builtin"
  | "project"
  | "user"
  | "skill"
  | "plugin"
  | "mcp"
  | (string & {});

export interface CommandListOptions {
  source?: SlashCommandSource;
  includeHidden?: boolean;
  includeDisabled?: boolean;
}

export interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage?: string;
  argumentHint?: string;
  kind?: SlashCommandKind;
  source?: SlashCommandSource;
  isHidden?: boolean;
  isEnabled?: boolean;
  execute(
    input: ParsedSlashInput,
    context: CommandExecutionContext,
  ): LocalCommandResult | PromptCommandResult | Promise<LocalCommandResult | PromptCommandResult>;
}

export type InputProcessResult =
  | {
      type: "empty";
      raw: string;
    }
  | {
      type: "prompt";
      raw: string;
      prompt: string;
    }
  | {
      type: "local-command";
      raw: string;
      command: string;
      args: string;
      argv: readonly string[];
      result: LocalCommandResult;
    }
  | {
      type: "prompt-command";
      raw: string;
      command: string;
      args: string;
      argv: readonly string[];
      result: PromptCommandResult;
    }
  | {
      type: "unknown-command";
      raw: string;
      command: string;
      args: string;
      argv: readonly string[];
      message: string;
      suggestions: readonly string[];
    };
