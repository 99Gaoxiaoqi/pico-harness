export type CommandAvailability = "always" | "idle" | "running";
export type CommandInputState = "idle" | "running" | "modal";

export interface AvailabilityCommand {
  readonly name: string;
  readonly kind?: string;
  readonly availability?: CommandAvailability;
}

export interface CommandAvailabilityResult {
  readonly available: boolean;
  readonly disabledReason?: string;
}

export type AvailabilityAnnotatedCommand<Command extends AvailabilityCommand> = Command & {
  readonly disabled: boolean;
  readonly disabledReason?: string;
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
  if (availability === "always" || availability === state) return { available: true };
  return {
    available: false,
    disabledReason:
      availability === "idle"
        ? "Command is only available while idle."
        : "Command is only available while running.",
  };
}

export function annotateCommandAvailability<Command extends AvailabilityCommand>(
  commands: readonly Command[],
  state: CommandInputState,
): readonly AvailabilityAnnotatedCommand<Command>[] {
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
