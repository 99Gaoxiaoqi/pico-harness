import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonObject, RuntimeClientCapabilityCommand } from "@pico/protocol";

const CLIENT_TTL_MS = 8_000;
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 2_000;
const TIMEOUT = Symbol("client-capability-timeout");

export interface BoundClientCapabilityAuthority {
  readonly sessionId: string;
  execute(
    action: RuntimeClientCapabilityCommand["action"],
    input?: JsonObject,
  ): Promise<JsonObject>;
}

interface Pending {
  readonly command: RuntimeClientCapabilityCommand;
  claimedBy?: string;
  readonly settle: (value: { ok: true; result: JsonObject } | { ok: false; error: string }) => void;
}

/** Rendezvous for one trusted desktop app and fixed, task-scoped capability commands. */
export class ClientCapabilityCommandBroker {
  private owner?: { clientId: string; expiresAt: number };
  private readonly pending = new Map<string, Pending>();
  private readonly queue: string[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly now?: () => number;
      readonly clientTtlMs?: number;
      readonly commandTimeoutMs?: number;
    } = {},
  ) {}

  bind(sessionId: string): BoundClientCapabilityAuthority {
    return Object.freeze({
      sessionId,
      execute: (action: RuntimeClientCapabilityCommand["action"], input: JsonObject = {}) =>
        this.execute(sessionId, action, input),
    });
  }

  async nextCommand(input: {
    readonly clientId: string;
    readonly waitMs?: number;
  }): Promise<{ readonly command: RuntimeClientCapabilityCommand | null }> {
    this.assertOpen();
    this.claimClient(input.clientId);
    const immediate = this.claimNext(input.clientId);
    if (immediate) return { command: immediate };
    const waitMs = Math.min(Math.max(input.waitMs ?? 1_000, 0), MAX_WAIT_MS);
    if (waitMs === 0) return { command: null };
    let wake!: () => void;
    const ready = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.waiters.add(wake);
    await Promise.race([ready, delay(waitMs)]);
    this.waiters.delete(wake);
    this.claimClient(input.clientId);
    return { command: this.claimNext(input.clientId) };
  }

  resolveCommand(input: {
    readonly clientId: string;
    readonly commandId: string;
    readonly ok: boolean;
    readonly result?: JsonObject;
    readonly error?: string;
  }): { readonly accepted: true } {
    const pending = this.pending.get(input.commandId);
    if (!pending || pending.claimedBy !== input.clientId) {
      throw new Error("客户端能力命令不存在、已过期或不属于当前客户端");
    }
    // A claimed native operation may outlive the polling lease. Its original
    // owner can still report the result while the command itself is pending.
    if (this.owner?.clientId !== input.clientId) {
      throw new Error("Desktop 能力通道已由其他客户端接管");
    }
    this.pending.delete(input.commandId);
    pending.settle(
      input.ok
        ? { ok: true, result: input.result ?? {} }
        : { ok: false, error: input.error ?? "客户端能力执行失败" },
    );
    return { accepted: true };
  }

  invalidateSession(sessionId: string, reason = "任务能力已撤销"): void {
    for (const [id, pending] of this.pending) {
      if (pending.command.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.settle({ ok: false, error: reason });
    }
    this.queue.splice(0, this.queue.length, ...this.queue.filter((id) => this.pending.has(id)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.settle({ ok: false, error: "Desktop 能力通道已关闭" });
    }
    this.pending.clear();
    this.queue.length = 0;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private async execute(
    sessionId: string,
    action: RuntimeClientCapabilityCommand["action"],
    input: JsonObject,
  ): Promise<JsonObject> {
    this.assertOpen();
    if (!this.owner || this.owner.expiresAt <= this.now()) {
      throw new Error("Desktop 客户端未连接，能力操作不可用");
    }
    const timeoutMs = this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    const command: RuntimeClientCapabilityCommand = {
      commandId: randomUUID(),
      sessionId,
      action,
      input,
      createdAt: this.now(),
      expiresAt: this.now() + timeoutMs,
    };
    let settle!: Pending["settle"];
    const outcome = new Promise<Parameters<Pending["settle"]>[0]>((resolve) => {
      settle = resolve;
    });
    this.pending.set(command.commandId, { command, settle });
    this.queue.push(command.commandId);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    const resolved = await Promise.race([outcome, delay(timeoutMs, TIMEOUT)]);
    if (resolved === TIMEOUT) {
      this.pending.delete(command.commandId);
      throw new Error(`Desktop ${action} 操作超时，结果可能未知`);
    }
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.result;
  }

  private claimClient(clientId: string): void {
    if (!clientId.trim()) throw new Error("Desktop 客户端身份无效");
    const now = this.now();
    if (this.owner && this.owner.clientId !== clientId && this.owner.expiresAt > now) {
      throw new Error("已有 Desktop 客户端持有能力通道");
    }
    if (this.owner && this.owner.clientId !== clientId) {
      for (const pending of this.pending.values()) {
        pending.settle({ ok: false, error: "Desktop 客户端已切换" });
      }
      this.pending.clear();
      this.queue.length = 0;
    }
    this.owner = { clientId, expiresAt: now + (this.options.clientTtlMs ?? CLIENT_TTL_MS) };
  }

  private claimNext(clientId: string): RuntimeClientCapabilityCommand | null {
    while (this.queue.length) {
      const id = this.queue.shift();
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (pending.command.expiresAt <= this.now()) {
        this.pending.delete(id);
        pending.settle({ ok: false, error: "Desktop 能力命令领取前已过期" });
        continue;
      }
      pending.claimedBy = clientId;
      return pending.command;
    }
    return null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Desktop 能力通道已关闭");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
