/** FIFO user steer queue for a currently running Agent session. */
export class SteerQueue {
  private queue: string[] = [];

  push(text: string): void {
    if (text) this.queue.push(text);
  }

  peek(): string | undefined {
    return this.queue[0];
  }

  drain(): string[] {
    const queued = this.queue;
    this.queue = [];
    return queued;
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }
}
