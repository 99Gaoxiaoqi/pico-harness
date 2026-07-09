import type { SlashCommand } from "./types.js";

export type CommandAvailability = "always" | "idle" | "running";
export type CommandInputState = "idle" | "running" | "modal";

export type AvailabilityCommand = Pick<SlashCommand, "name"> & {
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
