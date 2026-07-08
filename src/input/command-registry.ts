import type { SlashCommand } from "./types.js";

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();
  private readonly aliases = new Map<string, string>();
  private readonly ordered: SlashCommand[] = [];

  constructor(commands: readonly SlashCommand[] = []) {
    for (const command of commands) {
      this.register(command);
    }
  }

  register(command: SlashCommand): void {
    const name = normalizeCommandName(command.name);
    assertTokenAvailable(name, this.commands, this.aliases);

    const aliases = command.aliases ?? [];
    for (const alias of aliases) {
      assertTokenAvailable(normalizeCommandName(alias), this.commands, this.aliases);
    }

    this.commands.set(name, { ...command, name });
    this.ordered.push({ ...command, name });
    for (const alias of aliases) {
      this.aliases.set(normalizeCommandName(alias), name);
    }
  }

  resolve(name: string): SlashCommand | undefined {
    const normalized = normalizeCommandName(name);
    const direct = this.commands.get(normalized);
    if (direct !== undefined) {
      return direct;
    }

    const target = this.aliases.get(normalized);
    return target === undefined ? undefined : this.commands.get(target);
  }

  list(): readonly SlashCommand[] {
    return this.ordered;
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  suggestions(name: string): readonly string[] {
    const normalized = normalizeCommandName(name);
    if (normalized.length === 0) {
      return this.ordered.map((command) => command.name);
    }

    return this.ordered
      .map((command) => command.name)
      .filter((commandName) => commandName.startsWith(normalized))
      .slice(0, 5);
  }
}

export function normalizeCommandName(name: string): string {
  return name.replace(/^\/+/, "").trim().toLowerCase();
}

function assertTokenAvailable(
  token: string,
  commands: ReadonlyMap<string, SlashCommand>,
  aliases: ReadonlyMap<string, string>,
): void {
  if (token.length === 0) {
    throw new Error("Command name or alias cannot be empty");
  }

  if (commands.has(token) || aliases.has(token)) {
    throw new Error(`Duplicate slash command token: ${token}`);
  }
}
