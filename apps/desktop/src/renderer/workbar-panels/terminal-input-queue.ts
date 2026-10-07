const CHUNK_BYTES = 16 * 1024;
const QUEUE_BYTES = 1024 * 1024;

/** Serialize raw PTY input. Failed or stale writes are never replayed. */
export function createTerminalInputQueue(options: {
  canSend(): boolean;
  send(data: string): Promise<void>;
  onError(error: unknown): void;
}) {
  const pending: { data: string; bytes: number }[] = [];
  let pendingBytes = 0;
  let running = false;
  let closed = false;
  const drain = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (pending.length && !closed) {
        if (!options.canSend()) {
          pending.length = 0;
          pendingBytes = 0;
          break;
        }
        const next = pending.shift()!;
        try {
          await options.send(next.data);
        } finally {
          pendingBytes = Math.max(0, pendingBytes - next.bytes);
        }
      }
    } catch (error) {
      closed = true;
      pending.length = 0;
      pendingBytes = 0;
      options.onError(error);
    } finally {
      running = false;
    }
  };
  return {
    enqueue(data: string): void {
      if (!data || closed || !options.canSend()) return;
      const bytes = new TextEncoder().encode(data).byteLength;
      if (pendingBytes + bytes > QUEUE_BYTES) {
        options.onError(new Error("终端输入排队超过 1 MiB，本次输入未发送。"));
        return;
      }
      let chunk = "";
      let chunkBytes = 0;
      for (const character of data) {
        const point = character.codePointAt(0)!;
        const characterBytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (chunkBytes + characterBytes > CHUNK_BYTES) {
          pending.push({ data: chunk, bytes: chunkBytes });
          chunk = "";
          chunkBytes = 0;
        }
        chunk += character;
        chunkBytes += characterBytes;
      }
      if (chunk) pending.push({ data: chunk, bytes: chunkBytes });
      pendingBytes += bytes;
      void drain();
    },
    dispose(): void {
      closed = true;
      pending.length = 0;
      pendingBytes = 0;
    },
  };
}
