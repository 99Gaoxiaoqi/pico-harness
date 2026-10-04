import { randomUUID } from "node:crypto";
import type {
  RemotePermission,
  RemotePairingOffer,
  RemotePairingSubmitted,
  RemotePairingStatus,
} from "@pico/protocol/remote";
import { GatewayError } from "./errors.js";
import {
  hashSecret,
  newSecret,
  secretMatches,
  type GatewayConfig,
  type GatewayDevice,
  type GatewayState,
} from "./state.js";

const PAIRING_TTL = 5 * 60_000;
interface PairingEntry {
  readonly id: string;
  readonly offerHash: string;
  readonly expiresAt: number;
  state: "offered" | "pending" | "approved" | "rejected" | "completed";
  claimHash?: string;
  deviceName?: string;
  device?: GatewayDevice;
  token?: string;
  confirmation?: Promise<{ acknowledged: true }>;
}
export type PairingConfirmation = { deviceId: string; pairedAt: number };
export class GatewayPairings {
  private readonly entries = new Map<string, PairingEntry>();
  constructor(
    private readonly config: GatewayConfig,
    private readonly state: GatewayState,
    private readonly persist: (confirmation?: PairingConfirmation) => Promise<void>,
    private readonly now = Date.now,
  ) {}
  offer(): RemotePairingOffer & { pairingId: string } {
    this.expire();
    if (this.entries.size >= 16) throw new GatewayError("RATE_LIMITED", "配对请求过多", 429);
    const id = randomUUID();
    const secret = newSecret();
    const expiresAt = this.now() + PAIRING_TTL;
    this.entries.set(id, { id, offerHash: hashSecret(secret), expiresAt, state: "offered" });
    return {
      version: 1,
      gatewayId: this.state.gatewayId,
      publicUrl: this.config.publicUrl,
      ...(this.config.relay ? {relay:this.config.relay} : {}),
      secret,
      expiresAt,
      pairingId: id,
    };
  }
  submit(input: unknown): RemotePairingSubmitted {
    this.expire();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new GatewayError("INVALID_PARAMS", "配对请求无效");
    const params = input as Record<string, unknown>;
    if (
      params["version"] !== 1 ||
      params["gatewayId"] !== this.state.gatewayId ||
      !["ios", "android"].includes(String(params["platform"])) ||
      typeof params["secret"] !== "string" ||
      typeof params["deviceName"] !== "string" ||
      !params["deviceName"].trim() ||
      params["deviceName"].length > 128 ||
      Object.keys(params).some(
        (key) => !["version", "gatewayId", "secret", "deviceName", "platform"].includes(key),
      )
    )
      throw new GatewayError("INVALID_PARAMS", "配对请求无效");
    const entry = [...this.entries.values()].find(
      (pairing) =>
        pairing.state === "offered" && secretMatches(params["secret"] as string, pairing.offerHash),
    );
    if (!entry) throw new GatewayError("PAIRING_EXPIRED", "配对码无效、已使用或已过期", 410);
    const claimToken = newSecret();
    entry.claimHash = hashSecret(claimToken);
    entry.deviceName = params["deviceName"].trim();
    entry.state = "pending";
    return { pairingId: entry.id, pairingToken: claimToken, expiresAt: entry.expiresAt };
  }
  pending(): unknown[] {
    this.expire();
    return [...this.entries.values()]
      .filter((entry) => entry.state === "pending")
      .map((entry) => ({
        pairingId: entry.id,
        deviceName: entry.deviceName,
        expiresAt: entry.expiresAt,
      }));
  }
  async approve(
    pairingId: string,
    permissions: readonly RemotePermission[],
    workspaceIds: readonly string[],
  ): Promise<GatewayDevice> {
    this.expire();
    const entry = this.entries.get(pairingId);
    if (!entry || entry.state !== "pending" || !entry.deviceName)
      throw new GatewayError("PAIRING_EXPIRED", "没有等待批准的配对", 410);
    if (workspaceIds.some((id) => !this.config.workspaces.some((workspace) => workspace.id === id)))
      throw new GatewayError("INVALID_PARAMS", "授权工作区不存在");
    const token = newSecret();
    const device: GatewayDevice = {
      id: randomUUID(),
      name: entry.deviceName,
      tokenHash: hashSecret(token),
      permissions,
      workspaceIds,
      createdAt: this.now(),
    };
    this.state.devices.push(device);
    try {
      await this.persist();
    } catch (error) {
      this.state.devices.splice(this.state.devices.indexOf(device), 1);
      throw error;
    }
    entry.token = token;
    entry.device = device;
    entry.state = "approved";
    return device;
  }
  reject(pairingId: string): void {
    const entry = this.entries.get(pairingId);
    if (entry) {
      entry.state = "rejected";
      entry.token = undefined;
    }
  }
  claim(pairingId: string, claimToken: string): RemotePairingStatus {
    const entry = this.authenticated(pairingId, claimToken);
    if (entry.state === "approved" && entry.device && entry.token) {
      return {
        status: "approved",
        deviceId: entry.device.id,
        deviceToken: entry.token,
        permissions: entry.device.permissions,
        workspaceIds: entry.device.workspaceIds,
        publicUrl: this.config.publicUrl,
      ...(this.config.relay ? {relay:this.config.relay} : {}),
        gatewayId: this.state.gatewayId,
      };
    }
    return { status: entry.state === "pending" ? "pending" : "rejected" };
  }
  async acknowledge(pairingId: string, claimToken: string): Promise<{ acknowledged: true }> {
    const entry = this.authenticated(pairingId, claimToken);
    if (entry.confirmation) return entry.confirmation;
    if (entry.state === "completed") return { acknowledged: true };
    if (entry.state !== "approved") throw new GatewayError("CONFLICT", "配对尚未批准", 409);
    const device = entry.device;
    if (!device) throw new GatewayError("CONFLICT", "配对设备不存在", 409);
    const pairedAt = this.now();
    const confirmation = (async () => {
      await this.persist({ deviceId: device.id, pairedAt });
      device.pairedAt = pairedAt;
      entry.token = undefined;
      entry.state = "completed";
      return { acknowledged: true as const };
    })();
    entry.confirmation = confirmation;
    try {
      return await confirmation;
    } finally {
      entry.confirmation = undefined;
    }
  }
  clear(): void {
    this.entries.clear();
  }
  private authenticated(id: string, token: string): PairingEntry {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry || !entry.claimHash || !secretMatches(token, entry.claimHash))
      throw new GatewayError("PAIRING_EXPIRED", "配对领取已过期或认证失败", 410);
    return entry;
  }
  private expire(): void {
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= this.now()) {
        // Unacknowledged grants must not stay usable after delivery expires.
        if (entry.state === "approved" && entry.device) {
          entry.device.revokedAt = this.now();
          void this.persist().catch(() => undefined);
        }
        entry.token = undefined;
        this.entries.delete(id);
      }
  }
}
