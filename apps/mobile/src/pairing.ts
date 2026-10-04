import type {
  RemotePairingOffer,
  RemotePairingSubmitted,
  RemotePairingStatus,
} from "@pico/protocol/remote";
import type { SavedHost } from "./core.js";
import { parseRelayEndpoint, type RemoteRelayEndpoint } from "@pico/protocol/relay";

export const PENDING_PAIRING_KEY = "pico.mobile.pairing.v1";
type Approved = Extract<RemotePairingStatus, { status: "approved" }>;
export type PendingPairing = {
  version: 1;
  publicUrl: string;
  gatewayId: string;
  deviceName: string;
  submitted: RemotePairingSubmitted;
  approved?: Approved;
  relay?: RemoteRelayEndpoint;
};
export type PairingProgress = {
  publicUrl: string;
  deviceName: string;
  expiresAt: number;
  phase: "approval" | "confirmation";
  relay?: RemoteRelayEndpoint;
};
type SecurePort = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
export type PairingPort = {
  submit(offer: RemotePairingOffer, name: string): Promise<RemotePairingSubmitted>;
  status(
    url: string,
    claim: RemotePairingSubmitted,
    relay?: RemoteRelayEndpoint,
  ): Promise<RemotePairingStatus>;
  acknowledge(
    url: string,
    claim: RemotePairingSubmitted,
    relay?: RemoteRelayEndpoint,
  ): Promise<void>;
  verify(host: SavedHost, token: string): Promise<void>;
  install(host: SavedHost, token: string): Promise<void>;
  revoke(host: SavedHost, token: string): Promise<void>;
  forget(host: SavedHost): Promise<void>;
  changed(progress?: PairingProgress): void;
  now?: () => number;
  pause(): Promise<void>;
};
class PairingInterrupted extends Error {}
function hostFor(pending: PendingPairing): SavedHost {
  const approved = pending.approved!;
  return {
    id: `${pending.gatewayId}.${approved.deviceId}`,
    name: pending.publicUrl,
    baseUrl: pending.publicUrl,
    gatewayId: pending.gatewayId,
    deviceId: approved.deviceId,
    ...(pending.relay ? { relay: pending.relay } : {}),
  };
}
function endpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("保存的配对地址无效，请取消后重新配对");
  return url.origin;
}
function readPending(raw: string): PendingPairing {
  const value = JSON.parse(raw) as PendingPairing;
  if (
    value?.version !== 1 ||
    typeof value.publicUrl !== "string" ||
    typeof value.gatewayId !== "string" ||
    typeof value.deviceName !== "string" ||
    typeof value.submitted?.pairingId !== "string" ||
    typeof value.submitted.pairingToken !== "string" ||
    !Number.isFinite(value.submitted.expiresAt)
  )
    throw new Error("保存的配对记录无效，请取消后重新配对");
  endpoint(value.publicUrl);
  if (value.relay) {
    value.relay = parseRelayEndpoint(value.relay);
    if (
      value.relay.gatewayId !== value.gatewayId ||
      value.relay.relayUrl !== endpoint(value.publicUrl)
    )
      throw new Error("保存的中继配对身份无效，请取消后重新配对");
  }
  if (
    value.approved &&
    (value.approved.status !== "approved" ||
      typeof value.approved.deviceToken !== "string" ||
      typeof value.approved.deviceId !== "string" ||
      value.approved.gatewayId !== value.gatewayId ||
      endpoint(value.approved.publicUrl) !== endpoint(value.publicUrl))
  )
    throw new Error("保存的配对身份无效，请取消后重新配对");
  return value;
}
const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

/** A single secure claim survives backgrounding and lost acknowledgement replies. */
export class RecoverablePairing {
  private epoch = 0;
  private cancellation = 0;
  private starting = false;
  private startingGatewayId?: string;
  private foreground = true;
  private tail: Promise<unknown> = Promise.resolve();
  private operation?: { epoch: number; promise: Promise<SavedHost | undefined> };
  constructor(
    private readonly storage: SecurePort,
    private readonly port: PairingPort,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(fn);
    this.tail = result;
    return result;
  }
  private assertCurrent(epoch: number) {
    if (epoch !== this.epoch || !this.foreground) throw new PairingInterrupted();
  }
  private async read() {
    const raw = await this.storage.getItemAsync(PENDING_PAIRING_KEY);
    return raw ? readPending(raw) : undefined;
  }
  private notify(pending?: PendingPairing) {
    this.port.changed(
      pending
        ? {
            publicUrl: pending.publicUrl,
            deviceName: pending.deviceName,
            expiresAt: pending.submitted.expiresAt,
            phase: pending.approved ? "confirmation" : "approval",
            ...(pending.relay ? { relay: pending.relay } : {}),
          }
        : undefined,
    );
  }
  async inspectHostId(): Promise<string | undefined> {
    const pending = await this.serial(() => this.read());
    return pending?.approved ? hostFor(pending).id : undefined;
  }
  async inspectGatewayId(): Promise<string | undefined> {
    return (await this.serial(() => this.read()))?.gatewayId ?? this.startingGatewayId;
  }
  setForeground(active: boolean) {
    if (this.foreground === active) return;
    this.foreground = active;
    ++this.epoch;
  }
  async start(offer: RemotePairingOffer, name: string): Promise<SavedHost | undefined> {
    if (!this.foreground) throw new Error("请回到前台后配对");
    if (this.starting) throw new Error("正在提交配对申请");
    this.starting = true;
    this.startingGatewayId = offer.gatewayId;
    const cancellation = this.cancellation;
    try {
      if (this.operation || (await this.serial(() => this.read())))
        throw new Error("已有待确认配对，请继续或取消原申请");
      ++this.epoch;
      const submitted = await this.port.submit(offer, name);
      const pending: PendingPairing = {
        version: 1,
        publicUrl: endpoint(offer.publicUrl),
        gatewayId: offer.gatewayId,
        deviceName: name,
        submitted,
        ...(offer.relay ? { relay: parseRelayEndpoint(offer.relay) } : {}),
      };
      await this.serial(async () => {
        if (cancellation !== this.cancellation) throw new PairingInterrupted();
        // A reply received in the background must retain the claim for next foreground.
        await this.storage.setItemAsync(PENDING_PAIRING_KEY, JSON.stringify(pending));
      });
      if (cancellation !== this.cancellation) return undefined;
      this.notify(pending);
      return this.resume();
    } catch (error) {
      if (error instanceof PairingInterrupted || cancellation !== this.cancellation)
        return undefined;
      throw error;
    } finally {
      this.starting = false;
      this.startingGatewayId = undefined;
    }
  }
  resume(): Promise<SavedHost | undefined> {
    const epoch = this.epoch;
    if (!this.foreground) return Promise.resolve(undefined);
    if (this.operation?.epoch === epoch) return this.operation.promise;
    const promise = this.run(epoch).catch((error: unknown) => {
      if (error instanceof PairingInterrupted) return undefined;
      throw error;
    });
    this.operation = { epoch, promise };
    void promise
      .finally(() => {
        if (this.operation?.promise === promise) this.operation = undefined;
      })
      .catch(() => undefined);
    return promise;
  }
  private async run(epoch: number): Promise<SavedHost | undefined> {
    let pending = await this.serial(() => this.read());
    if (!pending) return undefined;
    this.assertCurrent(epoch);
    this.notify(pending);
    const now = this.port.now ?? Date.now;
    while (!pending.approved && now() < pending.submitted.expiresAt) {
      let status: RemotePairingStatus;
      try {
        status = await this.port.status(pending.publicUrl, pending.submitted, pending.relay);
      } catch (error) {
        this.assertCurrent(epoch);
        if (code(error) === "PAIRING_EXPIRED") return this.expired(epoch);
        throw error;
      }
      this.assertCurrent(epoch);
      if (status.status === "approved") {
        if (
          status.gatewayId !== pending.gatewayId ||
          endpoint(status.publicUrl) !== endpoint(pending.publicUrl)
        )
          throw new Error("配对结果的电脑身份或地址不匹配");
        pending = { ...pending, approved: status };
        const snapshot = pending;
        await this.serial(async () => {
          this.assertCurrent(epoch);
          await this.storage.setItemAsync(PENDING_PAIRING_KEY, JSON.stringify(snapshot));
        });
        this.assertCurrent(epoch);
        this.notify(pending);
      } else if (status.status !== "pending") {
        await this.expired(epoch);
      } else {
        await this.port.pause();
        this.assertCurrent(epoch);
      }
    }
    if (!pending.approved) return this.expired(epoch);
    const host = hostFor(pending);
    let verified = false;
    if (now() < pending.submitted.expiresAt) {
      try {
        await this.port.acknowledge(pending.publicUrl, pending.submitted, pending.relay);
      } catch (error) {
        this.assertCurrent(epoch);
        // Authentication also proves the gateway durably accepted the original ack.
        try {
          await this.port.verify(host, pending.approved.deviceToken);
          verified = true;
        } catch (verification) {
          if (
            ["PAIRING_EXPIRED", "CONFLICT"].includes(String(code(error))) &&
            ["DEVICE_REVOKED", "UNAUTHORIZED", "INVALID_AUTH"].includes(String(code(verification)))
          )
            return this.expired(epoch);
          throw new Error("配对确认结果未确认，请恢复连接后继续原申请", { cause: verification });
        }
      }
    }
    this.assertCurrent(epoch);
    try {
      if (!verified) await this.port.verify(host, pending.approved.deviceToken);
    } catch (error) {
      this.assertCurrent(epoch);
      if (["DEVICE_REVOKED", "UNAUTHORIZED", "INVALID_AUTH"].includes(String(code(error))))
        return this.expired(epoch);
      throw error;
    }
    await this.serial(async () => {
      this.assertCurrent(epoch);
      await this.port.install(host, pending!.approved!.deviceToken);
      this.assertCurrent(epoch);
      await this.storage.deleteItemAsync(PENDING_PAIRING_KEY);
    });
    this.assertCurrent(epoch);
    this.notify();
    return host;
  }
  private async expired(epoch: number): Promise<never> {
    await this.serial(async () => {
      this.assertCurrent(epoch);
      const pending = await this.read();
      if (pending?.approved) await this.port.forget(hostFor(pending));
      await this.storage.deleteItemAsync(PENDING_PAIRING_KEY);
    });
    this.notify();
    throw Object.assign(new Error("配对已过期或设备未获确认，请在电脑重新生成二维码"), {
      code: "PAIRING_EXPIRED",
    });
  }
  async cancel(): Promise<{ remoteRevocationUnconfirmed: boolean }> {
    ++this.epoch;
    ++this.cancellation;
    let remoteRevocationUnconfirmed = false;
    const pending = await this.serial(() => this.read()).catch(() => {
      remoteRevocationUnconfirmed = true;
      return undefined;
    });
    if (pending?.approved) {
      const host = hostFor(pending);
      try {
        await this.port.revoke(host, pending.approved.deviceToken);
      } catch {
        remoteRevocationUnconfirmed = true;
      }
      await this.serial(() => this.port.forget(host));
    }
    await this.serial(() => this.storage.deleteItemAsync(PENDING_PAIRING_KEY));
    this.notify();
    return { remoteRevocationUnconfirmed };
  }
}
