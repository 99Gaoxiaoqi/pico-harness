import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createRelayHostSession } from "@pico/remote-client/relay-crypto";
import { RELAY_MAX_FRAME_BYTES, type RemoteRelayEndpoint } from "@pico/protocol/relay";

export interface RelayStatus {
  state: "connecting" | "online" | "reconnecting" | "unauthorized" | "error";
  lastConnectedAt?: number;
  lastError?: string;
}
export interface RelayChannel {
  readonly id: string;
  readonly active: boolean;
  readonly bufferedAmount: number;
  deviceId?: string;
  send(value: unknown): void;
  close(): void;
}
interface Channel extends RelayChannel {
  crypto: ReturnType<typeof createRelayHostSession>;
  deadline: NodeJS.Timeout;
  pending: number;
}
/** One outbound connection; queued requests are never retained across a disconnect. */
export class GatewayRelay {
  readonly status: RelayStatus = { state: "connecting" };
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private attempt = 0;
  private readonly channels = new Map<string, Channel>();
  constructor(
    private readonly options: {
      endpoint: RemoteRelayEndpoint;
      secretKey: string;
      token: string;
      createWebSocket?: (url: string) => WebSocket;
      onMessage: (channel: RelayChannel, value: unknown) => Promise<void>;
      onClose: (channel: RelayChannel) => void;
    },
  ) {}
  start(): void {
    this.connect();
  }
  closeDevice(id: string): void {
    for (const channel of this.channels.values()) if (channel.deviceId === id) channel.close();
  }
  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    for (const channel of [...this.channels.values()]) this.drop(channel.id, false);
    this.socket?.terminate();
  }
  private drop(id: string, notify = true): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    clearTimeout(channel.deadline);
    channel.crypto.close();
    this.options.onClose(channel);
    if (notify && this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.send({ version: 1, type: "close", channelId: id, code: "CHANNEL_CLOSED" });
      } catch {
        /* socket close releases all remaining channels */
      }
    }
  }
  private send(value: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("RELAY_DISCONNECTED");
    const text = JSON.stringify(value);
    if (
      Buffer.byteLength(text) > RELAY_MAX_FRAME_BYTES ||
      socket.bufferedAmount + Buffer.byteLength(text) > 4 * RELAY_MAX_FRAME_BYTES
    ) {
      socket.terminate();
      throw new Error("RELAY_BACKPRESSURE");
    }
    socket.send(text);
  }
  private connect(): void {
    if (this.stopped) return;
    this.status.state = this.attempt ? "reconnecting" : "connecting";
    const url = new URL("/v1/relay", this.options.endpoint.relayUrl);
    url.protocol = "wss:";
    const socket =
      this.options.createWebSocket?.(url.href) ??
      new WebSocket(url, {
        maxPayload: RELAY_MAX_FRAME_BYTES,
        handshakeTimeout: 15_000,
        followRedirects: false,
      });
    this.socket = socket;
    let registered = false;
    let alive = true;
    let unauthorized = false;
    const registrationDeadline = setTimeout(() => socket.terminate(), 15_000);
    socket.on("open", () =>
      this.send({
        version: 1,
        type: "host",
        gatewayId: this.options.endpoint.gatewayId,
        token: this.options.token,
      }),
    );
    socket.on("pong", () => {
      alive = true;
    });
    this.heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        alive = false;
        socket.ping();
      }
    }, 20_000);
    socket.on("message", (raw, binary) => {
      try {
        if (binary || Buffer.byteLength(raw.toString()) > RELAY_MAX_FRAME_BYTES)
          throw new Error("INVALID_RELAY_FRAME");
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!value || value.version !== 1 || typeof value.type !== "string")
          throw new Error("INVALID_RELAY_FRAME");
        if (value.type === "error" || (value.type === "close" && value.channelId === undefined)) {
          unauthorized =
            value.code === "UNAUTHORIZED" ||
            value.code === "HOST_REVOKED" ||
            value.code === "TOKEN_REVOKED" ||
            value.code === "HOST_AUTH_FAILED";
          this.status.lastError = unauthorized
            ? "中继注册凭据已失效，请在电脑重新配置"
            : "中继服务拒绝连接，请查看服务状态";
          socket.terminate();
          return;
        }
        if (value.type === "registered" && !registered) {
          registered = true;
          clearTimeout(registrationDeadline);
          this.attempt = 0;
          this.status.state = "online";
          this.status.lastConnectedAt = Date.now();
          delete this.status.lastError;
          return;
        }
        if (
          !registered ||
          typeof value.channelId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(value.channelId)
        )
          throw new Error("INVALID_RELAY_FRAME");
        const id = value.channelId;
        if (value.type === "open") {
          if (this.channels.has(id)) throw new Error("DUPLICATE_CHANNEL");
          if (this.channels.size >= 64) {
            this.send({ version: 1, type: "close", channelId: id, code: "HOST_BUSY" });
            return;
          }
          const crypto = createRelayHostSession(
            this.options.endpoint,
            this.options.secretKey,
            randomBytes,
          );
          const owner = this;
          const channel: Channel = {
            id,
            crypto,
            pending: 0,
            get active() {
              return owner.channels.get(id) === channel;
            },
            get bufferedAmount() {
              return owner.socket?.bufferedAmount ?? 0;
            },
            deadline: setTimeout(() => this.drop(id), 180_000),
            send: (message) => {
              if (!channel.active) return;
              try {
                this.send({
                  version: 1,
                  type: "data",
                  channelId: id,
                  payload: crypto.send(message),
                });
              } catch {
                channel.close();
              }
            },
            close: () => this.drop(id),
          };
          this.channels.set(id, channel);
          return;
        }
        const channel = this.channels.get(id);
        if (!channel) return;
        if (value.type === "close") {
          this.drop(id, false);
          return;
        }
        if (value.type !== "data" || typeof value.payload !== "string")
          throw new Error("INVALID_RELAY_FRAME");
        try {
          const result = channel.crypto.receive(value.payload);
          if ("reply" in result) {
            this.send({ version: 1, type: "data", channelId: id, payload: result.reply });
            return;
          }
          if (++channel.pending > 16) {
            channel.close();
            return;
          }
          void this.options
            .onMessage(channel, result.message)
            .then(() => {
              if (channel.deviceId) clearTimeout(channel.deadline);
            })
            .catch(() => channel.close())
            .finally(() => {
              channel.pending--;
            });
        } catch {
          channel.close();
        }
      } catch {
        socket.terminate();
      }
    });
    socket.on("error", () => {
      this.status.lastError = "无法连接中继服务，请检查网络与 HTTPS 证书";
    });
    socket.on("close", () => {
      clearTimeout(registrationDeadline);
      clearInterval(this.heartbeat);
      for (const id of [...this.channels.keys()]) this.drop(id, false);
      if (this.stopped) return;
      if (unauthorized) {
        this.status.state = "unauthorized";
        return;
      }
      this.status.state = "reconnecting";
      this.status.lastError ??= "连接中断，正在重新连接";
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 6)) + Math.floor(Math.random() * 250),
      );
    });
  }
}

/** Implements only the socket operations used by the gateway's existing event policy. */
export class RelayEventSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }
  constructor(private readonly channel: RelayChannel) {
    super();
  }
  send(value: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    try {
      this.channel.send({ kind: "event", value: JSON.parse(value) });
    } catch {
      this.close();
    }
  }
  close(): void {
    this.finish();
    this.channel.close();
  }
  terminate(): void {
    this.close();
  }
  finish(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}
