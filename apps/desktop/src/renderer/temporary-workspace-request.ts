export class TemporaryWorkspaceRequest {
  #inFlight?: Promise<string | undefined>;

  run(operation: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.#inFlight) return this.#inFlight;

    const request = operation();
    this.#inFlight = request;
    const clear = () => {
      if (this.#inFlight === request) this.#inFlight = undefined;
    };
    void request.then(clear, clear);
    return request;
  }
}
