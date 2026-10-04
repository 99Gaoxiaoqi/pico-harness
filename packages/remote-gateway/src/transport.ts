import { EventEmitter } from "node:events";
import { REMOTE_MAX_FRAME_BYTES } from "@pico/protocol/remote";
import type { RelayChannel } from "./relay.js";

export interface GatewayRequest extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  headers: { authorization?: string; "content-type"?: string };
  socket: { remoteAddress?: string };
  bindDevice?: (deviceId: string) => void;
}
export interface GatewayResponse extends EventEmitter {
  statusCode: number;
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  setHeader(name: string, value: string | number): unknown;
  end(value?: string): unknown;
  write(value: Uint8Array): boolean;
  destroy(): unknown;
}
export interface GatewaySocket extends EventEmitter {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
export function relayRequest(
  channel: RelayChannel,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): GatewayRequest {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (encoded && encoded.length > REMOTE_MAX_FRAME_BYTES) throw new Error("REQUEST_TOO_LARGE");
  return {
    method,
    url: path,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // Anonymous channels share a bounded global rate bucket, authenticated devices have their own bucket.
    socket: { remoteAddress: channel.deviceId ? `relay:${channel.deviceId}` : "relay:anonymous" },
    bindDevice(deviceId) {
      if (!channel.active || (channel.deviceId && channel.deviceId !== deviceId))
        throw new Error("CHANNEL_IDENTITY_CHANGED");
      channel.deviceId = deviceId;
    },
    async *[Symbol.asyncIterator]() {
      if (encoded) yield encoded;
    },
  };
}
export class RelayResponse extends EventEmitter implements GatewayResponse {
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  constructor(
    private readonly channel: RelayChannel,
    private readonly id: string,
  ) {
    super();
  }
  setHeader(): void {}
  write(): boolean {
    throw new Error("RELAY_BINARY_ROUTE_UNSUPPORTED");
  }
  end(value?: string): void {
    if (this.destroyed || this.headersSent) return;
    this.headersSent = true;
    this.channel.send({
      kind: "response",
      id: this.id,
      status: this.statusCode,
      body: value ? JSON.parse(value) : null,
    });
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}
