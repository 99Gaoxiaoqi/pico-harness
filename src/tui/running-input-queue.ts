import type { InputProcessResult } from "../input/types.js";

const DEFAULT_MAX_QUEUED = 20;

export type RunningInputKind = "normal" | "steer" | "inject";

export interface RunningInputItem {
  kind: RunningInputKind;
  text: string;
  processed?: InputProcessResult;
}

export interface RunningInputQueueOptions {
  maxQueued?: number;
}

export type RunningInputEnqueueResult =
  | {
      type: "queued";
      item: RunningInputItem;
    }
  | {
      type: "rejected";
      reason: "full";
      capacity: number;
    };

export interface RunningInputInjectResult {
  type: "inject";
  item: RunningInputItem;
}

export class RunningInputQueue {
  private readonly queued: RunningInputItem[] = [];
  private readonly maxQueued: number;

  constructor(options: RunningInputQueueOptions = {}) {
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  enqueue(text: string, processed?: InputProcessResult): RunningInputEnqueueResult {
    if (this.queued.length >= this.maxQueued) {
      return {
        type: "rejected",
        reason: "full",
        capacity: this.maxQueued,
      };
    }

    const item: RunningInputItem = {
      kind: "normal",
      text,
      ...(processed === undefined ? {} : { processed }),
    };
    this.queued.push(item);
    return { type: "queued", item };
  }

  inject(text: string, kind: Exclude<RunningInputKind, "normal">): RunningInputInjectResult {
    return {
      type: "inject",
      item: { kind, text },
    };
  }

  drain(): RunningInputItem[] {
    const drained = [...this.queued];
    this.queued.length = 0;
    return drained;
  }

  clear(): number {
    const removed = this.queued.length;
    this.queued.length = 0;
    return removed;
  }

  get size(): number {
    return this.queued.length;
  }
}
