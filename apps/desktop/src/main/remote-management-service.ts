import { waitForDelay } from "@pico/runtime/deadline";
import { access } from "node:fs/promises";
import {
  readGatewayServiceState,
  setGatewayDesiredRunning,
  beginGatewayMaintenance,
  finishGatewayMaintenance,
  readActiveGatewayRuntime,
  writeActiveGatewayRuntime,
  type ActiveGatewayRuntime,
} from "@pico/remote-gateway/desktop";
import type { GatewaySystemSupervisor } from "./gateway-system-supervision.js";
import { join } from "node:path";
import type { RemotePermission } from "@pico/protocol/remote";
import type {
  RemoteConfiguration,
  RemoteConfigureInput,
  RemoteDevice,
  RemoteManagementSnapshot,
  RemotePending,
  RemotePairingQr,
  RemoteSupervisionSnapshot,
} from "../preload/remote-management-contract.js";

export interface RemoteManagementDependencies {
  readonly preferencesDirectory: string;
  readonly gatewayHome?: string;
  readonly supervisor?: GatewaySystemSupervisor;
  readonly activeRuntime?: (previous?: ActiveGatewayRuntime) => Promise<ActiveGatewayRuntime>;
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
  private startupTimedOut = false;
  private readonly preferencePath: string;
  constructor(private readonly dependencies: RemoteManagementDependencies) {
    this.preferencePath = join(dependencies.preferencesDirectory, "mobile-connection.json");
  }
  private get home(): string {
    return this.dependencies.gatewayHome ?? this.dependencies.preferencesDirectory;
  }
  private async serviceState() {
    return readGatewayServiceState(this.home, this.preferencePath);
  }
  private async registerRuntime(): Promise<void> {
    if (!this.dependencies.activeRuntime) return;
    const runtime = await this.dependencies.activeRuntime(
      await readActiveGatewayRuntime(this.home),
    );
    await writeActiveGatewayRuntime(this.home, runtime);
    await this.dependencies.supervisor?.register(runtime);
  }
  private async supervision(status?: Record<string, unknown>): Promise<RemoteSupervisionSnapshot> {
    const state = await this.serviceState();
    const runtime = await readActiveGatewayRuntime(this.home);
    const backend = this.dependencies.supervisor?.backend ?? "none";
    const registered = (await this.dependencies.supervisor?.registered()) ?? false;
    let missing = false;
    if (runtime) {
      try {
        await Promise.all([access(runtime.executablePath), access(runtime.gatewayPath)]);
      } catch {
        missing = true;
      }
    } else if (backend !== "none" && state.desiredRunning) missing = true;
    const issueCode = missing
      ? "installation_missing"
      : backend !== "none" && state.desiredRunning && !registered
        ? "registration_missing"
        : this.startupTimedOut && state.desiredRunning && !status
          ? "startup_timeout"
          : undefined;
    return {
      backend,
      desiredRunning: state.desiredRunning,
      registration: backend === "none" ? "unsupported" : registered ? "registered" : "missing",
      phase: issueCode
        ? "blocked"
        : state.maintenance
          ? "updating"
          : status
            ? "running"
            : state.desiredRunning
              ? "recovering"
              : "stopped",
      scope: backend === "none" ? "none" : "user-session",
      ...(runtime ? { registeredBuildId: runtime.buildId } : {}),
      ...(typeof status?.buildId === "string" ? { runningBuildId: status.buildId } : {}),
      ...(state.lastExit ? { lastExit: state.lastExit } : {}),
      ...(issueCode ? { issueCode } : {}),
    };
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => undefined);
    return next;
  }
  restore(): Promise<void> {
    return this.serialize(async () => {
      let state = await this.serviceState();
      if (!state.desiredRunning && !(await readActiveGatewayRuntime(this.home))) return;
      await this.registerRuntime();
      if (state.maintenance)
        await finishGatewayMaintenance(this.home, state.maintenance.generation);
      state = await this.serviceState();
      if (!state.desiredRunning) {
        await this.dependencies.supervisor?.disable();
        return;
      }
      await this.ensureRunning();
    });
  }
  async snapshot(): Promise<RemoteManagementSnapshot> {
    const [enabled, configuration] = await Promise.all([
      this.serviceState().then((state) => state.desiredRunning),
      this.dependencies.readConfiguration(),
    ]);
    let status: Record<string, unknown>;
    try {
      status = record(await this.dependencies.control("status"));
    } catch {
      return {
        enabled,
        running: false,
        supervision: await this.supervision(),
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
      supervision: await this.supervision(status),
      configuration: this.publicConfiguration(configuration),
      ...(relayState ? { relayState } : {}),
      ...(number(relay.lastConnectedAt) !== undefined
        ? { lastConnectedAt: number(relay.lastConnectedAt) }
        : {}),
      ...(number(record(status.runtime).lastReachableAt) !== undefined
        ? { runtimeLastReachableAt: number(record(status.runtime).lastReachableAt) }
        : {}),
      ...(relayState === "unauthorized"
        ? { issue: "电脑尚未完成服务绑定或已解除，请完成部署初始化。" }
        : relay.lastError || status.lastError
          ? { issue: "连接出现错误，请检查服务地址、网络或部署绑定后重试。" }
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
  private async ensureRunning(): Promise<void> {
    this.startupTimedOut = false;
    try {
      await this.dependencies.control("status");
      return;
    } catch {
      /* authenticated control absent */
    }
    if (this.dependencies.supervisor && this.dependencies.supervisor.backend !== "none") {
      await this.dependencies.supervisor.enable();
      await this.dependencies.supervisor.launch();
    } else await this.dependencies.spawn();
    const delay = this.dependencies.delay ?? waitForDelay;
    for (let attempt = 0; attempt < (this.dependencies.startupAttempts ?? 60); attempt++) {
      await delay(500);
      try {
        await this.dependencies.control("status");
        return;
      } catch {
        /* startup handshake */
      }
      if (!(await this.serviceState()).desiredRunning) return;
    }
    this.startupTimedOut = true;
    throw new Error("手机连接启动超时，请检查配置和网络后重试。");
  }
  start(): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      const config = await this.dependencies.readConfiguration();
      if (!config.configured) throw new Error("请先配置手机连接。");
      await this.serviceState();
      await this.registerRuntime();
      // Registration must succeed before accepting a durable running intent.
      await setGatewayDesiredRunning(this.home, true);
      await this.ensureRunning();
      return this.snapshot();
    });
  }
  private async waitForStopped(): Promise<void> {
    const delay = this.dependencies.delay ?? waitForDelay;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await this.dependencies.control("status");
      } catch {
        return;
      }
      await delay(100);
    }
    throw new Error("停止手机连接尚未完成，请稍后重试。");
  }
  stop(): Promise<RemoteManagementSnapshot> {
    return this.serialize(async () => {
      await setGatewayDesiredRunning(this.home, false);
      let disableError: unknown;
      try {
        await this.dependencies.supervisor?.disable();
      } catch (error) {
        disableError = error;
      }
      let running = false;
      try {
        await this.dependencies.control("status");
        running = true;
      } catch {
        /* already stopped */
      }
      if (running) {
        await this.dependencies.control("stop");
        await this.waitForStopped();
      }
      if (disableError) throw disableError;
      return this.snapshot();
    });
  }
  async uninstall(): Promise<void> {
    try {
      await this.stop();
    } finally {
      await this.dependencies.supervisor?.unregister();
    }
  }
  prepareForUpdate(): Promise<void> {
    return this.serialize(async () => {
      let running = false;
      try {
        await this.dependencies.control("status");
        running = true;
      } catch {
        /* offline gateway still needs maintenance fence */
      }
      if (running) {
        await this.dependencies.control("stopForUpdate");
        await this.waitForStopped();
      } else
        await beginGatewayMaintenance(
          this.home,
          (await readActiveGatewayRuntime(this.home))?.buildId,
        );
    });
  }
  async offer(): Promise<RemotePairingQr> {
    const offer = record(await this.dependencies.control("pair.offer"));
    const { pairingId, ...payload } = offer;
    if (typeof pairingId !== "string" || number(offer.expiresAt) === undefined)
      throw new Error("配对信息无效。");
    // Preserve the wire offer verbatim (including protocol version), but keep its short-lived secret out of status.
    const serialized = JSON.stringify(payload).replace(
      /[\u0080-\uFFFF]/g,
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
