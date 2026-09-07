/** Process-local scheduling; durability belongs to cursor/receipts, not this queue. */
class SessionMemoryLane {
  private readonly queues = new Map<
    string,
    Array<{ priority: number; run: () => Promise<void> }>
  >();
  private readonly active = new Set<string>();

  run<T>(key: string, priority: "foreground" | "background", task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      queue.push({
        priority: priority === "foreground" ? 0 : 1,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.queues.set(key, queue);
      void this.drain(key);
    });
  }

  private async drain(key: string): Promise<void> {
    if (this.active.has(key)) return;
    this.active.add(key);
    try {
      const queue = this.queues.get(key)!;
      while (queue.length) {
        queue.sort((a, b) => a.priority - b.priority);
        await queue.shift()!.run();
      }
    } finally {
      this.queues.delete(key);
      this.active.delete(key);
    }
  }
}

export const sessionMemoryLane = new SessionMemoryLane();
