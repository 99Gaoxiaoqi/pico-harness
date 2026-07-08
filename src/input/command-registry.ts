import type { SlashCommand } from "./types.js";

export interface CommandSuggestion {
  name: string;
  insertText: string;
  description: string;
  matchedAlias?: string;
}

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
    return this.detailedSuggestions(name).map((suggestion) => suggestion.name);
  }

  detailedSuggestions(name: string): readonly CommandSuggestion[] {
    const normalized = normalizeCommandName(name);
    if (normalized.length === 0) {
      return this.ordered.map((command) => suggestionFromCommand(command));
    }

    const candidates = this.ordered
      .map((command, index) => ({
        command,
        index,
        match: bestMatch(command, normalized),
      }))
      .filter((candidate) => candidate.match !== null);
    const hasTextMatch = candidates.some((candidate) => (candidate.match?.rank ?? 3) < 3);

    return candidates
      .filter((candidate) => !hasTextMatch || (candidate.match?.rank ?? 3) < 3)
      .sort((left, right) => compareMatches(left, right))
      .slice(0, 5)
      .map((candidate) =>
        suggestionFromCommand(candidate.command, candidate.match?.matchedAlias),
      );
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

interface SuggestionMatch {
  rank: number;
  distance: number;
  matchedAlias?: string;
}

function suggestionFromCommand(
  command: SlashCommand,
  matchedAlias?: string,
): CommandSuggestion {
  return {
    name: command.name,
    insertText: command.name,
    description: command.description,
    ...(matchedAlias === undefined ? {} : { matchedAlias }),
  };
}

function bestMatch(command: SlashCommand, query: string): SuggestionMatch | null {
  const matches = [
    tokenMatch(command.name, query),
    ...(command.aliases ?? []).map((alias) => tokenMatch(alias, query, alias)),
  ].filter((match): match is SuggestionMatch => match !== null);

  if (matches.length === 0) return null;
  return matches.sort(compareSuggestionMatch)[0] ?? null;
}

function tokenMatch(
  token: string,
  query: string,
  matchedAlias?: string,
): SuggestionMatch | null {
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
  left: { command: SlashCommand; index: number; match: SuggestionMatch | null },
  right: { command: SlashCommand; index: number; match: SuggestionMatch | null },
): number {
  const byMatch = compareSuggestionMatch(left.match, right.match);
  if (byMatch !== 0) return byMatch;

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
