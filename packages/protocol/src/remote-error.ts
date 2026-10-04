export class RemoteProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcome?: "not_executed" | "unknown",
  ) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}
