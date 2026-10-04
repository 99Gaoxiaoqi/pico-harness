import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  configureRelayGateway,
  defaultGatewayHome,
  readGatewayConfiguration,
  requestGatewayControl,
} from "@pico/remote-gateway/desktop";
import { resolveCanonicalPicoHome } from "@pico/pico-host/pico-paths";
import { RemoteManagementService } from "./remote-management-service.js";
import { pairingQrDataUrl } from "./pairing-qr.js";

export function createDesktopRemoteManagement(
  preferencesDirectory: string,
): RemoteManagementService {
  const home = defaultGatewayHome();
  return new RemoteManagementService({
    preferencesDirectory,
    readConfiguration: () => readGatewayConfiguration(home),
    configure: (input) =>
      configureRelayGateway({ ...input, runtimeHostRootPath: resolveCanonicalPicoHome() }, home),
    control: (method, params) => requestGatewayControl(home, method, params),
    makeQr: pairingQrDataUrl,
    spawn: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [join(__dirname, "gateway.cjs"), "--home", home], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
  });
}
