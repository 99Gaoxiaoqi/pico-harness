import { app } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  configureRelayGateway,
  defaultGatewayHome,
  readGatewayConfiguration,
  requestGatewayControl,
  type ActiveGatewayRuntime,
} from "@pico/remote-gateway/desktop";
import { resolveCanonicalPicoHome } from "@pico/pico-host/pico-paths";
import { resolveShell } from "@pico/runtime/host-shell";
import { RemoteManagementService } from "./remote-management-service.js";
import { pairingQrDataUrl } from "./pairing-qr.js";
import { createGatewaySystemSupervisor } from "./gateway-system-supervision.js";
import { captureGatewayPathEntries, gatewayProcessEnvironment } from "./gateway-supervisor.js";

export function createDesktopRemoteManagement(
  preferencesDirectory: string,
  preserveRegisteredEnvironment = false,
): RemoteManagementService {
  const home = app.isPackaged ? defaultGatewayHome() : `${defaultGatewayHome()}-development`;
  const activeRuntime = async (previous?: ActiveGatewayRuntime): Promise<ActiveGatewayRuntime> => ({
    schemaVersion: 1,
    buildId: app.getVersion(),
    executablePath: process.execPath,
    gatewayPath: join(__dirname, "gateway.cjs"),
    runtimeHome:
      preserveRegisteredEnvironment && previous ? previous.runtimeHome : resolveCanonicalPicoHome(),
    pathEntries:
      preserveRegisteredEnvironment && previous
        ? previous.pathEntries
        : captureGatewayPathEntries(),
    ...(process.platform === "win32"
      ? {
          shellPath:
            preserveRegisteredEnvironment && previous?.shellPath
              ? previous.shellPath
              : resolveShell(),
        }
      : {}),
  });
  return new RemoteManagementService({
    preferencesDirectory,
    gatewayHome: home,
    supervisor: createGatewaySystemSupervisor({ home, packaged: app.isPackaged }),
    activeRuntime,
    startupAttempts: process.platform === "win32" ? 180 : 60,
    readConfiguration: () => readGatewayConfiguration(home),
    configure: (input) =>
      configureRelayGateway({ ...input, runtimeHostRootPath: resolveCanonicalPicoHome() }, home),
    control: (method, params) => requestGatewayControl(home, method, params),
    makeQr: pairingQrDataUrl,
    spawn: async () => {
      const runtime = await activeRuntime();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(runtime.executablePath, [runtime.gatewayPath, "--home", home], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: gatewayProcessEnvironment(runtime),
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  });
}
