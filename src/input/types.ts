export interface ParsedSlashInput {
  raw: string;
  name: string;
  args: string;
  argv: readonly string[];
}

export type LocalCommandAction =
  | "help"
  | "clear"
  | "exit"
  | "status"
  | "model"
  | "tools"
  | "skills"
  | "agents"
  | "message";

export interface LocalCommandResult {
  type: "local";
  action: LocalCommandAction;
  message?: string;
  data?: unknown;
}

export interface PromptCommandResult {
  type: "prompt";
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface CommandRegistryView {
  list(): readonly SlashCommand[];
}

export interface CommandExecutionContext {
  registry?: CommandRegistryView;
}

export interface SlashCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage?: string;
  kind: "local" | "prompt";
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
