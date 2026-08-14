import {
  decodeClientFrame,
  RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS,
  type HostOperationErrorCode,
  type RequestFrame,
  type ResponseFrame,
} from "../protocol/index.js";
import type { FramedTransport } from "../transport/framed-transport.js";
import {
  dispatchOperation,
  operationFailureResponse,
  type ConnectionContext,
  type OperationHandlerMap,
  type OperationResidency,
} from "./operation-dispatcher.js";
import { BoundedSerialOutboundWriter } from "./serial-outbound-writer.js";
import { RuntimeHostTransportError } from "../transport/framed-transport.js";

// How long a deadline failure response may take to flush before the connection
// is torn down regardless. The response is best-effort: teardown must not be
// gated on a client that has stopped reading.
const OPERATION_DEADLINE_RESPONSE_GRACE_MS = 1_000;

type AcceptedConnectionContext = Omit<ConnectionContext, "acquireResidency">;

export interface ConnectionOperationLease {
  acquireResidency(): OperationResidency;
  seal(): void;
  finish(): void;
}

export interface RuntimeHostConnectionSessionOptions {
  transport: FramedTransport;
  connection: AcceptedConnectionContext;
  resolveHandlers(): OperationHandlerMap;
  beginOperation(frame: RequestFrame): Promise<ConnectionOperationLease | HostOperationErrorCode>;
  onTeardown(): void;
  /**
   * Server-side deadline for a single operation. A handler that has not
   * settled within this window is abandoned: its admission is force-finished
   * (kernel counters decrement), the client receives a best-effort failure
   * response, and the connection is torn down.
   */
  operationDeadlineMs: number;
}

export class RuntimeHostConnectionSession {
  readonly #options: RuntimeHostConnectionSessionOptions;
  readonly #writer: BoundedSerialOutboundWriter;
  readonly #requests = new Map<string, Promise<void>>();
  #inFlightStatusRequests = 0;
  #closed = false;

  constructor(options: RuntimeHostConnectionSessionOptions) {
    this.#options = options;
    this.#writer = new BoundedSerialOutboundWriter(options.transport, () => this.#teardown());
  }

  async run(): Promise<void> {
    try {
      try {
        await this.#pumpInbound();
      } catch (error) {
        if (!isReadEof(error)) throw error;
        await this.#closeAfterDispatchedReplies();
      }
    } catch {
      this.#teardown();
    } finally {
      this.#teardown();
      await Promise.allSettled(this.#requests.values());
      await Promise.all([this.#writer.settled(), this.#options.transport.closed]);
    }
  }

  async #closeAfterDispatchedReplies(): Promise<void> {
    const outcome = await Promise.race([
      Promise.allSettled([...this.#requests.values()]).then(() => "drained" as const),
      this.#options.transport.closed.then(() => "closed" as const),
    ]);
    if (outcome === "closed") {
      this.#teardown();
      return;
    }
    if (this.#closed) return;
    await this.#writer.settled();
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.close();
    this.#options.transport.destroyAfterFlush();
    this.#options.onTeardown();
  }

  async #pumpInbound(): Promise<void> {
    while (!this.#closed) {
      const frame = decodeClientFrame(await this.#options.transport.read(0));
      if ("kind" in frame) {
        // After the hello, the only remaining ClientFrame variant is a request.
        throw new Error("Unexpected handshake frame after acceptance");
      }
      const usesLivenessReserve =
        this.#requests.size === RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS &&
        (frame.operation === "host.status" || this.#inFlightStatusRequests > 0);
      if (
        this.#requests.has(frame.requestId) ||
        (this.#requests.size >= RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS && !usesLivenessReserve)
      ) {
        this.#teardown();
        return;
      }
      this.#dispatch(frame);
    }
  }

  #dispatch(frame: RequestFrame): void {
    if (frame.operation === "host.status") this.#inFlightStatusRequests += 1;
    const task = this.#handleRequest(frame)
      .catch(() => this.#teardown())
      .finally(() => {
        if (this.#requests.get(frame.requestId) === task) {
          this.#requests.delete(frame.requestId);
          if (frame.operation === "host.status") this.#inFlightStatusRequests -= 1;
        }
      });
    this.#requests.set(frame.requestId, task);
  }

  async #handleRequest(frame: RequestFrame): Promise<void> {
    const admission = await this.#options.beginOperation(frame);
    if (typeof admission === "string") {
      if (this.#closed) return;
      await this.#writer.enqueue(
        operationFailureResponse(
          frame,
          admission,
          admission === "host_draining" ? "Runtime Host is draining" : "Runtime Host is not ready",
        ),
      ).flushed;
      return;
    }

    if (this.#closed) {
      // 连接已在别处 teardown：不再启动 handler（3-B 的 handler 可能很昂贵），
      // 直接释放 admission。
      admission.finish();
      return;
    }
    const controller = new AbortController();
    const dispatchTask = dispatchOperation(frame, this.#options.resolveHandlers(), {
      ...this.#options.connection,
      acquireResidency: () => admission.acquireResidency(),
      signal: controller.signal,
    });
    let deadlineExpired = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      const response = await Promise.race([
        dispatchTask,
        new Promise<ResponseFrame>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            deadlineExpired = true;
            controller.abort();
            reject(new OperationDeadlineError());
          }, this.#options.operationDeadlineMs);
        }),
      ]);
      admission.seal();
      await this.#writer.enqueue(response).flushed;
    } catch (error) {
      if (deadlineExpired) {
        // JS 无法真正取消一个挂死的 async handler（除非它响应上面的 AbortSignal）。
        // deadline 到期后不再等它：强制 finish admission 使 kernel 计数递减，
        // 给 client 一个 best-effort 超时错误，然后 teardown 整条连接。泄漏的
        // handler promise 在后台继续运行，但不再占用连接与 operation 计数；
        // 它后续若 acquireResidency 会被 lease 守卫拒绝（seal/finish 已发生）。
        admission.finish();
        await this.#respondWithDeadlineFailure(frame);
        this.#teardown();
        return;
      }
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      // deadline 路径已在 catch 中 finish；这里只覆盖正常与 handler 抛错路径。
      if (!deadlineExpired) admission.finish();
      // deadline 先到时 handler 可能之后才 settle（甚至 reject）；吞掉该 rejection，
      // 避免被放弃的 handler 产生 unhandled rejection。
      dispatchTask.catch(() => undefined);
    }
  }

  async #respondWithDeadlineFailure(frame: RequestFrame): Promise<void> {
    if (this.#closed) return;
    try {
      const receipt = this.#writer.enqueue(
        operationFailureResponse(
          frame,
          "internal_failure",
          `Runtime Host operation ${frame.operation} exceeded its server-side deadline`,
        ),
      );
      await Promise.race([
        receipt.flushed,
        new Promise<void>((resolve) => {
          setTimeout(resolve, OPERATION_DEADLINE_RESPONSE_GRACE_MS);
        }),
      ]);
    } catch {
      // Best-effort：连接即将被 teardown，超时错误响应写不出去也不影响清理。
    }
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#writer.close();
    this.#options.transport.destroy();
    this.#options.onTeardown();
  }
}

function isReadEof(error: unknown): boolean {
  return error instanceof RuntimeHostTransportError && error.code === "read_eof";
}

/** Internal race token; never escapes the session. */
class OperationDeadlineError extends Error {
  constructor() {
    super("Runtime Host operation exceeded its server-side deadline");
    this.name = "OperationDeadlineError";
  }
}
