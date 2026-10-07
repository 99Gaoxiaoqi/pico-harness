type Output = { type: "output"; id: number; data: string; reset: boolean };

/** Keep one WebView write in flight and bound output waiting for its parser callback. */
export class TerminalOutputQueue {
  #pending: Output[] = [];
  #characters = 0;
  #inFlight: number | undefined;
  #nextId = 0;
  #ready = false;
  constructor(private readonly send: (output: Output) => void) {}
  ready(value: boolean) {
    this.#ready = value;
    this.#flush();
  }
  clear() {
    this.#pending = [];
    this.#characters = 0;
    this.#inFlight = undefined;
  }
  push(data: string, reset = false): boolean {
    if (reset) {
      this.#pending = [];
      this.#characters = 0;
    }
    if (this.#characters + data.length > 128 * 1024) {
      this.#pending = [];
      this.#characters = 0;
      return false;
    }
    this.#pending.push({ type: "output", id: ++this.#nextId, data, reset });
    this.#characters += data.length;
    this.#flush();
    return true;
  }
  written(id: number) {
    if (this.#inFlight !== id) return;
    this.#inFlight = undefined;
    this.#flush();
  }
  #flush() {
    if (!this.#ready || this.#inFlight !== undefined) return;
    const output = this.#pending.shift();
    if (!output) return;
    this.#characters -= output.data.length;
    this.#inFlight = output.id;
    this.send(output);
  }
}
