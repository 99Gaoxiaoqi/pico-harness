import { RemoteProtocolError } from "./remote.js";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_MAX_FRAME_BYTES = 2 * 1024 * 1024 + 64 * 1024;
export const RELAY_MAX_PLAINTEXT_BYTES = 1024 * 1024 + 16 * 1024;

export interface RemoteRelayEndpoint {
  mode: "relay";
  relayUrl: string;
  gatewayId: string;
  /** Pinned by the locally approved QR, never learned from the relay. */
  hostPublicKey: string;
}

export function parseRelayEndpoint(value: unknown): RemoteRelayEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RemoteProtocolError("INVALID_RELAY", "中继连接描述无效");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["mode", "relayUrl", "gatewayId", "hostPublicKey"].includes(k)) ||
      v.mode !== "relay" || typeof v.relayUrl !== "string" ||
      typeof v.gatewayId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.gatewayId) ||
      typeof v.hostPublicKey !== "string" || !/^[a-f0-9]{64}$/.test(v.hostPublicKey))
    throw new RemoteProtocolError("INVALID_RELAY", "中继连接描述无效");
  let url: URL;
  try { url = new URL(v.relayUrl); } catch { throw new RemoteProtocolError("INVALID_RELAY", "中继地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !["", "/"].includes(url.pathname))
    throw new RemoteProtocolError("INVALID_RELAY", "中继地址必须是 HTTPS origin");
  return { mode: "relay", relayUrl: url.origin, gatewayId: v.gatewayId, hostPublicKey: v.hostPublicKey };
}

/** Opaque data is authenticated/encrypted end to end. Route metadata carries no device token. */
export type RelayWireMessage =
  | { version: 1; type: "host"; gatewayId: string; token: string }
  | { version: 1; type: "join"; gatewayId: string }
  | { version: 1; type: "registered" }
  | { version: 1; type: "joined" | "open"; channelId: string }
  | { version: 1; type: "data"; channelId?: string; payload: string }
  | { version: 1; type: "close"; channelId?: string; code?: string }
  | { version: 1; type: "error"; code: string };

export type RelayApplicationMessage =
  | { kind: "request"; id: string; method: "GET" | "POST" | "DELETE"; path: string; token?: string; body?: unknown }
  | { kind: "response"; id: string; status: number; body: unknown }
  | { kind: "events.open"; token: string }
  | { kind: "events.send"; value: unknown }
  | { kind: "events.close" }
  | { kind: "event"; value: unknown };
