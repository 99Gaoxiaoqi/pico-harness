import type { RuntimeNotification } from "./runtime.js";

export const DEFAULT_PENDING_RUNTIME_EVENT_LIMIT = 512;
export const DEFAULT_PENDING_RUNTIME_BYTES_LIMIT = 2 * 1024 * 1024;

export interface RuntimeNotificationBufferOptions {
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

/** Bounded durable notification queue. Session live data uses its dedicated sequenced channel. */
export class RuntimeNotificationBuffer {
  private readonly events: RuntimeNotification[] = [];
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(options: RuntimeNotificationBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_PENDING_RUNTIME_EVENT_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_PENDING_RUNTIME_BYTES_LIMIT;
  }

  push(event: RuntimeNotification): boolean {
    this.events.push(event);
    if (this.fits()) return true;
    this.events.pop();
    return false;
  }

  drain(): RuntimeNotification[] {
    return this.events.splice(0);
  }

  clear(): void {
    this.events.length = 0;
  }

  get size(): number {
    return this.events.length;
  }

  private fits(): boolean {
    return this.events.length <= this.maxEvents && this.byteLength() <= this.maxBytes;
  }

  private byteLength(): number {
    return Buffer.byteLength(JSON.stringify(this.events), "utf8");
  }
}
