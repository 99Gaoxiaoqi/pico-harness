import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import {
  discoverMarkedStorageRoot,
  prepareStorageRootControlDirectory,
  resolveExistingStorageRootControlDirectory,
  resolveStorageRoot,
  type StorageRootCapability,
} from "../control/root-authority.js";
import { readHostRegistration, RuntimeHostRegistrationError } from "../control/registration.js";
import {
  decodeHostFrame,
  resolveOperationSpec,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS,
  requireClientInstanceId,
  validateProtocolRange,
  type ClientSurface,
  type HostDiagnosticsResult,
  type HostIncompatible,
  type HostOperationErrorCode,
  type HostRegistration,
  type HostStatusResult,
  type KnownOperationKey,
  type OperationInput,
  type OperationKey,
  type OperationOutput,
  type ProtocolRange,
  type RequestFrame,
  type ResponseFrame,
} from "../protocol/index.js";
import { FramedTransport, RuntimeHostTransportError } from "../transport/framed-transport.js";
import type { OperationSpec } from "../protocol/operation-spec.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 2_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 2_000;

export interface ConnectRuntimeHostInput {
  rootPath: string;
  surface: ClientSurface;
  protocol: ProtocolRange;
  clientInstanceId?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /**
   * Interval between liveness probes while a domain request is outstanding.
   * Injectable so tests exercise requests that outlive a probe cycle without
   * waiting the real cadence; defaults to DEFAULT_LIVENESS_INTERVAL_MS (2s).
   */
  livenessIntervalMs?: number;
  /**
   * How long a retired (timed-out) domain request pins its in-flight slot
   * before the slot is force-released. Injectable so tests can fast-forward
   * the slot TTL without waiting the real RETIRED_SLOT_TTL_MS (30s).
   */
  retiredSlotTtlMs?: number;
  /**
   * Absolute TTL after which a retired request entry is removed entirely.
   * Injectable so tests can fast-forward the entry TTL without waiting the
   * real RETIRED_ENTRY_TTL_MS (5min).
   */
  retiredEntryTtlMs?: number;
  /**
   * Invoked after each liveness probe round-trips and validates its Host
   * Epoch. Test observability: lets a probe-crossing test prove probes
   * actually fired inside its window instead of assuming the cadence took.
   * Diagnostics only — exceptions it throws are swallowed and never affect
   * connection health.
   */
  onLivenessProbe?: () => void;
}

export type RuntimeHostUnavailableReason =
  | "not_registered"
  | "invalid_registration"
  | "root_mismatch"
  | "connect_failed"
  | "handshake_failed"
  | "epoch_mismatch";

export type ConnectRuntimeHostResult =
  | {
      kind: "connected";
      connection: RuntimeHostConnection;
      registration: HostRegistration;
    }
  | {
      kind: "incompatible";
      handshake: HostIncompatible;
      registration: HostRegistration;
    }
  | { kind: "draining"; registration: HostRegistration }
  | {
      kind: "unavailable";
      reason: RuntimeHostUnavailableReason;
      registration?: HostRegistration;
    };

type ConnectResolvedRuntimeHostResult =
  | ConnectRuntimeHostResult
  | {
      kind: "election_deadline_elapsed";
      endpointConnected: boolean;
    };

class ElectionDeadlineElapsedError extends Error {
  constructor() {
    super("Runtime Host election deadline elapsed");
    this.name = "ElectionDeadlineElapsedError";
  }
}

interface ConnectResolvedRuntimeHostInput
  extends Omit<ConnectRuntimeHostInput, "rootPath" | "clientInstanceId"> {
  capability: StorageRootCapability<"interactive">;
  clientInstanceId: string;
  controlDirectory: string;
  electionDeadline?: number;
}

export interface RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>>;
  /**
   * Typed access to operations registered outside the static OperationKey
   * surface (currently only test-only specs registered via
   * registerHostOperationSpecsForTesting). Runtime behavior is identical to
   * request(): domain keys go through slot allocation/retirement, and
   * host.status remains the only non-domain key.
   */
  requestRegistered<Output = unknown>(
    operation: string,
    input: unknown,
    timeoutMs?: number,
  ): Promise<Output>;
  /**
   * Sets the listener for Host-initiated event frames (`kind: "event"`). At most
   * one listener per connection: the last call wins. The payload is an opaque
   * JSON record — callers validate the domain shape themselves. Event frames may
   * interleave with responses in either order; they never carry a requestId and
   * never fail the connection on their own.
   */
  setEventListener(listener: ((event: Record<string, unknown>) => void) | undefined): void;
  /**
   * Test observability: the number of in-flight domain request slots. Lets
   * lifecycle tests assert slot allocation/release/force-release directly
   * instead of saturating RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS to
   * observe a wedge. Production callers have no use for it.
   */
  readonly inFlightDomainRequestCount: number;
  /**
   * Test observability: the number of retired request entries still pinned in
   * the retired map. Lets lifecycle tests assert entry-TTL removal (and the
   * liveness stop that follows) without waiting on wall-clock heuristics alone.
   */
  readonly retiredRequestCount: number;
  /** Test observability: the terminal failure (undefined while healthy). */
  readonly terminalError: Error | undefined;
  status(timeoutMs?: number): Promise<HostStatusResult>;
  queryHostDiagnostics(timeoutMs?: number): Promise<HostDiagnosticsResult>;
  close(): Promise<void>;
}

// The 3-A skeleton registers only bootstrap operations, so every operation key
// is a direct request; subscriptions and capability mutations arrive in 3-B.
export type DirectRequestOperationKey = OperationKey;

export class RuntimeHostOperationError extends Error {
  constructor(
    // KnownOperationKey：错误也可能来自 test-only 动态注册的操作。
    readonly operation: KnownOperationKey,
    readonly code: HostOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeHostOperationError";
  }
}

interface PendingRequest {
  operation: KnownOperationKey;
  accept(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(error: Error): void;
  domainState?: "queued" | "in_flight";
  timer?: NodeJS.Timeout;
}

interface RetiredRequest {
  operation: KnownOperationKey;
  domainState?: "in_flight";
  /** Set once the retired-slot TTL force-released the in-flight domain slot. */
  slotReleased?: boolean;
  /** TTL timer bounding how long a retired entry may pin state; cleared on match/fail. */
  slotTimer?: NodeJS.Timeout;
  /** Absolute TTL after which the entry itself is removed (bounds liveness churn). */
  entryTimer?: NodeJS.Timeout;
}

interface QueuedDomainFrame {
  requestId: string;
  frame: RequestFrame;
}

type RequestTimeoutScope = "request" | "connection";

// A timed-out domain request retires and waits for its (possibly never-arriving)
// response. Its in-flight slot is force-released after this TTL so a hung host
// handler cannot pin all RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS slots and
// wedge the domain channel while liveness probes still succeed. The entry itself
// stays until a matching response arrives, so a genuinely late response is still
// reconciled instead of failing the connection as unmatched.
const RETIRED_SLOT_TTL_MS = 30_000;
// The retired entry itself is removed after this longer absolute TTL. Until then a
// late response is still reconciled; after removal a very-late response is treated
// as unmatched. This bounds the retired map and stops the perpetual liveness probes
// a half-dead host (alive but never answering some request) would otherwise cause.
const RETIRED_ENTRY_TTL_MS = 5 * 60_000;

class RuntimeHostConnectionImpl implements RuntimeHostConnection {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly selectedProtocol: number;
  readonly closed: Promise<void>;
  readonly #transport: FramedTransport;
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #retiredRequests = new Map<string, RetiredRequest>();
  readonly #queuedDomainFrames: QueuedDomainFrame[] = [];
  #livenessTimer: NodeJS.Timeout | undefined;
  #livenessProbePending = false;
  #inFlightDomainRequests = 0;
  #terminalError: Error | undefined;
  #eventListener: ((event: Record<string, unknown>) => void) | undefined;
  readonly #livenessIntervalMs: number;
  readonly #retiredSlotTtlMs: number;
  readonly #retiredEntryTtlMs: number;
  readonly #onLivenessProbe: (() => void) | undefined;

  constructor(
    transport: FramedTransport,
    accepted: {
      hostEpoch: string;
      connectionId: string;
      selectedProtocol: number;
    },
    // livenessIntervalMs / retiredSlotTtlMs / retiredEntryTtlMs are validated
    // by connectResolvedRuntimeHost alongside the other connect timeouts,
    // before any transport work happens.
    options?: {
      livenessIntervalMs?: number;
      retiredSlotTtlMs?: number;
      retiredEntryTtlMs?: number;
      onLivenessProbe?: () => void;
    },
  ) {
    this.#livenessIntervalMs = options?.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.#retiredSlotTtlMs = options?.retiredSlotTtlMs ?? RETIRED_SLOT_TTL_MS;
    this.#retiredEntryTtlMs = options?.retiredEntryTtlMs ?? RETIRED_ENTRY_TTL_MS;
    this.#onLivenessProbe = options?.onLivenessProbe;
    this.#transport = transport;
    this.hostEpoch = accepted.hostEpoch;
    this.connectionId = accepted.connectionId;
    this.selectedProtocol = accepted.selectedProtocol;
    this.closed = this.#transport.closed;
    void this.#readResponses();
  }

  request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs?: number,
  ): Promise<OperationOutput<K>> {
    // 公共 request() 一律用 request 级超时：host.status 超时只 retire 该请求，
    // 不应把整条连接 fail 掉（否则调用方传一个短 timeout 就会误杀连接）。
    // connection 级失败仅保留给内部 liveness 探针（#runLivenessProbe）。
    return this.#requestOperation(
      operation,
      input,
      timeoutMs ?? (operation === "host.status" ? DEFAULT_LIVENESS_TIMEOUT_MS : undefined),
      (result) => result,
      "request",
    );
  }

  requestRegistered<Output = unknown>(
    operation: string,
    input: unknown,
    timeoutMs?: number,
  ): Promise<Output> {
    // 动态注册操作的 input/output 类型不在静态 OperationKey 面内，这里按
    // unknown 穿过；spec.decodeInput/decodeOutput 仍在运行时完整校验。
    return this.#requestOperation(
      operation as OperationKey,
      input as OperationInput<OperationKey>,
      timeoutMs,
      (result) => result as Output,
      "request",
    );
  }

  #requestOperation<K extends OperationKey, Result>(
    operation: K,
    input: OperationInput<K>,
    timeoutMs: number | undefined,
    accept: (result: OperationOutput<K>) => Result,
    timeoutScope: RequestTimeoutScope,
  ): Promise<Result> {
    const boundedTimeoutMs =
      timeoutMs === undefined ? undefined : requireTimeout(timeoutMs, "timeoutMs");
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    // resolveOperationSpec 覆盖 test-only 动态注册的操作；request() 的静态类型
    // 已约束 operation 为已知 key，缺失即内部不变量被破坏。
    const resolvedSpec = resolveOperationSpec(operation);
    if (!resolvedSpec) {
      return Promise.reject(new Error(`Unknown Runtime Host operation: ${operation}`));
    }
    const spec = resolvedSpec as OperationSpec<
      OperationInput<K>,
      OperationOutput<K>,
      HostOperationErrorCode
    >;
    let canonicalInput: OperationInput<K>;
    try {
      canonicalInput = spec.decodeInput(input);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    const requestId = randomUUID();
    const isDomainRequest = operation !== "host.status";
    const result = new Promise<Result>((resolve, reject) => {
      const timer =
        boundedTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const error = requestTimeoutError(operation);
              if (timeoutScope === "connection") this.#fail(error);
              else this.#retireRequest(requestId, error);
            }, boundedTimeoutMs);
      this.#pendingRequests.set(requestId, {
        operation,
        accept: (value) => {
          const output = value as OperationOutput<K>;
          spec.assertOutputForInput?.(canonicalInput, output);
          return accept(output);
        },
        resolve: (value) => resolve(value as Result),
        reject,
        ...(isDomainRequest ? { domainState: "queued" as const } : {}),
        timer,
      });
      this.#scheduleLivenessCheck();
    });
    const frame = {
      requestId,
      operation,
      input: canonicalInput,
    } as RequestFrame;
    if (isDomainRequest) {
      this.#queuedDomainFrames.push({ requestId, frame });
      this.#drainDomainRequests();
    } else {
      void this.#transport.write(frame).catch((error: unknown) => this.#fail(asError(error)));
    }
    return result;
  }

  #drainDomainRequests(): void {
    while (
      !this.#terminalError &&
      this.#inFlightDomainRequests < RUNTIME_HOST_MAX_IN_FLIGHT_DOMAIN_REQUESTS
    ) {
      const queued = this.#queuedDomainFrames.shift();
      if (!queued) return;
      const pending = this.#pendingRequests.get(queued.requestId);
      if (!pending || pending.domainState !== "queued") continue;
      pending.domainState = "in_flight";
      this.#inFlightDomainRequests += 1;
      void this.#transport
        .write(queued.frame)
        .catch((error: unknown) => this.#fail(asError(error)));
    }
  }

  async status(timeoutMs?: number): Promise<HostStatusResult> {
    const status = await this.request("host.status", {}, timeoutMs);
    if (status.hostEpoch !== this.hostEpoch) {
      const error = new Error("Runtime Host returned status for a different Host Epoch");
      this.#fail(error);
      throw error;
    }
    return status;
  }

  queryHostDiagnostics(timeoutMs?: number): Promise<HostDiagnosticsResult> {
    return this.request("host.diagnostics.query", {}, timeoutMs);
  }

  setEventListener(listener: ((event: Record<string, unknown>) => void) | undefined): void {
    this.#eventListener = listener;
  }

  get inFlightDomainRequestCount(): number {
    return this.#inFlightDomainRequests;
  }

  get retiredRequestCount(): number {
    return this.#retiredRequests.size;
  }

  /** Test observability: the terminal failure (undefined while healthy). */
  get terminalError(): Error | undefined {
    return this.#terminalError;
  }

  async close(): Promise<void> {
    this.#transport.destroy();
    await this.#transport.closed;
  }

  async #readResponses(): Promise<void> {
    try {
      while (true) {
        const frame = decodeHostFrame(await this.#transport.read(0));
        this.#resetLivenessCheck();
        if ("kind" in frame) {
          if (frame.kind === "event") {
            // Host-initiated push: opaque payload, no requestId, listener-side
            // domain validation. Delivered synchronously in wire order so the
            // caller observes events interleaved with responses exactly as sent.
            this.#eventListener?.(frame.event);
            continue;
          }
          // Remaining kinds are handshake frames; after acceptance they mean
          // the Host violated the frame order.
          throw new Error("Runtime Host returned a handshake frame after acceptance");
        }
        this.#acceptResponse(frame);
      }
    } catch (error) {
      this.#fail(asError(error));
    }
  }

  #acceptResponse(frame: ResponseFrame): void {
    const pending = this.#pendingRequests.get(frame.requestId);
    if (!pending) {
      const retired = this.#retiredRequests.get(frame.requestId);
      if (retired?.operation === frame.operation) {
        this.#retiredRequests.delete(frame.requestId);
        if (retired.slotTimer) clearTimeout(retired.slotTimer);
        if (retired.entryTimer) clearTimeout(retired.entryTimer);
        // 槽位 TTL 可能已强制释放过 in-flight 槽位；仅在未释放时才释放，否则计数下溢。
        if (!retired.slotReleased) this.#releaseDomainSlot(retired);
        this.#scheduleLivenessCheck();
        return;
      }
      this.#fail(new Error("Runtime Host returned an unmatched operation response"));
      return;
    }
    if (pending.operation !== frame.operation) {
      this.#fail(new Error("Runtime Host returned an unmatched operation response"));
      return;
    }
    this.#pendingRequests.delete(frame.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    this.#scheduleLivenessCheck();
    if (frame.ok) {
      try {
        const accepted = pending.accept(frame.result);
        this.#releaseDomainSlot(pending);
        pending.resolve(accepted);
      } catch (error) {
        const failure = asError(error);
        pending.reject(failure);
        this.#fail(failure);
      }
      return;
    }
    this.#releaseDomainSlot(pending);
    pending.reject(
      new RuntimeHostOperationError(frame.operation, frame.error.code, frame.error.message),
    );
  }

  #retireRequest(requestId: string, error: Error): void {
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) return;
    this.#pendingRequests.delete(requestId);
    if (pending.domainState === "queued") {
      const index = this.#queuedDomainFrames.findIndex((queued) => queued.requestId === requestId);
      if (index !== -1) this.#queuedDomainFrames.splice(index, 1);
      pending.reject(error);
      this.#scheduleLivenessCheck();
      return;
    }
    const retired: RetiredRequest = {
      operation: pending.operation,
      ...(pending.domainState === "in_flight" ? { domainState: pending.domainState } : {}),
    };
    if (retired.domainState === "in_flight") {
      retired.slotTimer = setTimeout(
        () => this.#expireRetiredSlot(requestId),
        this.#retiredSlotTtlMs,
      );
      retired.slotTimer.unref?.();
    }
    retired.entryTimer = setTimeout(
      () => this.#removeRetiredEntry(requestId),
      this.#retiredEntryTtlMs,
    );
    retired.entryTimer.unref?.();
    this.#retiredRequests.set(requestId, retired);
    pending.reject(error);
    this.#scheduleLivenessCheck();
  }

  #removeRetiredEntry(requestId: string): void {
    const retired = this.#retiredRequests.get(requestId);
    if (!retired) return;
    if (retired.slotTimer) clearTimeout(retired.slotTimer);
    // 防御性：in-flight 槽位正常由更早的 slot TTL 释放；若尚未释放（防御隐式
    // 时序不变量被破坏的场景），在此释放，避免槽位被永久钉死导致域通道 wedge。
    if (!retired.slotReleased) this.#releaseDomainSlot(retired);
    // 条目绝对 TTL 到期删除；此后迟到响应按 unmatched 处理。5min 迟到的响应
    // 对账价值已低于连接健康信号，且删除条目能终止 #hasOutstandingDomainRequest
    // 因 retiredRequests 非空而产生的永久 liveness 探测。
    this.#retiredRequests.delete(requestId);
    this.#scheduleLivenessCheck();
  }

  #expireRetiredSlot(requestId: string): void {
    const retired = this.#retiredRequests.get(requestId);
    if (!retired || retired.slotReleased) return;
    retired.slotTimer = undefined;
    // 强制释放被占用的 in-flight 槽位；条目保留，使真正迟到的响应仍能被对账，
    // 而不是被当作 unmatched 而 fail 连接。
    this.#releaseDomainSlot(retired);
    retired.slotReleased = true;
  }

  #releaseDomainSlot(request: PendingRequest | RetiredRequest): void {
    if (request.domainState !== "in_flight") return;
    request.domainState = undefined;
    this.#inFlightDomainRequests -= 1;
    this.#drainDomainRequests();
  }

  #resetLivenessCheck(): void {
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#livenessTimer = undefined;
    this.#scheduleLivenessCheck();
  }

  #scheduleLivenessCheck(): void {
    if (
      this.#terminalError ||
      this.#livenessTimer ||
      this.#livenessProbePending ||
      !this.#hasOutstandingDomainRequest()
    ) {
      if (!this.#hasOutstandingDomainRequest() && this.#livenessTimer) {
        clearTimeout(this.#livenessTimer);
        this.#livenessTimer = undefined;
      }
      return;
    }
    this.#livenessTimer = setTimeout(() => {
      this.#livenessTimer = undefined;
      this.#startLivenessProbe();
    }, this.#livenessIntervalMs);
  }

  #hasOutstandingDomainRequest(): boolean {
    if (this.#retiredRequests.size > 0) return true;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.operation !== "host.status") return true;
    }
    return false;
  }

  #startLivenessProbe(): void {
    if (this.#terminalError || this.#livenessProbePending || !this.#hasOutstandingDomainRequest()) {
      return;
    }
    this.#livenessProbePending = true;
    void this.#requestOperation(
      "host.status",
      {},
      DEFAULT_LIVENESS_TIMEOUT_MS,
      (status) => {
        if (status.hostEpoch !== this.hostEpoch) {
          throw new Error("Runtime Host returned status for a different Host Epoch");
        }
        try {
          this.#onLivenessProbe?.();
        } catch {
          // Diagnostics hook: an observer exception must never fail the
          // connection it is watching.
        }
      },
      "connection",
    )
      .catch((error: unknown) => this.#fail(asError(error)))
      .finally(() => {
        this.#livenessProbePending = false;
        this.#scheduleLivenessCheck();
      });
  }

  #fail(error: Error): void {
    if (this.#terminalError) return;
    this.#terminalError = error;
    if (this.#livenessTimer) clearTimeout(this.#livenessTimer);
    this.#livenessTimer = undefined;
    this.#queuedDomainFrames.length = 0;
    this.#inFlightDomainRequests = 0;
    for (const pending of this.#pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingRequests.clear();
    for (const retired of this.#retiredRequests.values()) {
      if (retired.slotTimer) clearTimeout(retired.slotTimer);
      if (retired.entryTimer) clearTimeout(retired.entryTimer);
    }
    this.#retiredRequests.clear();
    this.#transport.destroy();
  }
}

export async function connectRuntimeHost(
  input: ConnectRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  const normalized = normalizeConnectRuntimeHostInput(input);
  const capability = await resolveStorageRoot({
    path: input.rootPath,
    kind: "interactive",
  });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  return finalizeConnectRuntimeHostResult(
    await connectResolvedRuntimeHost({
      ...input,
      ...normalized,
      capability,
      controlDirectory,
    }),
  );
}

/** Connects only through an already published Host control plane and performs no filesystem writes. */
export async function connectExistingRuntimeHost(
  input: ConnectRuntimeHostInput,
): Promise<ConnectRuntimeHostResult> {
  const normalized = normalizeConnectRuntimeHostInput(input);
  const discovered = await discoverMarkedStorageRoot({ path: input.rootPath });
  if (discovered.kind !== "interactive") {
    return { kind: "unavailable", reason: "root_mismatch" };
  }
  const capability = discovered;
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(capability);
  return finalizeConnectRuntimeHostResult(
    await connectResolvedRuntimeHost({
      ...input,
      ...normalized,
      capability,
      controlDirectory,
    }),
  );
}

function normalizeConnectRuntimeHostInput(input: ConnectRuntimeHostInput): {
  clientInstanceId: string;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
} {
  validateProtocolRange(input.protocol);
  return {
    clientInstanceId: requireClientInstanceId(input.clientInstanceId ?? randomUUID()),
    connectTimeoutMs: requireTimeout(
      input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    ),
    handshakeTimeoutMs: requireTimeout(
      input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      "handshakeTimeoutMs",
    ),
  };
}

function finalizeConnectRuntimeHostResult(
  result: ConnectResolvedRuntimeHostResult,
): ConnectRuntimeHostResult {
  if (result.kind === "election_deadline_elapsed") {
    return {
      kind: "unavailable",
      reason: result.endpointConnected ? "handshake_failed" : "connect_failed",
    };
  }
  return result;
}

export async function connectResolvedRuntimeHost(
  input: ConnectResolvedRuntimeHostInput,
): Promise<ConnectResolvedRuntimeHostResult> {
  validateProtocolRange(input.protocol);
  requireClientInstanceId(input.clientInstanceId);
  const connectTimeoutMs = requireTimeout(
    input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    "connectTimeoutMs",
  );
  const handshakeTimeoutMs = requireTimeout(
    input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    "handshakeTimeoutMs",
  );
  const livenessIntervalMs = requireTimeout(
    input.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS,
    "livenessIntervalMs",
  );
  // Retired TTL 默认值（30s / 5min）超出 requireTimeout 的 120s 上限，
  // 用更宽的 TTL 区间校验，否则默认路径直接 RangeError。
  const retiredSlotTtlMs = requireTtl(
    input.retiredSlotTtlMs ?? RETIRED_SLOT_TTL_MS,
    "retiredSlotTtlMs",
  );
  const retiredEntryTtlMs = requireTtl(
    input.retiredEntryTtlMs ?? RETIRED_ENTRY_TTL_MS,
    "retiredEntryTtlMs",
  );
  let registration: HostRegistration | undefined;
  try {
    registration = await readRegistrationBeforeDeadline(
      input.controlDirectory,
      input.electionDeadline,
    );
  } catch (error) {
    if (error instanceof ElectionDeadlineElapsedError) {
      return { kind: "election_deadline_elapsed", endpointConnected: false };
    }
    if (error instanceof RuntimeHostRegistrationError && error.code === "invalid_registration") {
      return { kind: "unavailable", reason: "invalid_registration" };
    }
    return { kind: "unavailable", reason: "connect_failed" };
  }
  if (!registration) return { kind: "unavailable", reason: "not_registered" };
  if (registration.rootId !== input.capability.rootId) {
    return { kind: "unavailable", reason: "root_mismatch", registration };
  }

  const connectDeadline = phaseDeadline(connectTimeoutMs, input.electionDeadline);
  const connectBudget = remainingTimeout(connectDeadline.at);
  if (connectBudget === undefined) {
    if (connectDeadline.exhaustsElection) {
      return { kind: "election_deadline_elapsed", endpointConnected: false };
    }
    return { kind: "unavailable", reason: "connect_failed", registration };
  }
  let transport: FramedTransport;
  try {
    transport = await openTransport(
      registration.endpoint,
      connectBudget,
      connectDeadline.exhaustsElection,
    );
  } catch (error) {
    if (error instanceof ElectionDeadlineElapsedError) {
      return { kind: "election_deadline_elapsed", endpointConnected: false };
    }
    return { kind: "unavailable", reason: "connect_failed", registration };
  }
  const handshakeDeadline = phaseDeadline(handshakeTimeoutMs, input.electionDeadline);
  const handshakeBudget = remainingTimeout(handshakeDeadline.at);
  if (handshakeBudget === undefined) {
    transport.destroy();
    if (handshakeDeadline.exhaustsElection) {
      return { kind: "election_deadline_elapsed", endpointConnected: true };
    }
    return { kind: "unavailable", reason: "handshake_failed", registration };
  }
  let handshakeTimeoutError: Error | undefined;
  const handshakeTimer = setTimeout(() => {
    handshakeTimeoutError = handshakeDeadline.exhaustsElection
      ? new ElectionDeadlineElapsedError()
      : new Error("Timed out handshaking with Runtime Host");
    transport.destroy(handshakeTimeoutError);
  }, handshakeBudget);
  try {
    const staleCompatibility = registration.compatibilityEpoch !== RUNTIME_HOST_COMPATIBILITY_EPOCH;
    const helloProtocol = staleCompatibility
      ? {
          min: Math.min(Number.MAX_SAFE_INTEGER, registration.protocolMax + 1),
          max: Math.min(Number.MAX_SAFE_INTEGER, registration.protocolMax + 1),
        }
      : input.protocol;
    await transport.write({
      kind: "hello",
      clientInstanceId: input.clientInstanceId,
      surface: input.surface,
      protocolMin: helloProtocol.min,
      protocolMax: helloProtocol.max,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    });
    if (remainingTimeout(handshakeDeadline.at) === undefined) {
      throw handshakeDeadline.exhaustsElection
        ? new ElectionDeadlineElapsedError()
        : new Error("Runtime Host handshake deadline elapsed");
    }
    // The phase timer owns the full hello write/read deadline and its timeout classification.
    const handshake = decodeHostFrame(await transport.read(0));
    if (!("kind" in handshake))
      throw new Error("Runtime Host returned an operation response before handshake");
    if (
      handshake.kind !== "accepted" &&
      handshake.kind !== "incompatible" &&
      handshake.kind !== "draining"
    ) {
      throw new Error("Runtime Host returned a non-handshake frame before acceptance");
    }
    if (handshake.hostEpoch !== registration.hostEpoch) {
      transport.destroy();
      return { kind: "unavailable", reason: "epoch_mismatch", registration };
    }
    if (handshake.kind === "accepted") {
      if (staleCompatibility || handshake.compatibilityEpoch !== RUNTIME_HOST_COMPATIBILITY_EPOCH) {
        throw new Error("Runtime Host accepted an incompatible schema epoch");
      }
      if (
        handshake.selectedProtocol < input.protocol.min ||
        handshake.selectedProtocol > input.protocol.max ||
        handshake.selectedProtocol < registration.protocolMin ||
        handshake.selectedProtocol > registration.protocolMax
      ) {
        throw new Error("Runtime Host selected a protocol outside the negotiated range");
      }
      return {
        kind: "connected",
        registration,
        connection: new RuntimeHostConnectionImpl(transport, handshake, {
          livenessIntervalMs,
          retiredSlotTtlMs,
          retiredEntryTtlMs,
          onLivenessProbe: input.onLivenessProbe,
        }),
      };
    }
    transport.destroy();
    if (handshake.kind === "incompatible") return { kind: "incompatible", handshake, registration };
    return { kind: "draining", registration };
  } catch (error) {
    transport.destroy();
    const failure = handshakeTimeoutError ?? error;
    if (failure instanceof ElectionDeadlineElapsedError) {
      return { kind: "election_deadline_elapsed", endpointConnected: true };
    }
    return { kind: "unavailable", reason: "handshake_failed", registration };
  } finally {
    clearTimeout(handshakeTimer);
  }
}

function openTransport(
  path: string,
  timeoutMs: number,
  exhaustsElection: boolean,
): Promise<FramedTransport> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        exhaustsElection
          ? new ElectionDeadlineElapsedError()
          : new Error("Timed out connecting to Runtime Host"),
      );
    }, timeoutMs);
    const onConnect = () => {
      const transport = new FramedTransport(socket);
      cleanup();
      resolve(transport);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function requireTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${label} must be an integer between 1 and 120000`);
  }
  return value;
}

/** Retired-request TTL 区间：条目 TTL 默认 5min，宽于握手类超时的 120s 上限。 */
function requireTtl(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) {
    throw new RangeError(`${label} must be an integer between 1 and 600000`);
  }
  return value;
}

interface PhaseDeadline {
  at: number;
  exhaustsElection: boolean;
}

function phaseDeadline(timeoutMs: number, outerDeadline: number | undefined): PhaseDeadline {
  const phaseTimeout = performance.now() + timeoutMs;
  if (outerDeadline !== undefined && outerDeadline <= phaseTimeout) {
    return { at: outerDeadline, exhaustsElection: true };
  }
  return { at: phaseTimeout, exhaustsElection: false };
}

function remainingTimeout(deadline: number): number | undefined {
  const remaining = deadline - performance.now();
  return remaining <= 0 ? undefined : Math.max(1, Math.ceil(remaining));
}

function readRegistrationBeforeDeadline(
  controlDirectory: string,
  deadline: number | undefined,
): Promise<HostRegistration | undefined> {
  if (deadline === undefined) return readHostRegistration(controlDirectory);
  const remaining = remainingTimeout(deadline);
  if (remaining === undefined) {
    return Promise.reject(new ElectionDeadlineElapsedError());
  }
  const operation = readHostRegistration(controlDirectory);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ElectionDeadlineElapsedError()), remaining);
    operation.then(
      (registration) => {
        clearTimeout(timer);
        resolve(registration);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requestTimeoutError(operation: OperationKey): RuntimeHostTransportError {
  return new RuntimeHostTransportError(
    "read_timeout",
    `Timed out waiting for Runtime Host ${operation} response`,
  );
}
