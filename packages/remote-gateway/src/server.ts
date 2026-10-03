import { createServer, type Server } from "node:https";
import type { ServerResponse, IncomingMessage } from "node:http";
import { createSecureContext } from "node:tls";
import { X509Certificate, createHash, randomUUID, createPrivateKey } from "node:crypto";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { scheduleUnrefDeadline } from "@pico/runtime/deadline";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import {
  parseRuntimeResult,
  MODEL_CATALOG_RUNTIME_CAPABILITY,
  REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY,
  MEMORY_PAGINATION_RUNTIME_CAPABILITY,
  type RuntimeParams,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  REMOTE_DEFAULT_PERMISSIONS,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_METHODS,
  REMOTE_METHOD_SPECS,
  REMOTE_PERMISSIONS,
  parseRemoteRequest,
  type RemotePermission,
  type RemoteCapabilities,
  type RemoteServerMessage,
} from "@pico/protocol/remote";
import { acquireGatewayLock, requestGatewayControl, startControlServer } from "./control.js";
import { GatewayError, safeGatewayError } from "./errors.js";
import { GatewayPairings, type PairingConfirmation } from "./pairing.js";
import {
  authorizeRuntimeRequest,
  publicEndpoint,
  requirePermission,
  resolveDeviceWorkspace,
  SESSION_CLEANUP_METHODS,
  type GatewayRuntimeClient,
} from "./policy.js";
import {
  defaultGatewayHome,
  ensureGatewayHome,
  loadGatewayConfig,
  loadGatewayState,
  readTlsFile,
  secretMatches,
  validateGatewayConfig,
  writePrivateJson,
  type GatewayConfig,
  type GatewayDevice,
  type GatewayState,
} from "./state.js";

export interface RemoteGatewayOptions {
  readonly home?: string;
  /** Trusted host adapter. Test doubles never alter TLS verification in client code. */
  readonly createRuntimeClient?: (deviceId: string) => GatewayRuntimeClient;
  readonly now?: () => number;
  readonly audit?: (entry: GatewayAuditEntry) => void;
}
export interface GatewayAuditEntry {
  readonly deviceId?: string;
  readonly method: string;
  readonly workspaceId?: string;
  readonly at: number;
  readonly result: string;
  readonly durationMs: number;
}
interface DeviceConnection {
  readonly client: GatewayRuntimeClient;
  readonly sessionSubscriptions: Map<string, { workspaceId: string; sessionId: string }>;
  readonly pendingSessionOpens: Map<string, number>;
  readonly pendingFrames: RuntimeSessionSubscriptionFrame[];
  pendingFrameBytes: number;
  socket?: WebSocket;
  frameDispose?: () => void;
  readonly eventSubscriptions: Map<string, () => void>;
  requests: number;
  lastSeenPersisted: number;
  readonly downloads: Set<ServerResponse>;
}
interface RateBucket {
  tokens: number;
  updated: number;
}
export class RemoteGateway {
  readonly home: string;
  readonly config: GatewayConfig;
  readonly state: GatewayState;
  private readonly servers: Server[] = [];
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_MAX_FRAME_BYTES,
  });
  private readonly connections = new Map<string, DeviceConnection>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly pairings: GatewayPairings;
  private readonly now: () => number;
  private control?: Awaited<ReturnType<typeof startControlServer>>;
  private releaseLock?: () => Promise<void>;
  private persistenceTail = Promise.resolve();
  private lastError?: string;
  private closing = false;
  private startedAt = 0;
  private runtimeLastReachableAt?: number;
  private runtimeLastFailure?: string;
  private sweep?: NodeJS.Timeout;
  private constructor(
    config: GatewayConfig,
    home: string,
    state: GatewayState,
    private readonly options: RemoteGatewayOptions,
  ) {
    this.config = config;
    this.home = home;
    this.state = state;
    this.now = options.now ?? Date.now;
    this.pairings = new GatewayPairings(
      config,
      state,
      (confirmation) => this.persist(confirmation),
      this.now,
    );
  }
  static async create(
    config: GatewayConfig,
    options: RemoteGatewayOptions = {},
  ): Promise<RemoteGateway> {
    const home = await ensureGatewayHome(options.home ?? defaultGatewayHome());
    return new RemoteGateway(
      validateGatewayConfig(config),
      home,
      await loadGatewayState(home),
      options,
    );
  }
  async start(): Promise<void> {
    if (this.startedAt || this.closing) throw new Error("网关已启动或关闭");
    this.releaseLock = await acquireGatewayLock(this.home);
    try {
      const [cert, key] = await Promise.all([
        readTlsFile(this.config.certificatePath),
        readTlsFile(this.config.privateKeyPath),
      ]);
      validateCertificate(this.config, cert, key, this.now());
      for (const host of this.config.listenHosts) {
        const server = createServer(
          {
            cert,
            key,
            minVersion: "TLSv1.2",
            maxHeaderSize: 16 * 1024,
            requestTimeout: 30_000,
            headersTimeout: 10_000,
          },
          (request, response) => {
            void this.handleHttp(request, response);
          },
        );
        server.on("upgrade", (request, socket, head) => {
          try {
            if (request.url !== "/v1/events" || this.closing)
              throw new GatewayError("NOT_FOUND", "接口不存在", 404);
            const device = this.authenticate(request);
            this.rate(`ws:${device.id}`, 10, 60_000);
            this.webSockets.handleUpgrade(request, socket, head, (ws) => {
              void this.openSocket(device, ws);
            });
          } catch (error) {
            const safe = safeGatewayError(error);
            socket.end(
              `HTTP/1.1 ${safe.status} ${safe.status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            );
          }
        });
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port: this.config.port, ipv6Only: host.includes(":") }, () => {
            server.off("error", reject);
            server.on("error", () => {
              this.lastError = "HTTPS 监听异常";
            });
            resolve();
          });
        });
      }
      const bootstrap =
        this.options.createRuntimeClient?.("bootstrap") ??
        new LocalRuntimeClient({
          ...(this.config.runtimeHostRootPath
            ? { runtimeHostRootPath: this.config.runtimeHostRootPath }
            : {}),
          surface: "inspect",
        });
      try {
        parseRuntimeResult("runtime.ping", await bootstrap.request("runtime.ping", {}));
        this.runtimeLastReachableAt = this.now();
      } catch (error) {
        this.runtimeLastFailure = safeGatewayError(error).code;
        throw new GatewayError(
          "RUNTIME_UNAVAILABLE",
          "无法连接或启动本机 Pico Runtime；请在电脑检查诊断",
          503,
          true,
        );
      } finally {
        bootstrap.close();
      }
      this.control = await startControlServer(this.home, (method, params) =>
        this.manage(method, params),
      );
      this.startedAt = this.now();
      this.sweep = setInterval(() => {
        this.pairings.pending();
        this.sweepRateBuckets();
      }, 10_000);
      this.sweep.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.sweep) clearInterval(this.sweep);
    this.pairings.clear();
    for (const [id] of this.connections) this.closeDevice(id);
    this.webSockets.close();
    for (const server of this.servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.control?.close();
    await this.persistenceTail;
    await this.releaseLock?.();
  }
  async manage(method: string, input: unknown): Promise<unknown> {
    const params =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    switch (method) {
      case "status":
        return this.status();
      case "doctor":
        return this.doctor();
      case "pair.offer":
        return this.pairings.offer();
      case "pair.pending":
        return this.pairings.pending();
      case "pair.approve": {
        const grant = this.validateGrant(params);
        const device = await this.pairings.approve(
          String(params["pairingId"]),
          grant.permissions,
          grant.workspaceIds,
        );
        return publicDevice(device);
      }
      case "pair.reject":
        this.pairings.reject(String(params["pairingId"]));
        return { rejected: true };
      case "devices.list":
        return { devices: this.state.devices.map(publicDevice) };
      case "devices.grant": {
        const device = this.state.devices.find(
          (candidate) => candidate.id === params["deviceId"] && !candidate.revokedAt,
        );
        if (!device) throw new GatewayError("NOT_FOUND", "设备不存在", 404);
        const grant = this.validateGrant(params);
        const next = { ...device, ...grant };
        this.state.devices.splice(this.state.devices.indexOf(device), 1, next);
        try {
          await this.persist();
        } catch (error) {
          this.state.devices.splice(this.state.devices.indexOf(next), 1, device);
          throw error;
        }
        // Close all subscriptions when scopes change; next request must re-evaluate authorization.
        this.closeDevice(device.id);
        return publicDevice(next);
      }
      case "devices.revoke": {
        const device = this.state.devices.find((candidate) => candidate.id === params["deviceId"]);
        if (!device) throw new GatewayError("NOT_FOUND", "设备不存在", 404);
        await this.revoke(device);
        return { revoked: true };
      }
      default:
        throw new GatewayError("METHOD_NOT_FOUND", "本机管理方法不存在", 404);
    }
  }
  private validateGrant(params: Record<string, unknown>): {
    permissions: RemotePermission[];
    workspaceIds: string[];
  } {
    const permissions = params["permissions"] ?? REMOTE_DEFAULT_PERMISSIONS;
    const workspaceIds =
      params["workspaceIds"] ?? this.config.workspaces.map((workspace) => workspace.id);
    if (
      !Array.isArray(permissions) ||
      !permissions.every((permission: unknown) =>
        REMOTE_PERMISSIONS.includes(permission as RemotePermission),
      ) ||
      !Array.isArray(workspaceIds) ||
      !workspaceIds.every(
        (id: unknown) =>
          typeof id === "string" && this.config.workspaces.some((workspace) => workspace.id === id),
      )
    )
      throw new GatewayError("INVALID_PARAMS", "设备授权无效");
    return {
      permissions: [...new Set(permissions)] as RemotePermission[],
      workspaceIds: [...new Set(workspaceIds)] as string[],
    };
  }
  private authenticate(request: IncomingMessage): GatewayDevice {
    const token = bearer(request);
    const device = this.state.devices.find(
      (candidate) =>
        !candidate.revokedAt &&
        candidate.pairedAt !== undefined &&
        secretMatches(token, candidate.tokenHash),
    );
    if (!device) throw new GatewayError("DEVICE_REVOKED", "设备未授权或已撤销，请重新配对", 401);
    device.lastConnectedAt = this.now();
    return device;
  }
  private connection(device: GatewayDevice): DeviceConnection {
    let connection = this.connections.get(device.id);
    if (!connection) {
      const client =
        this.options.createRuntimeClient?.(device.id) ??
        new LocalRuntimeClient({
          ...(this.config.runtimeHostRootPath
            ? { runtimeHostRootPath: this.config.runtimeHostRootPath }
            : {}),
          terminalOwnerId: `remote:${device.id}`,
          surface: "inspect",
        });
      connection = {
        client,
        sessionSubscriptions: new Map(),
        pendingSessionOpens: new Map(),
        pendingFrames: [],
        pendingFrameBytes: 0,
        eventSubscriptions: new Map(),
        requests: 0,
        lastSeenPersisted: 0,
        downloads: new Set(),
      };
      this.connections.set(device.id, connection);
    }
    if (this.now() - connection.lastSeenPersisted > 60_000) {
      connection.lastSeenPersisted = this.now();
      void this.persist().catch(() => {
        this.lastError = "设备状态持久化失败";
      });
    }
    return connection;
  }
  private closeDevice(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    connection.socket?.close(4001, "设备授权已撤销或更改");
    const closingSocket = connection.socket;
    if (closingSocket) {
      const timeout = scheduleUnrefDeadline(() => closingSocket.terminate(), 1000);
      closingSocket.once("close", () => timeout.cancel());
    }
    connection.frameDispose?.();
    for (const dispose of connection.eventSubscriptions.values()) dispose();
    for (const response of connection.downloads) response.destroy();
    connection.client.close();
    this.connections.delete(deviceId);
  }
  private async revoke(device: GatewayDevice): Promise<void> {
    device.revokedAt = this.now();
    this.closeDevice(device.id);
    await this.persist();
  }
  private persist(confirmation?: PairingConfirmation): Promise<void> {
    const next = this.persistenceTail.then(async () => {
      const snapshot = confirmation
        ? {
            ...this.state,
            devices: this.state.devices.map((device) =>
              device.id === confirmation.deviceId
                ? { ...device, pairedAt: confirmation.pairedAt }
                : device,
            ),
          }
        : this.state;
      await writePrivateJson(join(this.home, "devices.json"), snapshot);
      if (confirmation) {
        const device = this.state.devices.find((item) => item.id === confirmation.deviceId);
        if (device) device.pairedAt = confirmation.pairedAt;
      }
    });
    this.persistenceTail = next.catch(() => undefined);
    return next;
  }
  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = this.now();
    let device: GatewayDevice | undefined;
    let method = `${request.method ?? "?"} HTTP`;
    let workspaceId: string | undefined;
    let requestId = "";
    let dispatched = false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      if (this.closing) throw new GatewayError("RUNTIME_UNAVAILABLE", "网关正在关闭", 503, true);
      const url = new URL(request.url ?? "/", "https://gateway.invalid");
      if (url.search) throw new GatewayError("INVALID_PARAMS", "接口不接收 URL 参数");
      this.rate(`ip:${request.socket.remoteAddress ?? "unknown"}`, 120, 60_000);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, { version: 1, gatewayId: this.state.gatewayId, status: "ok" });
        return;
      }
      if (url.pathname.startsWith("/v1/pairings")) {
        this.rate(`pair:${request.socket.remoteAddress ?? "unknown"}`, 60, 60_000);
        if (request.method === "POST" && url.pathname === "/v1/pairings") {
          this.rate(`pair-submit:${request.socket.remoteAddress ?? "unknown"}`, 5, 60_000);
          json(response, 201, this.pairings.submit(await body(request)));
          return;
        }
        const claim = /^\/v1\/pairings\/([a-zA-Z0-9-]+)(\/ack)?$/.exec(url.pathname);
        if (claim?.[1] && request.method === "GET" && !claim[2]) {
          json(response, 200, this.pairings.claim(claim[1], bearer(request)));
          return;
        }
        if (claim?.[1] && request.method === "POST" && claim[2]) {
          json(response, 200, await this.pairings.acknowledge(claim[1], bearer(request)));
          return;
        }
        throw new GatewayError("NOT_FOUND", "配对接口不存在", 404);
      }
      device = this.authenticate(request);
      this.rate(`device:${device.id}`, 300, 60_000);
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        json(response, 200, await this.capabilities(device));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/workspaces") {
        requirePermission(device, "workspace.read");
        json(response, 200, {
          workspaces: this.config.workspaces
            .filter((workspace) => device?.workspaceIds.includes(workspace.id))
            .map((workspace) => ({ id: workspace.id, label: workspace.name })),
        });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/device") {
        await this.revoke(device);
        json(response, 200, { revoked: true });
        return;
      }
      const connection = this.connection(device);
      if (connection.requests >= 16)
        throw new GatewayError("RATE_LIMITED", "并发请求过多", 429, true);
      connection.requests++;
      try {
        if (request.method === "POST" && url.pathname === "/v1/rpc") {
          const rpc = parseRemoteRequest(await body(request));
          requestId = rpc.requestId;
          method = rpc.method;
          workspaceId = rpc.workspaceId;
          const authorized = await authorizeRuntimeRequest(
            this.config,
            device,
            connection.client,
            rpc,
          );
          if (rpc.method === "catalog.models" && !(await this.supportsModelCatalog(device)))
            throw new GatewayError(
              "METHOD_NOT_FOUND",
              "电脑尚未支持模型目录，请更新并重启 Pico",
              404,
            );
          const params = authorized.params as Record<string, unknown>;
          if (
            (rpc.method === "changes.review" && params.idempotencyKey) ||
            (rpc.method === "memory.list" && params.paged)
          ) {
            const required =
              rpc.method === "changes.review"
                ? REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY
                : MEMORY_PAGINATION_RUNTIME_CAPABILITY;
            if (!(await this.runtimeCapabilities(device)).has(required))
              throw new GatewayError(
                "METHOD_NOT_FOUND",
                "电脑尚未支持此操作的可靠恢复，请更新并重启 Pico",
                404,
              );
          }
          if (
            rpc.method === "session.subscription.open" &&
            connection.sessionSubscriptions.size >= 16
          )
            throw new GatewayError("RATE_LIMITED", "会话订阅过多", 429);
          if (rpc.method === "session.subscription.close") {
            const owned = connection.sessionSubscriptions.get(String(params["subscriptionId"]));
            if (
              !owned ||
              owned.workspaceId !== rpc.workspaceId ||
              owned.sessionId !== params["sessionId"]
            )
              throw new GatewayError("FORBIDDEN", "会话订阅不属于此设备", 403);
          }
          const openingSession =
            rpc.method === "session.subscription.open" ? String(params["sessionId"]) : undefined;
          if (openingSession)
            connection.pendingSessionOpens.set(
              openingSession,
              (connection.pendingSessionOpens.get(openingSession) ?? 0) + 1,
            );
          dispatched = true;
          let value: unknown;
          try {
            value = projectRemoteResult(
              rpc.method,
              parseRuntimeResult(
                rpc.method,
                await connection.client.request(rpc.method, authorized.params),
              ),
            );
          } finally {
            if (openingSession) {
              const left = (connection.pendingSessionOpens.get(openingSession) ?? 1) - 1;
              if (left) connection.pendingSessionOpens.set(openingSession, left);
              else connection.pendingSessionOpens.delete(openingSession);
            }
          }
          this.runtimeLastReachableAt = this.now();
          this.runtimeLastFailure = undefined;
          if (device.revokedAt)
            throw new GatewayError("DEVICE_REVOKED", "设备已撤销", 401, false, "unknown");
          if (
            rpc.method === "session.subscription.open" &&
            rpc.workspaceId &&
            value &&
            typeof value === "object" &&
            "subscriptionId" in value &&
            typeof value.subscriptionId === "string"
          )
            connection.sessionSubscriptions.set(value.subscriptionId, {
              workspaceId: rpc.workspaceId,
              sessionId: String(params["sessionId"]),
            });
          if (rpc.method === "session.subscription.close")
            connection.sessionSubscriptions.delete(String(params["subscriptionId"]));
          json(response, 200, { requestId, ok: true, value });
          if (rpc.method === "session.subscription.open") {
            const frames = connection.pendingFrames.splice(0);
            connection.pendingFrameBytes = 0;
            for (const frame of frames) {
              const scope = connection.sessionSubscriptions.get(frame.subscriptionId);
              if (scope) this.sendSessionFrame(connection, scope.workspaceId, frame);
              else if (connection.pendingSessionOpens.has(frame.sessionId)) {
                connection.pendingFrames.push(frame);
                connection.pendingFrameBytes += Buffer.byteLength(JSON.stringify(frame));
              }
            }
          }
          this.audit(device, method, workspaceId, started, "OK");
          return;
        }
        const artifact =
          /^\/v1\/workspaces\/([^/]+)\/sessions\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(
            url.pathname,
          );
        if (request.method === "GET" && artifact?.[1] && artifact[2] && artifact[3]) {
          workspaceId = decodeURIComponent(artifact[1]);
          requirePermission(device, "workspace.read");
          const workspace = resolveDeviceWorkspace(this.config, device, workspaceId);
          await this.streamArtifact(
            device,
            connection,
            response,
            workspace.path,
            decodeURIComponent(artifact[2]),
            decodeURIComponent(artifact[3]),
          );
          return;
        }
        throw new GatewayError("NOT_FOUND", "接口不存在", 404);
      } finally {
        connection.requests--;
      }
    } catch (error) {
      const safe = safeGatewayError(error, dispatched);
      this.audit(device, method, workspaceId, started, safe.code);
      if (safe.status >= 500) this.lastError = safe.code;
      if (["RUNTIME_UNAVAILABLE", "RUNTIME_DISCONNECTED"].includes(safe.code))
        this.runtimeLastFailure = safe.code;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (safe.status === 429) response.setHeader("Retry-After", "5");
      json(
        response,
        safe.status,
        requestId
          ? {
              requestId,
              ok: false,
              error: {
                code: safe.code,
                message: safe.message,
                retryable: safe.retryable,
                outcome: safe.outcome,
              },
            }
          : {
              error: {
                code: safe.code,
                message: safe.message,
                retryable: safe.retryable,
                outcome: safe.outcome,
              },
            },
      );
    }
  }
  private audit(
    device: GatewayDevice | undefined,
    method: string,
    workspaceId: string | undefined,
    started: number,
    result: string,
  ): void {
    // Audit never contains request params, transcript or terminal content.
    try {
      this.options.audit?.({
        ...(device ? { deviceId: device.id } : {}),
        method,
        ...(workspaceId ? { workspaceId } : {}),
        at: started,
        result,
        durationMs: this.now() - started,
      });
    } catch {
      /* logging must not break dispatch */
    }
  }
  private async runtimeCapabilities(device: GatewayDevice): Promise<ReadonlySet<string>> {
    try {
      const ping = parseRuntimeResult(
        "runtime.ping",
        await this.connection(device).client.request("runtime.ping", {}),
      );
      return new Set(ping.capabilities);
    } catch {
      return new Set();
    }
  }
  private async supportsModelCatalog(device: GatewayDevice): Promise<boolean> {
    return (await this.runtimeCapabilities(device)).has(MODEL_CATALOG_RUNTIME_CAPABILITY);
  }

  private async capabilities(device: GatewayDevice): Promise<RemoteCapabilities> {
    const supported = await this.runtimeCapabilities(device);
    const modelCatalog = supported.has(MODEL_CATALOG_RUNTIME_CAPABILITY);
    const reviewIdempotency = supported.has(REVIEW_IDEMPOTENCY_RUNTIME_CAPABILITY);
    const memoryPagination = supported.has(MEMORY_PAGINATION_RUNTIME_CAPABILITY);
    let ownerIsolation = false;
    let cleanupIsolation = false;
    try {
      const capability = parseRuntimeResult(
        "terminal.ownershipCapabilities",
        await this.connection(device).client.request("terminal.ownershipCapabilities", {}),
      );
      ownerIsolation = capability.ownerIsolation === true;
      cleanupIsolation = capability.sessionCleanupIsolation === true;
    } catch {
      /* Older daemons must not expose methods with implicit terminal cleanup. */
    }
    let terminalAvailable = device.permissions.includes("terminal.control");
    let terminalReason = terminalAvailable ? undefined : "请在电脑授予终端权限";
    if (terminalAvailable) {
      terminalAvailable = ownerIsolation;
      if (!terminalAvailable) terminalReason = "电脑 Runtime 不支持终端设备隔离，请重启或更新 Pico";
    }
    return {
      version: 1,
      gatewayId: this.state.gatewayId,
      platform: process.platform,
      permissions: device.permissions,
      methods: REMOTE_METHODS.filter(
        (method) =>
          device.permissions.includes(REMOTE_METHOD_SPECS[method].permission) &&
          (method !== "catalog.models" || modelCatalog) &&
          (!SESSION_CLEANUP_METHODS.has(method) || cleanupIsolation) &&
          (!method.startsWith("terminal.") || terminalAvailable),
      ),
      maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
      features: {
        reviewIdempotency: {
          available: reviewIdempotency && device.permissions.includes("session.control"),
          ...(!reviewIdempotency
            ? { reason: "电脑尚未支持审阅请求恢复，请更新并重启 Pico" }
            : !device.permissions.includes("session.control")
              ? { reason: "请在电脑授予会话控制权限" }
              : {}),
        },
        memoryPagination: {
          available:
            memoryPagination &&
            device.permissions.includes(REMOTE_METHOD_SPECS["memory.list"].permission),
          ...(!memoryPagination
            ? { reason: "电脑尚未支持记忆分页，请更新并重启 Pico" }
            : !device.permissions.includes(REMOTE_METHOD_SPECS["memory.list"].permission)
              ? { reason: "请在电脑授予配置管理权限" }
              : {}),
        },
        modelCatalog: {
          available: modelCatalog && device.permissions.includes("workspace.read"),
          ...(!modelCatalog
            ? { reason: "电脑尚未支持模型目录，请更新并重启 Pico" }
            : !device.permissions.includes("workspace.read")
              ? { reason: "请在电脑授予项目读取权限" }
              : {}),
        },
        terminal: {
          available: terminalAvailable,
          ...(terminalReason ? { reason: terminalReason } : {}),
        },
        administration: {
          available: device.permissions.includes("host.admin"),
          ...(!device.permissions.includes("host.admin")
            ? { reason: "请在电脑授予配置管理权限" }
            : {}),
        },
        directConnection: { available: true },
        sessionCleanup: {
          available: cleanupIsolation,
          ...(!cleanupIsolation
            ? { reason: "电脑 Runtime 不支持远程会话清理隔离，请更新并在本机重启 Pico daemon" }
            : {}),
        },
        push: { available: false, reason: "首版仅在手机前台同步" },
      },
    };
  }
  private async openSocket(device: GatewayDevice, socket: WebSocket): Promise<void> {
    const connection = this.connection(device);
    connection.socket?.terminate();
    connection.frameDispose?.();
    for (const dispose of connection.eventSubscriptions.values()) dispose();
    connection.eventSubscriptions.clear();
    connection.socket = socket;
    const send = (message: RemoteServerMessage): void => {
      if (device.revokedAt || socket.readyState !== WebSocket.OPEN) return;
      const data = JSON.stringify(message);
      if (
        Buffer.byteLength(data) > REMOTE_MAX_FRAME_BYTES ||
        socket.bufferedAmount > 4 * REMOTE_MAX_FRAME_BYTES
      ) {
        socket.close(1009, "事件预算超限，请重新同步");
        return;
      }
      socket.send(data);
    };
    send({
      type: "ready",
      version: 1,
      gatewayId: this.state.gatewayId,
      connectionId: randomUUID(),
    });
    const frames = connection.client.subscribeSessionFrames(
      (frame: RuntimeSessionSubscriptionFrame) => {
        const owned = connection.sessionSubscriptions.get(frame.subscriptionId);
        if (!owned && connection.pendingSessionOpens.has(frame.sessionId)) {
          const size = Buffer.byteLength(JSON.stringify(frame));
          if (
            connection.pendingFrames.length >= 64 ||
            connection.pendingFrameBytes + size > REMOTE_MAX_FRAME_BYTES
          ) {
            connection.pendingFrames.length = 0;
            connection.pendingFrameBytes = 0;
            send({ type: "disconnected", reason: "会话建立期间事件超过预算，请重新同步" });
          } else {
            connection.pendingFrames.push(frame);
            connection.pendingFrameBytes += size;
          }
          return;
        }
        if (
          !owned ||
          owned.sessionId !== frame.sessionId ||
          !device.workspaceIds.includes(owned.workspaceId)
        )
          return;
        send({ type: "session_frame", workspaceId: owned.workspaceId, frame });
        if (frame.type === "subscription.closed")
          connection.sessionSubscriptions.delete(frame.subscriptionId);
      },
      () => send({ type: "disconnected", reason: "电脑 Runtime 连接中断，请重新同步会话" }),
    );
    connection.frameDispose = frames.dispose;
    let chain = Promise.resolve();
    let pendingMessages = 0;
    socket.on("message", (data: RawData, binary: boolean) => {
      if (++pendingMessages > 16) {
        socket.close(1008, "订阅请求过多");
        return;
      }
      chain = chain.then(async () => {
        let subscriptionId: string | undefined;
        try {
          if (binary) throw new GatewayError("INVALID_PARAMS", "事件请求必须为 JSON 文本");
          this.rate(`ws-message:${device.id}`, 60, 60_000);
          const parsed: unknown = JSON.parse(data.toString());
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new GatewayError("INVALID_PARAMS", "订阅消息无效");
          const message = parsed as Record<string, unknown>;
          if (
            typeof message["subscriptionId"] !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(message["subscriptionId"])
          )
            throw new GatewayError("INVALID_PARAMS", "订阅标识无效");
          subscriptionId = message["subscriptionId"];
          requirePermission(device, "workspace.read");
          if (
            message["type"] === "unsubscribe" &&
            Object.keys(message).every((key) => ["type", "subscriptionId"].includes(key))
          ) {
            connection.eventSubscriptions.get(subscriptionId)?.();
            connection.eventSubscriptions.delete(subscriptionId);
            return;
          }
          if (
            message["type"] !== "subscribe" ||
            typeof message["workspaceId"] !== "string" ||
            (message["afterEventId"] !== undefined &&
              typeof message["afterEventId"] !== "string") ||
            Object.keys(message).some(
              (key) => !["type", "subscriptionId", "workspaceId", "afterEventId"].includes(key),
            )
          )
            throw new GatewayError("INVALID_PARAMS", "订阅消息无效");
          if (
            connection.eventSubscriptions.size >= 16 &&
            !connection.eventSubscriptions.has(subscriptionId)
          )
            throw new GatewayError("RATE_LIMITED", "工作区订阅过多", 429);
          const workspaceId = message["workspaceId"];
          const workspace = resolveDeviceWorkspace(this.config, device, workspaceId);
          const params: RuntimeParams<"events.subscribe"> = {
            workspacePath: workspace.path,
            ...(typeof message["afterEventId"] === "string"
              ? { afterEventId: message["afterEventId"] }
              : {}),
          };
          connection.eventSubscriptions.get(subscriptionId)?.();
          connection.eventSubscriptions.delete(subscriptionId);
          const subscription = await connection.client.subscribe(params, (event) =>
            send({ type: "notification", subscriptionId: subscriptionId!, workspaceId, event }),
          );
          if (
            socket.readyState !== WebSocket.OPEN ||
            device.revokedAt ||
            connection.socket !== socket
          ) {
            subscription.dispose();
            return;
          }
          connection.eventSubscriptions.set(subscriptionId, subscription.dispose);
          send({ type: "subscribed", subscriptionId, workspaceId, replay: subscription.replay });
        } catch (error) {
          const safe = safeGatewayError(error);
          send({
            type: "error",
            ...(subscriptionId ? { subscriptionId } : {}),
            error: { code: safe.code, message: safe.message, retryable: safe.retryable },
          });
        } finally {
          pendingMessages--;
        }
      });
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (connection.socket !== socket) return;
      connection.socket = undefined;
      connection.frameDispose?.();
      connection.frameDispose = undefined;
      for (const dispose of connection.eventSubscriptions.values()) dispose();
      connection.eventSubscriptions.clear();
      const owned = [...connection.sessionSubscriptions];
      connection.sessionSubscriptions.clear();
      connection.pendingFrames.length = 0;
      connection.pendingFrameBytes = 0;
      for (const [subscriptionId, scope] of owned) {
        const workspace = this.config.workspaces.find((entry) => entry.id === scope.workspaceId);
        if (workspace)
          void connection.client
            .request("session.subscription.close", {
              workspacePath: workspace.path,
              sessionId: scope.sessionId,
              subscriptionId,
            })
            .catch(() => undefined);
      }
      // RPC client survives transport disconnect; no run or terminal cancellation.
    });
  }
  private sendSessionFrame(
    connection: DeviceConnection,
    workspaceId: string,
    frame: RuntimeSessionSubscriptionFrame,
  ): void {
    const socket = connection.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify({
      type: "session_frame",
      workspaceId,
      frame,
    } satisfies RemoteServerMessage);
    if (
      Buffer.byteLength(data) > REMOTE_MAX_FRAME_BYTES ||
      socket.bufferedAmount > 4 * REMOTE_MAX_FRAME_BYTES
    ) {
      socket.close(1009, "事件预算超限，请重新同步");
      return;
    }
    socket.send(data);
  }
  private async streamArtifact(
    device: GatewayDevice,
    connection: DeviceConnection,
    response: ServerResponse,
    workspacePath: string,
    sessionId: string,
    artifactId: string,
  ): Promise<void> {
    const metadata = parseRuntimeResult(
      "session.artifacts.query",
      await connection.client.request("session.artifacts.query", {
        workspacePath,
        sessionId,
        artifactId,
        action: "get",
      }),
    );
    const artifacts = metadata["artifacts"];
    const artifact = Array.isArray(artifacts)
      ? (artifacts[0] as Record<string, unknown> | undefined)
      : undefined;
    if (
      !artifact ||
      artifact["artifactId"] !== artifactId ||
      !Number.isSafeInteger(artifact["sizeBytes"]) ||
      (artifact["sizeBytes"] as number) < 0 ||
      typeof artifact["digest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact["digest"])
    )
      throw new GatewayError("INVALID_RESULT", "生成文件元数据无效", 502);
    const size = artifact["sizeBytes"] as number;
    const digest = artifact["digest"];
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", size);
    response.setHeader("X-Pico-Sha256", digest);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="artifact-${artifactId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}"`,
    );
    response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    connection.downloads.add(response);
    const hash = createHash("sha256");
    try {
      let offset = 0;
      while (offset < size) {
        if (device.revokedAt || response.destroyed)
          throw new GatewayError("DEVICE_REVOKED", "下载连接已失效", 401);
        const chunk = parseRuntimeResult(
          "session.artifacts.query",
          await connection.client.request("session.artifacts.query", {
            workspacePath,
            sessionId,
            artifactId,
            action: "read_chunk",
            offsetBytes: offset,
            limitBytes: Math.min(32 * 1024, size - offset),
          }),
        );
        if (
          typeof chunk["contentBase64"] !== "string" ||
          !chunk["artifact"] ||
          typeof chunk["artifact"] !== "object"
        )
          throw new GatewayError("INVALID_RESULT", "生成文件分块无效", 502);
        const bytes = Buffer.from(chunk["contentBase64"], "base64");
        if (
          bytes.toString("base64") !== chunk["contentBase64"] ||
          !bytes.length ||
          chunk["offsetBytes"] !== offset ||
          chunk["endOffsetBytes"] !== offset + bytes.length ||
          chunk["totalBytes"] !== size ||
          (chunk["artifact"] as Record<string, unknown>)["digest"] !== digest ||
          offset + bytes.length > size
        )
          throw new GatewayError("INVALID_RESULT", "生成文件在下载期间已改变", 502);
        hash.update(bytes);
        offset += bytes.length;
        // Keep final chunk until digest verifies so a corrupted file cannot complete successfully.
        if (offset === size && hash.digest("hex") !== digest)
          throw new GatewayError("INVALID_RESULT", "生成文件摘要不匹配", 502);
        if (!response.write(bytes)) await waitForDrain(response);
      }
      if (size === 0 && hash.digest("hex") !== digest)
        throw new GatewayError("INVALID_RESULT", "空文件摘要不匹配", 502);
      response.end();
    } finally {
      connection.downloads.delete(response);
    }
  }
  private rate(key: string, capacity: number, window: number): void {
    const now = this.now();
    const bucket = this.rateBuckets.get(key) ?? { tokens: capacity, updated: now };
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((now - bucket.updated) * capacity) / window,
    );
    bucket.updated = now;
    if (bucket.tokens < 1)
      throw new GatewayError("RATE_LIMITED", "请求过于频繁，请稍后重试", 429, true);
    bucket.tokens--;
    this.rateBuckets.set(key, bucket);
    if (this.rateBuckets.size > 10_000) this.sweepRateBuckets();
    if (this.rateBuckets.size > 10_000)
      throw new GatewayError("RATE_LIMITED", "网关请求过多", 429, true);
  }
  private sweepRateBuckets(): void {
    for (const [key, bucket] of this.rateBuckets)
      if (this.now() - bucket.updated > 5 * 60_000) this.rateBuckets.delete(key);
  }
  private status(): unknown {
    return {
      gatewayId: this.state.gatewayId,
      startedAt: this.startedAt,
      publicUrl: this.config.publicUrl,
      listening: this.servers.map((server) => server.address()),
      devices: this.connections.size,
      runtime: {
        lastReachableAt: this.runtimeLastReachableAt,
        ...(this.runtimeLastFailure ? { lastFailure: this.runtimeLastFailure } : {}),
        continuousHealthVerified: false,
      },
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
  private async doctor(): Promise<unknown> {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    try {
      const cert = await readTlsFile(this.config.certificatePath);
      const key = await readTlsFile(this.config.privateKeyPath);
      validateCertificate(this.config, cert, key, this.now());
      checks.push({ name: "TLS", ok: true, detail: "域名、证书期限与私钥匹配" });
    } catch {
      checks.push({ name: "TLS", ok: false, detail: "证书无效、过期或与域名/私钥不匹配" });
    }
    try {
      const addresses = await lookup(
        new URL(this.config.publicUrl).hostname.replace(/^\[|\]$/g, ""),
        { all: true },
      );
      checks.push({
        name: "DNS",
        ok: addresses.length > 0,
        detail: addresses.map((address) => address.address).join(", "),
      });
    } catch {
      checks.push({ name: "DNS", ok: false, detail: "公网域名解析失败" });
    }
    const client =
      this.options.createRuntimeClient?.("doctor") ??
      new LocalRuntimeClient({
        ...(this.config.runtimeHostRootPath
          ? { runtimeHostRootPath: this.config.runtimeHostRootPath }
          : {}),
        surface: "inspect",
      });
    try {
      await client.request("runtime.ping", {});
      checks.push({ name: "Runtime", ok: true, detail: "本机 Runtime 可连接" });
    } catch {
      checks.push({ name: "Runtime", ok: false, detail: "本机 Runtime 不可连接" });
    } finally {
      client.close();
    }
    checks.push({
      name: "Listener",
      ok: this.servers.some((server) => server.listening),
      detail: "本机监听检查；请另用手机蜂窝网络验证外网可达性",
    });
    return { checks, externalReachabilityVerified: false };
  }
}
function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header || !/^Bearer [a-zA-Z0-9_-]{32,256}$/.test(header))
    throw new GatewayError("UNAUTHORIZED", "需要有效认证凭据", 401);
  return header.slice(7);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new GatewayError("INVALID_PARAMS", "请求必须为 application/json", 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > REMOTE_MAX_FRAME_BYTES)
      throw new GatewayError("FRAME_TOO_LARGE", "请求超过 1 MiB 预算", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError("INVALID_PARAMS", "JSON 请求格式无效");
  }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > REMOTE_MAX_FRAME_BYTES)
    throw new GatewayError("FRAME_TOO_LARGE", "响应超过预算，请分页读取", 502, false, "unknown");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(output));
  response.end(output);
}
function publicDevice(device: GatewayDevice): unknown {
  const { tokenHash: _tokenHash, ...rest } = device;
  return rest;
}
export function validateCertificate(
  config: GatewayConfig,
  cert: Buffer,
  key: Buffer,
  now = Date.now(),
): void {
  const certificate = new X509Certificate(cert);
  const hostname = new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, "");
  if (
    !(certificate.checkHost(hostname) || certificate.checkIP(hostname)) ||
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  )
    throw new Error("TLS 证书域名或有效期不匹配");
  if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new Error("TLS 私钥与证书不匹配");
  createSecureContext({ cert, key, minVersion: "TLSv1.2" });
}
export async function createRemoteGateway(
  config: GatewayConfig,
  options: RemoteGatewayOptions = {},
): Promise<RemoteGateway> {
  return RemoteGateway.create(config, options);
}
export async function configureRemoteGateway(
  config: GatewayConfig,
  home = defaultGatewayHome(),
): Promise<void> {
  const directory = await ensureGatewayHome(home);
  const release = await acquireGatewayLock(directory);
  try {
    validateGatewayConfig(config);
    const registered = await new WorkspaceRegistrationStore(
      config.runtimeHostRootPath
        ? join(config.runtimeHostRootPath, "daemon-workspaces.json")
        : undefined,
    ).list();
    const canonical = await Promise.all(
      config.workspaces.map(async (workspace) => ({
        ...workspace,
        path: await realpath(workspace.path),
      })),
    );
    if (canonical.some((workspace) => !registered.includes(workspace.path)))
      throw new Error("只能授权 Pico 已注册的工作区；请先在电脑注册");
    validateCertificate(
      config,
      await readTlsFile(config.certificatePath),
      await readTlsFile(config.privateKeyPath),
    );
    await writePrivateJson(join(directory, "config.json"), { ...config, workspaces: canonical });
  } finally {
    await release();
  }
}
export async function startConfiguredRemoteGateway(
  options: RemoteGatewayOptions = {},
): Promise<RemoteGateway> {
  const home = await ensureGatewayHome(options.home ?? defaultGatewayHome());
  const gateway = await createRemoteGateway(await loadGatewayConfig(home), { ...options, home });
  await gateway.start();
  return gateway;
}
export { requestGatewayControl };

/** Remote projections additionally remove executable configuration and credential-bearing endpoints. */
function projectRemoteResult(method: string, result: unknown): unknown {
  if (method === "provider.test" && result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    return {
      ...value,
      message: value["ok"] ? "Provider 验证成功" : "Provider 验证失败，请查看电脑本机诊断",
    };
  }
  if (
    method.startsWith("config.") ||
    method.startsWith("provider.") ||
    method.startsWith("mcp.") ||
    method === "hooks.manage" ||
    method === "plugin.manage"
  )
    return publicConfiguration(
      result,
      method.startsWith("config.") || method === "hooks.manage" || method === "plugin.manage",
    );
  return result;
}
function publicConfiguration(value: unknown, hideExecutableText: boolean): unknown {
  if (Array.isArray(value))
    return value.map((entry) => publicConfiguration(entry, hideExecutableText));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (
      [
        "env",
        "headers",
        "apikey",
        "secret",
        "password",
        "token",
        "accesstoken",
        "refreshtoken",
        "clientsecret",
        "credential",
        "raw",
        "content",
        "script",
        "code",
        "manifest",
      ].includes(normalized)
    )
      continue;
    if (hideExecutableText && ["command", "args", "commands"].includes(normalized)) continue;
    if (["baseurl", "url", "endpoint"].includes(normalized) && typeof item === "string")
      output[key] = publicEndpoint(item);
    else if (["error", "loaderror", "message"].includes(normalized) && typeof item === "string")
      output[key] = "请查看电脑本机诊断";
    else output[key] = publicConfiguration(item, hideExecutableText);
  }
  return output;
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = (): void => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = (): void => {
      clear();
      resolve();
    };
    const closed = (): void => {
      clear();
      reject(new Error("下载连接已关闭"));
    };
    const failed = (error: Error): void => {
      clear();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    if (response.destroyed) closed();
  });
}
