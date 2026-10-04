/** A foreground Hook cannot complete safely without proof that its owned process tree stopped. */
export class HookProcessTreeTerminationError extends AggregateError {}
