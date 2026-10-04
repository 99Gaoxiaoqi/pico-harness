import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP, type AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { lockHome, startControl } from "./control.js";
import { RelayError, RelayStore, validGatewayId, validSecret, validTokenHash } from "./state.js";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_MAX_FRAME_BYTES = 2 * 1024 * 1024 + 64 * 1024;
export const RELAY_MAX_PAYLOAD_BYTES = RELAY_MAX_FRAME_BYTES - 2048;
export interface RelayLimits {
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxHosts: number;
  maxChannelsPerHost: number;
  maxBufferedBytes: number;
  handshakeTimeoutMs: number;
  idleTimeoutMs: number;
  heartbeatIntervalMs: number;
  upgradeRatePerMinute: number;
  enrollRatePerMinute: number;
  /** One mobile channel, counting both directions. */
  framesPerMinute: number;
  bytesPerMinute: number;
  /** All channels of one authenticated host, counting both directions. */
  hostFramesPerMinute: number;
  hostBytesPerMinute: number;
  pendingBytesPerMinute: number;
}
const DEFAULT_LIMITS: RelayLimits = {
  maxConnections: 1024,
  maxConnectionsPerIp: 32,
  maxHosts: 128,
  maxChannelsPerHost: 64,
  maxBufferedBytes: 4 * RELAY_MAX_FRAME_BYTES,
  handshakeTimeoutMs: 5000,
  idleTimeoutMs: 15 * 60_000,
  heartbeatIntervalMs: 30_000,
  upgradeRatePerMinute: 60,
  enrollRatePerMinute: 10,
  framesPerMinute: 6000,
  bytesPerMinute: 32 * 1024 * 1024,
  hostFramesPerMinute: 60_000,
  hostBytesPerMinute: 1024 * 1024 * 1024,
  pendingBytesPerMinute: 64 * 1024,
};
export interface RelayServerOptions {
  home: string;
  host?: string;
  port?: number;
  tls?: { cert: Buffer; key: Buffer };
  limits?: Partial<RelayLimits>;
  allowPrivateBind?: boolean;
  trustProxy?: boolean;
}
type Role =
  | { type: "pending" }
  | { type: "host"; gatewayId: string }
  | { type: "mobile"; gatewayId: string; channelId: string };
interface Peer {
  socket: WebSocket;
  ip: string;
  role: Role;
  lastActivity: number;
  alive: boolean;
  handshake?: NodeJS.Timeout;
  traffic?: { frames: Bucket; bytes: Bucket };
}
interface Host {
  peer: Peer;
  channels: Map<string, Peer>;
}
interface Bucket {
  tokens: number;
  at: number;
}
function consume(bucket: Bucket, capacity: number, cost: number, now: number, code: string): void {
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) * capacity) / 60_000);
  bucket.at = now;
  if (bucket.tokens < cost) throw new RelayError(code);
  bucket.tokens -= cost;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return value.version === 1 && Object.keys(value).every((key) => allowed.includes(key));
}
function closeCode(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value));
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
export class RelayServer {
  readonly limits: RelayLimits;
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: RELAY_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  private readonly peers = new Set<Peer>();
  private readonly hosts = new Map<string, Host>();
  private readonly ipConnections = new Map<string, number>();
  private readonly buckets = new Map<string, Bucket>();
  private heartbeat?: NodeJS.Timeout;
  private controlClose?: () => Promise<void>;
  private releaseLock?: () => Promise<void>;
  private started = false;
  private closing = false;
  private constructor(
    readonly options: RelayServerOptions,
    private readonly store: RelayStore,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new RelayError("INVALID_LIMITS");
    const host = options.host ?? "127.0.0.1";
    if (!["127.0.0.1", "::1", "localhost"].includes(host) && !options.allowPrivateBind)
      throw new RelayError("PRIVATE_BIND_REQUIRED");
    if (
      options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    )
      throw new RelayError("INVALID_PORT");
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void this.http(request, response);
    };
    this.server = options.tls
      ? createHttpsServer(
          { ...options.tls, minVersion: "TLSv1.2", maxHeaderSize: 16 * 1024 },
          handler,
        )
      : createHttpServer({ maxHeaderSize: 16 * 1024 }, handler);
    this.server.maxConnections = this.limits.maxConnections;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 10_000;
    this.server.on("upgrade", (request, socket, head) => {
      let reservedIp: string | undefined;
      try {
        if (this.closing || request.url !== "/v1/relay") throw new RelayError("NOT_FOUND");
        const ip = this.ip(request);
        this.rate(`upgrade:${ip}`, this.limits.upgradeRatePerMinute);
        if (
          this.peers.size >= this.limits.maxConnections ||
          (this.ipConnections.get(ip) ?? 0) >= this.limits.maxConnectionsPerIp
        )
          throw new RelayError("CONNECTION_LIMIT");
        this.ipConnections.set(ip, (this.ipConnections.get(ip) ?? 0) + 1);
        reservedIp = ip;
        // Count until TCP close, including rejected upgrades and closing WebSockets.
        socket.once("close", () => {
          if (reservedIp) this.releaseIp(reservedIp);
          reservedIp = undefined;
        });
        this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws, ip));
      } catch {
        if (reservedIp) this.releaseIp(reservedIp);
        reservedIp = undefined;
        socket.end(
          "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      }
    });
  }
  static async create(options: RelayServerOptions): Promise<RelayServer> {
    return new RelayServer(options, await RelayStore.create(options.home));
  }
  get address(): { host: string; port: number } {
    const address = this.server.address() as AddressInfo | null;
    if (!address) throw new RelayError("NOT_RUNNING");
    return { host: address.address, port: address.port };
  }
  get origin(): string {
    const address = this.address,
      host = address.host.includes(":") ? `[${address.host}]` : address.host;
    return `${this.options.tls ? "https" : "http"}://${host}:${address.port}`;
  }
  async start(): Promise<void> {
    if (this.started || this.closing) throw new RelayError("ALREADY_RUNNING");
    this.releaseLock = await lockHome(this.store.home);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.options.port ?? 8787, this.options.host ?? "127.0.0.1", () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      this.controlClose = await startControl(this.store.home, async (method, params) => {
        if (method === "invite" && Object.keys(params).every((key) => key === "ttlMs"))
          return this.store.invite(params.ttlMs === undefined ? undefined : Number(params.ttlMs));
        if (
          method === "revoke" &&
          validGatewayId(params.gatewayId) &&
          Object.keys(params).every((key) => key === "gatewayId")
        ) {
          const value = await this.store.revoke(params.gatewayId);
          const host = this.hosts.get(params.gatewayId);
          if (host) this.disconnect(host.peer, "HOST_REVOKED");
          return value;
        }
        throw new RelayError("INVALID_ADMIN_METHOD");
      });
      this.started = true;
      this.heartbeat = setInterval(() => {
        const now = Date.now();
        for (const peer of this.peers) {
          if (!peer.alive || now - peer.lastActivity > this.limits.idleTimeoutMs) {
            peer.socket.terminate();
            continue;
          }
          peer.alive = false;
          peer.socket.ping();
        }
        for (const [key, bucket] of this.buckets)
          if (now - bucket.at > 60_000) this.buckets.delete(key);
      }, this.limits.heartbeatIntervalMs);
      this.heartbeat.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const peer of this.peers) {
      this.cleanup(peer);
      peer.socket.terminate();
    }
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    if (this.server.listening) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    await this.controlClose?.();
    await this.releaseLock?.();
  }
  private ip(request: IncomingMessage): string {
    const forwarded = request.headers["x-forwarded-for"];
    if (this.options.trustProxy && typeof forwarded === "string" && isIP(forwarded.trim()))
      return forwarded.trim();
    return request.socket.remoteAddress ?? "unknown";
  }
  private rate(key: string, capacity: number, cost = 1, code = "RATE_LIMITED"): void {
    const now = Date.now(),
      bucket = this.buckets.get(key) ?? { tokens: capacity, at: now };
    if (this.buckets.size >= 10_000 && !this.buckets.has(key)) throw new RelayError("RATE_LIMITED");
    consume(bucket, capacity, cost, now, code);
    this.buckets.set(key, bucket);
  }
  private traffic(peer: Peer, bytes: number): void {
    const now = Date.now();
    const host = peer.role.type === "host";
    const framesCapacity = host ? this.limits.hostFramesPerMinute : this.limits.framesPerMinute;
    const bytesCapacity = host ? this.limits.hostBytesPerMinute : this.limits.bytesPerMinute;
    peer.traffic ??= {
      frames: { tokens: framesCapacity, at: now },
      bytes: { tokens: bytesCapacity, at: now },
    };
    consume(peer.traffic.frames, framesCapacity, 1, now, "RATE_LIMITED");
    consume(peer.traffic.bytes, bytesCapacity, bytes, now, "BYTE_RATE_LIMITED");
  }
  private async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closing) throw new RelayError("UNAVAILABLE");
      if (request.method === "GET" && request.url === "/v1/health") {
        json(response, 200, { version: 1, status: "ok" });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/enroll") {
        json(response, 404, { version: 1, type: "error", code: "NOT_FOUND" });
        return;
      }
      this.rate(`enroll:${this.ip(request)}`, this.limits.enrollRatePerMinute);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) throw new RelayError("FRAME_TOO_LARGE");
        chunks.push(bytes);
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !object(input) ||
        !fields(input, ["version", "invitation", "gatewayId", "tokenHash"]) ||
        !validSecret(input.invitation) ||
        !validGatewayId(input.gatewayId) ||
        !validTokenHash(input.tokenHash)
      )
        throw new RelayError("INVALID_FRAME");
      json(
        response,
        200,
        await this.store.enroll(input.invitation, input.gatewayId, input.tokenHash),
      );
    } catch (error) {
      const code = error instanceof RelayError ? error.code : "INVALID_REQUEST";
      json(response, code === "RATE_LIMITED" ? 429 : code === "INVALID_INVITATION" ? 403 : 400, {
        version: 1,
        type: "error",
        code,
      });
    }
  }
  private accept(socket: WebSocket, ip: string): void {
    const peer: Peer = {
      socket,
      ip,
      role: { type: "pending" },
      lastActivity: Date.now(),
      alive: true,
    };
    this.peers.add(peer);
    peer.handshake = setTimeout(
      () => this.disconnect(peer, "HANDSHAKE_TIMEOUT", true),
      this.limits.handshakeTimeoutMs,
    );
    peer.handshake.unref();
    socket.on("error", () => undefined);
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("ping", () => {
      peer.lastActivity = Date.now();
    });
    socket.on("message", (data: RawData, binary: boolean) => {
      try {
        if (!this.peers.has(peer) || binary) throw new RelayError("INVALID_FRAME");
        const text = data.toString();
        const bytes = Buffer.byteLength(text);
        if (peer.role.type === "pending") {
          this.rate(`register:${peer.ip}`, this.limits.upgradeRatePerMinute);
          this.rate(
            `register-bytes:${peer.ip}`,
            this.limits.pendingBytesPerMinute,
            bytes,
            "BYTE_RATE_LIMITED",
          );
        } else this.traffic(peer, bytes);
        const frame: unknown = JSON.parse(text);
        if (!object(frame) || frame.version !== 1) throw new RelayError("INVALID_FRAME");
        peer.lastActivity = Date.now();
        this.message(peer, frame, bytes);
      } catch (error) {
        this.disconnect(peer, error instanceof RelayError ? error.code : "INVALID_FRAME", true);
      }
    });
    socket.once("close", () => this.cleanup(peer));
  }
  private message(peer: Peer, frame: Record<string, unknown>, bytes: number): void {
    if (peer.role.type === "pending") {
      if (
        frame.type === "host" &&
        fields(frame, ["version", "type", "gatewayId", "token"]) &&
        validGatewayId(frame.gatewayId) &&
        validSecret(frame.token)
      ) {
        if (!this.store.authenticate(frame.gatewayId, frame.token))
          throw new RelayError("HOST_AUTH_FAILED");
        if (this.hosts.has(frame.gatewayId)) throw new RelayError("HOST_ALREADY_CONNECTED");
        if (this.hosts.size >= this.limits.maxHosts) throw new RelayError("HOST_LIMIT");
        peer.role = { type: "host", gatewayId: frame.gatewayId };
        this.hosts.set(frame.gatewayId, { peer, channels: new Map() });
        this.send(peer, { type: "registered" });
      } else if (
        frame.type === "join" &&
        fields(frame, ["version", "type", "gatewayId"]) &&
        validGatewayId(frame.gatewayId)
      ) {
        const host = this.hosts.get(frame.gatewayId);
        if (!host || host.peer.socket.readyState !== WebSocket.OPEN)
          throw new RelayError("HOST_OFFLINE");
        if (host.channels.size >= this.limits.maxChannelsPerHost)
          throw new RelayError("CHANNEL_LIMIT");
        const channelId = randomUUID();
        peer.role = { type: "mobile", gatewayId: frame.gatewayId, channelId };
        host.channels.set(channelId, peer);
        this.send(peer, { type: "joined", channelId });
        this.send(host.peer, { type: "open", channelId });
      } else throw new RelayError("INVALID_FRAME");
      if (peer.handshake) clearTimeout(peer.handshake);
      peer.handshake = undefined;
      return;
    }
    if (
      frame.type === "close" &&
      fields(frame, ["version", "type", "channelId", "code"]) &&
      closeCode(frame.code)
    ) {
      if (peer.role.type === "host" && typeof frame.channelId === "string") {
        const mobile = this.hosts.get(peer.role.gatewayId)?.channels.get(frame.channelId);
        if (!mobile) throw new RelayError("CHANNEL_NOT_FOUND");
        this.disconnect(mobile, typeof frame.code === "string" ? frame.code : "CHANNEL_CLOSED");
        return;
      }
      if (frame.channelId !== undefined) throw new RelayError("INVALID_FRAME");
      this.disconnect(peer, typeof frame.code === "string" ? frame.code : "CHANNEL_CLOSED");
      return;
    }
    if (
      frame.type !== "data" ||
      typeof frame.payload !== "string" ||
      !fields(
        frame,
        peer.role.type === "host"
          ? ["version", "type", "channelId", "payload"]
          : ["version", "type", "payload"],
      )
    )
      throw new RelayError("INVALID_FRAME");
    if (Buffer.byteLength(frame.payload) > RELAY_MAX_PAYLOAD_BYTES)
      throw new RelayError("FRAME_TOO_LARGE");
    const host = this.hosts.get(peer.role.gatewayId);
    if (!host) throw new RelayError("HOST_OFFLINE");
    if (peer.role.type === "mobile") {
      const outgoing = {
        type: "data",
        channelId: peer.role.channelId,
        payload: frame.payload,
      };
      if (Buffer.byteLength(JSON.stringify({ version: 1, ...outgoing })) > RELAY_MAX_FRAME_BYTES)
        throw new RelayError("FRAME_TOO_LARGE");
      // Account for uplink traffic in the host's aggregate without sharing an IP bucket.
      this.traffic(host.peer, bytes);
      this.send(host.peer, outgoing);
    } else {
      if (typeof frame.channelId !== "string") throw new RelayError("INVALID_FRAME");
      const mobile = host.channels.get(frame.channelId);
      if (!mobile) throw new RelayError("CHANNEL_NOT_FOUND");
      try {
        this.traffic(mobile, bytes);
      } catch (error) {
        // A noisy channel must not evict the host or the host's other channels.
        this.disconnect(mobile, error instanceof RelayError ? error.code : "RATE_LIMITED", true);
        return;
      }
      this.send(mobile, { type: "data", payload: frame.payload });
    }
  }
  private send(peer: Peer, message: Record<string, unknown>): void {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify({ version: 1, ...message });
    if (
      Buffer.byteLength(data) > RELAY_MAX_FRAME_BYTES ||
      peer.socket.bufferedAmount + Buffer.byteLength(data) > this.limits.maxBufferedBytes
    ) {
      this.disconnect(peer, "BUFFER_LIMIT");
      return;
    }
    peer.socket.send(data);
  }
  private disconnect(peer: Peer, code: string, error = false): void {
    this.cleanup(peer);
    if (peer.socket.readyState === WebSocket.OPEN) {
      peer.socket.send(JSON.stringify({ version: 1, type: error ? "error" : "close", code }));
      peer.socket.close(1008, code);
      const timer = setTimeout(() => peer.socket.terminate(), 1000);
      timer.unref();
      peer.socket.once("close", () => clearTimeout(timer));
    } else peer.socket.terminate();
  }
  private cleanup(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    if (peer.handshake) clearTimeout(peer.handshake);
    if (peer.role.type === "host") {
      const host = this.hosts.get(peer.role.gatewayId);
      if (host?.peer === peer) {
        this.hosts.delete(peer.role.gatewayId);
        for (const mobile of host.channels.values()) this.disconnect(mobile, "HOST_DISCONNECTED");
      }
    } else if (peer.role.type === "mobile") {
      const host = this.hosts.get(peer.role.gatewayId);
      host?.channels.delete(peer.role.channelId);
      if (host) this.send(host.peer, { type: "close", channelId: peer.role.channelId });
    }
  }
  private releaseIp(ip: string): void {
    const next = (this.ipConnections.get(ip) ?? 1) - 1;
    if (next <= 0) this.ipConnections.delete(ip);
    else this.ipConnections.set(ip, next);
  }
}
export const createRelayServer = (options: RelayServerOptions): Promise<RelayServer> =>
  RelayServer.create(options);
export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const server = await createRelayServer(options);
  await server.start();
  return server;
}
