import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { performance } from "node:perf_hooks";
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_KIND,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  decodeClientFrame,
  prepareRuntimeHostEndpoint,
  registerHostOperationSpecsForTesting,
  writeHostRegistration,
  FramedTransport,
  type HostStatusResult,
  type RequestFrame,
  type RuntimeHostEndpoint,
  type StorageRootCapability,
} from "../../packages/runtime-host/src/index.js";
import { defineOperation } from "../../packages/runtime-host/src/protocol/operation-spec.js";

export const TEST_DOMAIN_OPERATION = "test.domain.roundtrip";
export const TEST_LATCH_OPERATION = "test.domain.latch";
export const TEST_BOOM_OPERATION = "test.domain.boom";

export interface TestDomainOutput {
  echo: string;
}

export interface TestLatchInput {
  latchId: string;
}

export interface TestLatchOutput {
  latchId: string;
}

let testOperationsRegistered = false;

/** Idempotent：node:test 每个测试文件独立进程，重复 import 也安全。 */
export function ensureTestOperationsRegistered(): void {
  if (testOperationsRegistered) return;
  testOperationsRegistered = true;
  registerHostOperationSpecsForTesting({
    [TEST_DOMAIN_OPERATION]: defineOperation({
      mode: "query",
      availability: "ready",
      errors: ["operation_unavailable", "internal_failure"] as const,
      decodeInput: (value) => {
        if (typeof value !== "object" || value === null || Object.keys(value).length !== 0) {
          throw new Error("Invalid test.domain.roundtrip input");
        }
        return {};
      },
      decodeOutput: (value) => {
        const record = value as Record<string, unknown>;
        if (!record || typeof record.echo !== "string") {
          throw new Error("Invalid test.domain.roundtrip output");
        }
        return { echo: record.echo } as TestDomainOutput;
      },
    }),
    [TEST_LATCH_OPERATION]: defineOperation({
      mode: "query",
      availability: "ready",
      errors: ["operation_unavailable", "internal_failure"] as const,
      decodeInput: (value) => {
        const record = value as Record<string, unknown>;
        if (!record || typeof record.latchId !== "string") {
          throw new Error("Invalid test.domain.latch input");
        }
        return { latchId: record.latchId } as TestLatchInput;
      },
      decodeOutput: (value) => {
        const record = value as Record<string, unknown>;
        if (!record || typeof record.latchId !== "string") {
          throw new Error("Invalid test.domain.latch output");
        }
        return { latchId: record.latchId } as TestLatchOutput;
      },
    }),
    [TEST_BOOM_OPERATION]: defineOperation({
      mode: "query",
      availability: "ready",
      errors: ["operation_unavailable", "internal_failure"] as const,
      decodeInput: (value) => {
        if (typeof value !== "object" || value === null || Object.keys(value).length !== 0) {
          throw new Error("Invalid test.domain.boom input");
        }
        return {};
      },
      decodeOutput: (value) => {
        const record = value as Record<string, unknown>;
        if (!record || typeof record.exploded !== "boolean") {
          throw new Error("Invalid test.domain.boom output");
        }
        return { exploded: record.exploded };
      },
    }),
  });
}

/** 轮询等待条件成立（performance.now 基）；超时返回 false。condition 可为同步或 async。 */
export function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const check = async (): Promise<void> => {
      let satisfied: boolean;
      try {
        satisfied = await condition();
      } catch {
        satisfied = false;
      }
      if (satisfied) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(() => void check(), 10);
    };
    void check();
  });
}

interface LatchWaiter {
  frame: RequestFrame;
  transport: FramedTransport;
}

/**
 * Test-only fake Runtime Host：真实套接字 + 真实帧编解码 + 真实握手，但
 * domain 请求的应答时序完全由测试脚本控制（立即/延迟/永久挂死/按 latch 手动触发）。
 * host.status（含 client liveness 探针）总是立即应答，使探针不干扰 domain 场景。
 */
export class FakeRuntimeHost {
  readonly hostEpoch = randomUUID();
  readonly #latchWaiters = new Map<string, LatchWaiter[]>();
  readonly #transports = new Set<FramedTransport>();
  #server: Server | undefined;
  #endpoint: RuntimeHostEndpoint | undefined;

  async start(capability: StorageRootCapability, controlDirectory: string): Promise<void> {
    const endpoint = await prepareRuntimeHostEndpoint({
      rootId: capability.rootId,
      hostEpoch: this.hostEpoch,
    });
    this.#endpoint = endpoint;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const transport = new FramedTransport(socket);
      this.#transports.add(transport);
      void transport.closed.then(() => this.#transports.delete(transport));
      void this.#serve(transport).catch(() => undefined);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => {
        server.off("error", reject);
        resolve();
      });
      server.listen(endpoint.path);
    });
    await endpoint.prepareAfterListen();
    await writeHostRegistration(controlDirectory, {
      kind: RUNTIME_HOST_REGISTRATION_KIND,
      schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
      rootId: capability.rootId,
      hostEpoch: this.hostEpoch,
      endpoint: endpoint.path,
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      state: "ready",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
  }

  hasLatchWaiters(latchId: string): boolean {
    return (this.#latchWaiters.get(latchId)?.length ?? 0) > 0;
  }

  /** 向所有挂起在该 latch 上的请求发送成功响应。 */
  releaseLatch(latchId: string, output?: TestLatchOutput): void {
    const waiters = this.#latchWaiters.get(latchId) ?? [];
    this.#latchWaiters.delete(latchId);
    for (const waiter of waiters) {
      void waiter.transport
        .write({
          requestId: waiter.frame.requestId,
          operation: waiter.frame.operation,
          ok: true,
          result: output ?? { latchId },
        })
        .catch(() => undefined);
    }
  }

  /** 向所有挂起在该 latch 上的请求发送错误响应（模拟 handler 抛错后的 internal_failure）。 */
  failLatch(
    latchId: string,
    code: "internal_failure" | "operation_unavailable",
    message: string,
  ): void {
    const waiters = this.#latchWaiters.get(latchId) ?? [];
    this.#latchWaiters.delete(latchId);
    for (const waiter of waiters) {
      void waiter.transport
        .write({
          requestId: waiter.frame.requestId,
          operation: waiter.frame.operation,
          ok: false,
          error: { code, message },
        })
        .catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    for (const transport of this.#transports) transport.destroy();
    const server = this.#server;
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await this.#endpoint?.cleanup().catch(() => undefined);
  }

  async #serve(transport: FramedTransport): Promise<void> {
    try {
      const hello = decodeClientFrame(await transport.read(5_000));
      if (!("kind" in hello) || hello.kind !== "hello") {
        throw new Error("First frame should be a hello");
      }
      await transport.write({
        kind: "accepted",
        hostEpoch: this.hostEpoch,
        connectionId: randomUUID(),
        selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
        state: "ready",
      });
      while (true) {
        const frame = decodeClientFrame(await transport.read(0));
        if ("kind" in frame) throw new Error("Unexpected handshake frame after acceptance");
        this.#handleRequest(frame, transport);
      }
    } catch {
      transport.destroy();
    }
  }

  #handleRequest(frame: RequestFrame, transport: FramedTransport): void {
    if (frame.operation === "host.status") {
      void transport.write(this.#statusResponse(frame.requestId)).catch(() => undefined);
      return;
    }
    if (frame.operation === TEST_LATCH_OPERATION) {
      const latchId = (frame.input as TestLatchInput).latchId;
      const waiters = this.#latchWaiters.get(latchId) ?? [];
      waiters.push({ frame, transport });
      this.#latchWaiters.set(latchId, waiters);
      return;
    }
    if (frame.operation === TEST_DOMAIN_OPERATION) {
      void transport
        .write({
          requestId: frame.requestId,
          operation: frame.operation,
          ok: true,
          result: { echo: frame.requestId },
        })
        .catch(() => undefined);
      return;
    }
    void transport
      .write({
        requestId: frame.requestId,
        operation: frame.operation,
        ok: false,
        error: { code: "operation_unavailable", message: "Unknown test operation" },
      })
      .catch(() => undefined);
  }

  #statusResponse(requestId: string): {
    requestId: string;
    operation: "host.status";
    ok: true;
    result: HostStatusResult;
  } {
    return {
      requestId,
      operation: "host.status",
      ok: true,
      result: {
        hostEpoch: this.hostEpoch,
        state: "ready",
        connections: 1,
        activeOperations: 0,
        activeResidencies: 0,
      },
    };
  }
}
