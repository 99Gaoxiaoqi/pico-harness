import type { SlashCommand } from "./types.js";

export type CommandAvailability = "always" | "idle" | "running";
export type CommandInputState = "idle" | "running" | "modal";
export const RUNNING_ALLOWED_LOCAL_COMMANDS = ["help", "status", "mcp"] as const;
const RUNNING_ALLOWED_LOCAL_COMMAND_SET = new Set<string>(RUNNING_ALLOWED_LOCAL_COMMANDS);

export type AvailabilityCommand = Pick<SlashCommand, "name"> &
  Partial<Pick<SlashCommand, "kind">> & {
  availability?: CommandAvailability;
};

export interface CommandAvailabilityResult {
  available: boolean;
  disabledReason?: string;
}

export type AvailabilityAnnotatedCommand<T extends AvailabilityCommand> = T & {
  disabled: boolean;
  disabledReason?: string;
};

export function getCommandAvailability(
  command: AvailabilityCommand,
  state: CommandInputState,
): CommandAvailabilityResult {
  if (state === "modal") {
    return {
      available: false,
      disabledReason: "Command unavailable while a modal is active.",
    };
  }

  const availability = command.availability ?? "always";
  if (
    state === "running" &&
    availability === "always" &&
    (command.kind ?? "local") === "local" &&
    !RUNNING_ALLOWED_LOCAL_COMMAND_SET.has(command.name)
  ) {
    return {
      available: false,
      disabledReason: "Cannot run while the agent is running.",
    };
  }

  if (availability === "always" || availability === state) {
    return { available: true };
  }

  return {
    available: false,
    disabledReason:
      availability === "idle"
        ? "Command is only available while idle."
        : "Command is only available while running.",
  };
}

export function annotateCommandAvailability<T extends AvailabilityCommand>(
  commands: readonly T[],
  state: CommandInputState,
): readonly AvailabilityAnnotatedCommand<T>[] {
  return commands.map((command) => {
    const availability = getCommandAvailability(command, state);
    return {
      ...command,
      disabled: !availability.available,
      ...(availability.disabledReason === undefined
        ? {}
        : { disabledReason: availability.disabledReason }),
    };
  });
}
