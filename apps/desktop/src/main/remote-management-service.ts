import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { RemotePermission } from "@pico/protocol/remote";
import type {
  RemoteConfiguration,
  RemoteConfigureInput,
  RemoteDevice,
  RemoteManagementSnapshot,
  RemotePending,
  RemotePairingQr,
} from "../preload/remote-management-contract.js";

export interface RemoteManagementDependencies {
  readonly preferencesDirectory: string;
  readonly readConfiguration: () => Promise<RemoteConfiguration>;
  readonly configure: (input: RemoteConfigureInput) => Promise<unknown>;
  readonly control: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  readonly spawn: () => Promise<void>;
  readonly makeQr: (payload: string) => string;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly startupAttempts?: number;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The service owns persistence/process transitions; Renderer never receives control credentials. */
export class RemoteManagementService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly preferencePath: string;
  constructor(private readonly dependencies: RemoteManagementDependencies) {
    this.preferencePath = join(dependencies.preferencesDirectory, "mobile-connection.json");
  }
  private async enabled(): Promise<boolean> {
    try {
      return record(JSON.parse(await readFile(this.preferencePath, "utf8"))).enabled === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
        return false;
      throw error;
    }
  }
  private async persist(enabled: boolean): Promise<void> {
    const temporary = `${this.preferencePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600 });
    await rename(temporary, this.preferencePath);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => undefined);
    return next;
  }
  async restore(): Promise<void> {
    if (await this.enabled()) await this.start();
  }
  async snapshot(): Promise<RemoteManagementSnapshot> {
    const [enabled, configuration] = await Promise.all([
      this.enabled(),
      this.dependencies.readConfiguration(),
    ]);
    let status: Record<string, unknown>;
    try {
      status = record(await this.dependencies.control("status"));
    } catch {
      return {
        enabled,
        running: false,
        configuration: this.publicConfiguration(configuration),
        devices: [],
        pending: [],
        ...(enabled ? { issue: "手机连接未运行，请重试开启。" } : {}),
      };
    }
    const [deviceResult, pendingResult] = await Promise.all([
      this.dependencies.control("devices.list"),
      this.dependencies.control("pair.pending"),
    ]);
    const relay = record(status.relay);
    const relayState = [
      "disabled",
      "connecting",
      "online",
      "reconnecting",
      "unauthorized",
      "error",
    ].includes(string(relay.state))
      ? (relay.state as RemoteManagementSnapshot["relayState"])
      : undefined;
    return {
      enabled,
      running: true,
      configuration: this.publicConfiguration(configuration),
      ...(relayState ? { relayState } : {}),
      ...(number(relay.lastConnectedAt) !== undefined
        ? { lastConnectedAt: number(relay.lastConnectedAt) }
        : {}),
      ...(number(record(status.runtime).lastReachableAt) !== undefined
        ? { runtimeLastReachableAt: number(record(status.runtime).lastReachableAt) }
        : {}),
      ...(relay.lastError || status.lastError
        ? { issue: "连接出现错误，请检查服务地址、网络或内测邀请后重试。" }
        : {}),
      devices: list(record(deviceResult).devices).map((value): RemoteDevice => {
        const device = record(value);
        return {
          id: string(device.id),
          name: string(device.name),
          permissions: list(device.permissions).filter(
            (permission): permission is RemotePermission => typeof permission === "string",
          ) as RemotePermission[],
          workspaceIds: list(device.workspaceIds).filter(
            (id): id is string => typeof id === "string",
          ),
          ...(number(device.revokedAt) !== undefined
            ? { revokedAt: number(device.revokedAt) }
            : {}),
        };
      }),
      pending: list(pendingResult).map((value): RemotePending => {
        const pending = record(value);
        return {
          pairingId: string(pending.pairingId),
          deviceName: string(pending.deviceName),
          expiresAt: number(pending.expiresAt) ?? 0,
        };
      }),
    };
  }
  private publicConfiguration(config: RemoteConfiguration): RemoteConfiguration {
    return {
      configured: config.configured,
      ...(config.connectionMode ? { connectionMode: config.connectionMode } : {}),
      ...(config.relayUrl ? { relayUrl: config.relayUrl } : {}),
      ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
      workspaces: config.workspaces.map(({ id, name, path }) => ({ id, name, path })),
    };
  }
  configure(input: RemoteConfigureInput): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      const before = await this.snapshot();
      if (before.running || before.enabled)
        throw new Error("请先停止手机连接，再修改服务或授权项目。");
      await this.dependencies.configure(input);
      return this.snapshot();
    });
  }
  start(): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      const config = await this.dependencies.readConfiguration();
      if (!config.configured) throw new Error("请先配置手机连接。");
      try {
        await this.dependencies.control("status");
      } catch {
        await this.dependencies.spawn();
        const delay =
          this.dependencies.delay ??
          ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        let ready = false;
        for (let attempt = 0; attempt < (this.dependencies.startupAttempts ?? 60); attempt++) {
          await delay(500);
          try {
            await this.dependencies.control("status");
            ready = true;
            break;
          } catch {
            /* startup handshake */
          }
        }
        if (!ready) throw new Error("手机连接启动超时，请检查配置和网络后重试。");
      }
      await this.persist(true);
      return this.snapshot();
    });
  }
  stop(): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      // Persist first so a concurrent Desktop exit cannot re-enable the gateway on restart.
      await this.persist(false);
      let running = false;
      try {
        await this.dependencies.control("status");
        running = true;
      } catch {
        /* already stopped */
      }
      if (running) {
        await this.dependencies.control("stop");
        const delay =
          this.dependencies.delay ??
          ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        for (let attempt = 0; attempt < 40; attempt++) {
          await delay(100);
          try {
            await this.dependencies.control("status");
          } catch {
            return this.snapshot();
          }
        }
        throw new Error("停止手机连接尚未完成，请稍后重试。");
      }
      return this.snapshot();
    });
  }
  async offer(): Promise<RemotePairingQr> {
    const offer = record(await this.dependencies.control("pair.offer"));
    const { pairingId, ...payload } = offer;
    if (typeof pairingId !== "string" || number(offer.expiresAt) === undefined)
      throw new Error("配对信息无效。");
    // Preserve the wire offer verbatim (including protocol version), but keep its short-lived secret out of status.
    const serialized = JSON.stringify(payload).replace(
      /[^\x00-\x7F]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return {
      pairingId,
      expiresAt: offer.expiresAt as number,
      qrDataUrl: this.dependencies.makeQr(serialized),
    };
  }
  manage(
    method: "pair.approve" | "pair.reject" | "devices.revoke",
    params: Record<string, unknown>,
  ): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      await this.dependencies.control(method, params);
      return this.snapshot();
    });
  }
}
