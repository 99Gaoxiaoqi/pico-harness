import type { InputProcessResult } from "../input/types.js";
import type { CommandInputState } from "../input/command-availability.js";

const DEFAULT_MAX_QUEUED = 20;

export type RunningInputKind = "normal" | "steer" | "replace" | "inject";

export type RunningInputIntent =
  | { kind: "steer"; text: string }
  | { kind: "queue"; text: string }
  | { kind: "replace"; text: string }
  | { kind: "interrupt" };

export interface RunningInputItem {
  kind: RunningInputKind;
  text: string;
  processed?: InputProcessResult;
  commandAvailabilityState?: CommandInputState;
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

export interface RunningInputQueueSnapshot {
  queued: number;
  steers: number;
  replacement: boolean;
}

export interface RunningInputReplaceResult {
  type: "replace";
  item: RunningInputItem;
  dropped: number;
}

export class RunningInputQueue {
  private readonly queued: RunningInputItem[] = [];
  private readonly maxQueued: number;
  private pendingSteers = 0;

  constructor(options: RunningInputQueueOptions = {}) {
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  enqueue(
    text: string,
    processed?: InputProcessResult,
    options: { commandAvailabilityState?: CommandInputState } = {},
  ): RunningInputEnqueueResult {
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
      ...(options.commandAvailabilityState === undefined
        ? {}
        : { commandAvailabilityState: options.commandAvailabilityState }),
    };
    this.queued.push(item);
    return { type: "queued", item };
  }

  inject(text: string, kind: Exclude<RunningInputKind, "normal">): RunningInputInjectResult {
    if (kind === "steer") this.pendingSteers++;
    return {
      type: "inject",
      item: { kind, text },
    };
  }

  replace(text: string): RunningInputReplaceResult {
    const dropped = this.queued.length;
    this.queued.length = 0;
    const item: RunningInputItem = { kind: "replace", text };
    this.queued.push(item);
    return { type: "replace", item, dropped };
  }

  acknowledgeSteers(): void {
    this.pendingSteers = 0;
  }

  drain(): RunningInputItem[] {
    const drained = [...this.queued];
    this.queued.length = 0;
    return drained;
  }

  clear(): number {
    const removed = this.queued.length + this.pendingSteers;
    this.queued.length = 0;
    this.pendingSteers = 0;
    return removed;
  }

  get size(): number {
    return this.queued.length;
  }

  get snapshot(): RunningInputQueueSnapshot {
    return {
      queued: this.queued.filter((item) => item.kind === "normal").length,
      steers: this.pendingSteers,
      replacement: this.queued.some((item) => item.kind === "replace"),
    };
  }
}

/**
 * 运行期默认输入就是 steer；只有显式 /queue 才开启下一用户轮次。
 * 这些前缀只在 running 状态解析，idle 时仍由常规 slash registry 给出提示。
 */
export function parseRunningInputIntent(text: string): RunningInputIntent {
  const trimmed = text.trim();
  if (trimmed === "/interrupt") return { kind: "interrupt" };

  const command = /^\/(steer|queue|replace)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (command) {
    const kind = command[1] as "steer" | "queue" | "replace";
    return { kind, text: command[2]?.trim() ?? "" };
  }

  return { kind: "steer", text: trimmed };
}

export function formatRunningInputQueue(snapshot: RunningInputQueueSnapshot): string | undefined {
  const parts = [
    ...(snapshot.steers > 0 ? [`steer ${snapshot.steers}`] : []),
    ...(snapshot.queued > 0 ? [`queue ${snapshot.queued}`] : []),
    ...(snapshot.replacement ? ["replace pending"] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
