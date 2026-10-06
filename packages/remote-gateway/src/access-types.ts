import type { RemotePermission, RemoteServerMessage } from "@pico/protocol/remote";
import type { GatewayWorkspace } from "./state.js";

/** Supplied by a trusted adapter after authenticating a device or channel user. */
export interface RuntimeAccessPrincipal {
  readonly id: string;
  readonly terminalOwnerId: string;
  readonly permissions: readonly RemotePermission[];
  readonly workspaceIds: readonly string[];
  readonly revokedAt?: number;
}

/** Runtime authorization needs no TLS, pairing token, Relay endpoint or platform SDK. */
export interface RuntimeAccessConfig {
  readonly workspaces: readonly GatewayWorkspace[];
  readonly runtimeHostRootPath?: string;
}

export interface RuntimeAccessEventSink {
  publish(event: Exclude<RemoteServerMessage, { type: "ready" }>): void;
  close(): void;
}

export interface RuntimeAccessEvents {
  receive(message: unknown): Promise<void>;
  /** Notify that the adapter's event stream has closed; its RPC transport may remain open. */
  close(): void;
}
