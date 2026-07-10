import {
  annotateCommandAvailability,
  type CommandAvailability,
  type CommandInputState,
} from "./command-availability.js";
import type {
  CommandListOptions,
  SlashCommandCategory,
  SlashCommand,
  SlashCommandKind,
  SlashCommandSource,
} from "./types.js";

export interface RegistrySlashCommand extends SlashCommand {
  priority?: number;
  availability?: CommandAvailability;
}

export interface CommandSuggestion {
  name: string;
  insertText: string;
  description: string;
  argumentHint?: string;
  source: SlashCommandSource;
  category?: SlashCommandCategory;
  kind: SlashCommandKind;
  usage?: string;
  priority?: number;
  aliases: readonly string[];
  matchedAlias?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface CommandSuggestionOptions {
  availabilityState?: CommandInputState;
}

export interface CommandSourceGroup {
  source: SlashCommandSource;
  commands: readonly RegistrySlashCommand[];
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegistrySlashCommand>();
  private readonly aliases = new Map<string, string>();
  private readonly ordered: RegistrySlashCommand[] = [];

  constructor(commands: readonly RegistrySlashCommand[] = []) {
    for (const command of commands) {
      this.register(command);
    }
  }

  register(command: RegistrySlashCommand): void {
    const name = normalizeCommandName(command.name);
    assertTokenAvailable(name, this.commands, this.aliases);

    const aliases = (command.aliases ?? []).map(normalizeCommandName);
    for (const alias of aliases) {
      assertTokenAvailable(alias, this.commands, this.aliases);
    }

    const normalized = normalizeCommand(command, name, aliases);
    this.commands.set(name, normalized);
    this.ordered.push(normalized);
    for (const alias of aliases) {
      this.aliases.set(alias, name);
    }
  }

  resolve(name: string): RegistrySlashCommand | undefined {
    const normalized = normalizeCommandName(name);
    const direct = this.commands.get(normalized);
    if (direct !== undefined) {
      return isCommandEnabled(direct) ? direct : undefined;
    }

    const target = this.aliases.get(normalized);
    if (target === undefined) return undefined;

    const command = this.commands.get(target);
    return command !== undefined && isCommandEnabled(command) ? command : undefined;
  }

  list(
    options: CommandListOptions = {},
  ): readonly (RegistrySlashCommand & { disabled?: boolean; disabledReason?: string })[] {
    const commands = this.ordered.filter((command) => shouldListCommand(command, options));
    return withAvailability(commands, options.availabilityState);
  }

  listBySource(options: CommandListOptions = {}): readonly CommandSourceGroup[] {
    const groups = new Map<SlashCommandSource, RegistrySlashCommand[]>();
    for (const command of this.list(options)) {
      const source = command.source ?? "builtin";
      const group = groups.get(source);
      if (group === undefined) {
        groups.set(source, [command]);
      } else {
        group.push(command);
      }
    }

    return Array.from(groups, ([source, commands]) => ({ source, commands }));
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  suggestions(name: string): readonly string[] {
    return this.detailedSuggestions(name).map((suggestion) => suggestion.name);
  }

  detailedSuggestions(
    name: string,
    options: CommandSuggestionOptions = {},
  ): readonly CommandSuggestion[] {
    const normalized = normalizeCommandName(name);
    if (normalized.length === 0) {
      return this.list({ availabilityState: options.availabilityState }).map((command) =>
        suggestionFromCommand(command),
      );
    }

    const candidates = this.list()
      .map((command, index) => ({
        command,
        index,
        match: bestMatch(command, normalized),
      }))
      .filter((candidate) => candidate.match !== null);
    const hasTextMatch = candidates.some((candidate) => (candidate.match?.rank ?? 3) < 3);

    const matches = candidates
      .filter((candidate) => !hasTextMatch || (candidate.match?.rank ?? 3) < 3)
      .sort((left, right) => compareMatches(left, right));
    const commands = withAvailability(
      matches.map((candidate) => candidate.command),
      options.availabilityState,
    );

    return matches.map((candidate, index) =>
      suggestionFromCommand(commands[index] ?? candidate.command, candidate.match?.matchedAlias),
    );
  }
}

export function normalizeCommandName(name: string): string {
  return name.replace(/^\/+/, "").trim().toLowerCase();
}

function normalizeCommand(
  command: RegistrySlashCommand,
  name: string,
  aliases: readonly string[],
): RegistrySlashCommand {
  return {
    ...command,
    name,
    aliases,
    kind: command.kind ?? "local",
    source: command.source ?? "builtin",
    isHidden: command.isHidden ?? false,
    isEnabled: command.isEnabled ?? true,
  };
}

function assertTokenAvailable(
  token: string,
  commands: ReadonlyMap<string, RegistrySlashCommand>,
  aliases: ReadonlyMap<string, string>,
): void {
  if (token.length === 0) {
    throw new Error("Command name or alias cannot be empty");
  }

  if (commands.has(token) || aliases.has(token)) {
    throw new Error(`Duplicate slash command token: ${token}`);
  }
}

interface SuggestionMatch {
  rank: number;
  distance: number;
  matchedAlias?: string;
}

function suggestionFromCommand(
  command: RegistrySlashCommand & { disabled?: boolean; disabledReason?: string },
  matchedAlias?: string,
): CommandSuggestion {
  return {
    name: command.name,
    insertText: command.name,
    description: command.description,
    source: command.source ?? "builtin",
    ...(command.category === undefined ? {} : { category: command.category }),
    kind: command.kind ?? "local",
    aliases: command.aliases ?? [],
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    ...(command.usage === undefined ? {} : { usage: command.usage }),
    ...(command.priority === undefined ? {} : { priority: command.priority }),
    ...(matchedAlias === undefined ? {} : { matchedAlias }),
    ...(command.disabled === true ? { disabled: true } : {}),
    ...(command.disabledReason === undefined ? {} : { disabledReason: command.disabledReason }),
  };
}

function withAvailability<T extends RegistrySlashCommand>(
  commands: readonly T[],
  state: CommandInputState | undefined,
): readonly (T & { disabled?: boolean; disabledReason?: string })[] {
  if (state === undefined) return commands;
  return annotateCommandAvailability(commands, state);
}

function shouldListCommand(command: RegistrySlashCommand, options: CommandListOptions): boolean {
  if (options.source !== undefined && command.source !== options.source) return false;
  if (!options.includeHidden && command.isHidden === true) return false;
  if (!options.includeDisabled && !isCommandEnabled(command)) return false;
  return true;
}

function isCommandEnabled(command: RegistrySlashCommand): boolean {
  return command.isEnabled !== false;
}

function bestMatch(command: RegistrySlashCommand, query: string): SuggestionMatch | null {
  const matches = [
    tokenMatch(command.name, query),
    ...(command.aliases ?? []).map((alias) => tokenMatch(alias, query, alias)),
  ].filter((match): match is SuggestionMatch => match !== null);

  if (matches.length === 0) return null;
  return matches.sort(compareSuggestionMatch)[0] ?? null;
}

function tokenMatch(token: string, query: string, matchedAlias?: string): SuggestionMatch | null {
  const normalized = normalizeCommandName(token);
  const aliasPart = matchedAlias === undefined ? {} : { matchedAlias };

  if (normalized === query) {
    return { rank: 0, distance: 0, ...aliasPart };
  }
  if (normalized.startsWith(query)) {
    return { rank: 1, distance: normalized.length - query.length, ...aliasPart };
  }
  if (normalized.includes(query)) {
    return { rank: 2, distance: normalized.indexOf(query), ...aliasPart };
  }

  return {
    rank: 3,
    distance: editDistance(query, normalized),
    ...aliasPart,
  };
}

function compareMatches(
  left: { command: RegistrySlashCommand; index: number; match: SuggestionMatch | null },
  right: { command: RegistrySlashCommand; index: number; match: SuggestionMatch | null },
): number {
  const byMatch = compareSuggestionMatch(left.match, right.match);
  if (byMatch !== 0) return byMatch;

  const byPriority = (right.command.priority ?? 0) - (left.command.priority ?? 0);
  if (byPriority !== 0) return byPriority;

  const byName = left.command.name.localeCompare(right.command.name);
  return byName === 0 ? left.index - right.index : byName;
}

function compareSuggestionMatch(
  left: SuggestionMatch | null,
  right: SuggestionMatch | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.rank - right.rank || left.distance - right.distance;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}
