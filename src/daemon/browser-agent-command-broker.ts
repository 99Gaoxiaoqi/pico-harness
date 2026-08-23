import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  JsonObject,
  RuntimeBrowserAgentAction,
  RuntimeBrowserAgentCommand,
} from "@pico/protocol";
import type { BoundBrowserAgentAuthority } from "../tools/browser-agent.js";

const DEFAULT_LEASE_TTL_MS = 8_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_POLL_WAIT_MS = 2_000;
const TIMEOUT = Symbol("browser-command-timeout");

export type BrowserAgentBrokerErrorCode =
  | "BROWSER_NOT_VISIBLE"
  | "BROWSER_LEASE_STALE"
  | "BROWSER_COMMAND_TIMEOUT"
  | "BROWSER_COMMAND_FAILED"
  | "BROWSER_BROKER_CLOSED";

export class BrowserAgentBrokerError extends Error {
  constructor(
    readonly code: BrowserAgentBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserAgentBrokerError";
  }
}

interface BrowserLease {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly expiresAt: number;
}

interface PendingCommand {
  readonly command: RuntimeBrowserAgentCommand;
  claimedLeaseId?: string;
  readonly settle: (outcome: CommandOutcome) => void;
}

type CommandOutcome =
  | { readonly ok: true; readonly result: JsonObject }
  | { readonly ok: false; readonly error: string };

/**
 * In-memory rendezvous between daemon-owned model tools and the visible Electron panel.
 * Commands are fixed-operation JSON messages: neither side receives a script/eval primitive.
 */
export class BrowserAgentCommandBroker {
  private readonly leases = new Map<string, BrowserLease>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly queues = new Map<string, string[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly now?: () => number;
      readonly leaseTtlMs?: number;
      readonly commandTimeoutMs?: number;
    } = {},
  ) {}

  bind(sessionId: string): BoundBrowserAgentAuthority {
    return Object.freeze({
      sessionId,
      execute: (action: RuntimeBrowserAgentAction, input: JsonObject = {}) =>
        this.execute(sessionId, action, input),
    });
  }

  acquireLease(input: {
    readonly sessionId: string;
    readonly visible: boolean;
    readonly generation: number;
    readonly leaseId?: string;
  }): { readonly leaseId: string; readonly expiresAt: number; readonly visible: boolean } {
    this.assertOpen();
    this.sweepExpired(input.sessionId);
    const current = this.leases.get(input.sessionId);
    if (!input.visible) {
      if (!current || !input.leaseId || current.leaseId === input.leaseId) {
        this.invalidateSession(input.sessionId, "浏览器面板已隐藏");
      }
      return {
        leaseId: input.leaseId ?? current?.leaseId ?? randomUUID(),
        expiresAt: this.now(),
        visible: false,
      };
    }

    if (current && current.leaseId !== input.leaseId && input.generation <= current.generation) {
      throw new BrowserAgentBrokerError(
        "BROWSER_LEASE_STALE",
        "浏览器面板租约已被更新的可见实例替代",
      );
    }
    if (current && current.leaseId !== input.leaseId) {
      this.rejectSessionCommands(input.sessionId, "浏览器可见实例已切换");
    }
    const lease: BrowserLease = {
      sessionId: input.sessionId,
      leaseId: current && current.leaseId === input.leaseId ? current.leaseId : randomUUID(),
      generation: Math.max(input.generation, current?.generation ?? 0),
      expiresAt: this.now() + (this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS),
    };
    this.leases.set(input.sessionId, lease);
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt, visible: true };
  }

  async nextCommand(input: {
    readonly sessionId: string;
    readonly leaseId: string;
    readonly waitMs?: number;
  }): Promise<{ readonly command: RuntimeBrowserAgentCommand | null }> {
    this.requireLease(input.sessionId, input.leaseId);
    const immediate = this.claimNext(input.sessionId, input.leaseId);
    if (immediate) return { command: immediate };
    const waitMs = Math.min(Math.max(input.waitMs ?? 1_000, 0), MAX_POLL_WAIT_MS);
    if (waitMs === 0) return { command: null };
    const waiter = this.waitForQueue(input.sessionId);
    await Promise.race([waiter.promise, delay(waitMs)]);
    waiter.cancel();
    this.requireLease(input.sessionId, input.leaseId);
    return { command: this.claimNext(input.sessionId, input.leaseId) };
  }

  resolveCommand(input: {
    readonly sessionId: string;
    readonly leaseId: string;
    readonly commandId: string;
    readonly ok: boolean;
    readonly result?: JsonObject;
    readonly error?: string;
  }): { readonly accepted: true } {
    this.requireLease(input.sessionId, input.leaseId);
    const pending = this.pending.get(input.commandId);
    if (
      !pending ||
      pending.command.sessionId !== input.sessionId ||
      pending.claimedLeaseId !== input.leaseId
    ) {
      throw new BrowserAgentBrokerError(
        "BROWSER_LEASE_STALE",
        "浏览器命令不存在、已过期或不属于当前 Session 租约",
      );
    }
    this.removePending(input.commandId);
    pending.settle(
      input.ok
        ? { ok: true, result: input.result ?? {} }
        : { ok: false, error: input.error ?? "浏览器操作失败" },
    );
    return { accepted: true };
  }

  invalidateSession(sessionId: string, reason = "浏览器 Session 已关闭"): void {
    this.leases.delete(sessionId);
    this.rejectSessionCommands(sessionId, reason);
    this.wake(sessionId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sessionId of new Set([...this.leases.keys(), ...this.queues.keys()])) {
      this.invalidateSession(sessionId, "浏览器命令代理已关闭");
    }
  }

  private async execute(
    sessionId: string,
    action: RuntimeBrowserAgentAction,
    input: JsonObject,
  ): Promise<JsonObject> {
    this.assertOpen();
    const lease = this.requireVisibleLease(sessionId);
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const command: RuntimeBrowserAgentCommand = {
      commandId: randomUUID(),
      sessionId,
      action,
      input,
      createdAt: this.now(),
      expiresAt: this.now() + timeoutMs,
    };
    let settle!: (outcome: CommandOutcome) => void;
    const outcome = new Promise<CommandOutcome>((resolve) => {
      settle = resolve;
    });
    this.pending.set(command.commandId, { command, settle });
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(command.commandId);
    this.queues.set(sessionId, queue);
    this.wake(sessionId);

    const result = await Promise.race([outcome, delay(timeoutMs, TIMEOUT)]);
    if (result === TIMEOUT) {
      this.removePending(command.commandId);
      throw new BrowserAgentBrokerError(
        "BROWSER_COMMAND_TIMEOUT",
        `浏览器 ${action} 操作超时；请确认对应面板仍然可见`,
      );
    }
    if (!result.ok) {
      throw new BrowserAgentBrokerError("BROWSER_COMMAND_FAILED", result.error);
    }
    // A response from an expired/replaced lease is never accepted even if it raced expiry.
    if (this.leases.get(sessionId)?.leaseId !== lease.leaseId) {
      throw new BrowserAgentBrokerError("BROWSER_LEASE_STALE", "浏览器操作完成时可见租约已经失效");
    }
    return result.result;
  }

  private claimNext(sessionId: string, leaseId: string): RuntimeBrowserAgentCommand | null {
    const queue = this.queues.get(sessionId);
    while (queue?.length) {
      const commandId = queue.shift();
      if (!commandId) continue;
      const pending = this.pending.get(commandId);
      if (!pending || pending.command.expiresAt <= this.now()) {
        if (pending) {
          this.removePending(commandId);
          pending.settle({ ok: false, error: "浏览器命令领取前已过期" });
        }
        continue;
      }
      pending.claimedLeaseId = leaseId;
      if (queue.length === 0) this.queues.delete(sessionId);
      return pending.command;
    }
    this.queues.delete(sessionId);
    return null;
  }

  private requireVisibleLease(sessionId: string): BrowserLease {
    this.sweepExpired(sessionId);
    const lease = this.leases.get(sessionId);
    if (!lease) {
      throw new BrowserAgentBrokerError(
        "BROWSER_NOT_VISIBLE",
        "当前 Session 的浏览器面板不可见；请先在 Workbar 打开浏览器",
      );
    }
    return lease;
  }

  private requireLease(sessionId: string, leaseId: string): BrowserLease {
    const lease = this.requireVisibleLease(sessionId);
    if (lease.leaseId !== leaseId) {
      throw new BrowserAgentBrokerError("BROWSER_LEASE_STALE", "浏览器面板租约已失效");
    }
    return lease;
  }

  private sweepExpired(sessionId: string): void {
    const lease = this.leases.get(sessionId);
    if (!lease || lease.expiresAt > this.now()) return;
    this.invalidateSession(sessionId, "浏览器面板可见租约已过期");
  }

  private rejectSessionCommands(sessionId: string, reason: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    const ids = new Set(queue);
    for (const [commandId, pending] of this.pending) {
      if (pending.command.sessionId === sessionId) ids.add(commandId);
    }
    for (const commandId of ids) {
      const pending = this.pending.get(commandId);
      if (!pending) continue;
      this.pending.delete(commandId);
      pending.settle({ ok: false, error: reason });
    }
  }

  private removePending(commandId: string): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    const queue = this.queues.get(pending.command.sessionId);
    if (!queue) return;
    const index = queue.indexOf(commandId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(pending.command.sessionId);
  }

  private waitForQueue(sessionId: string): { readonly promise: Promise<void>; cancel(): void } {
    let cancel = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      const done = (): void => {
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(sessionId);
        resolve();
      };
      cancel = () => {
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(sessionId);
      };
      waiters.add(done);
      this.waiters.set(sessionId, waiters);
    });
    return { promise, cancel };
  }

  private wake(sessionId: string): void {
    const waiters = this.waiters.get(sessionId);
    if (!waiters) return;
    this.waiters.delete(sessionId);
    for (const waiter of waiters) waiter();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BrowserAgentBrokerError("BROWSER_BROKER_CLOSED", "浏览器命令代理已关闭");
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
