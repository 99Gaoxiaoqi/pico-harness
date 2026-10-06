import { join } from "node:path";
import {
  defaultGatewayHome,
  readGatewayConfiguration,
  startConfiguredRemoteGateway,
} from "@pico/remote-gateway/desktop";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--home" || !args[1])
    throw new Error("Invalid gateway arguments");
  const home = args[1] ?? defaultGatewayHome();
  const config = await readGatewayConfiguration(home);
  const gateway = await startConfiguredRemoteGateway({
    home,
    ...(process.env.PICO_GATEWAY_BUILD_ID ? { buildId: process.env.PICO_GATEWAY_BUILD_ID } : {}),
    createRuntimeClient: (deviceId) =>
      new LocalRuntimeClient({
        ...(config.runtimeHostRootPath ? { runtimeHostRootPath: config.runtimeHostRootPath } : {}),
        candidateEntrypoint: join(__dirname, "daemon.cjs"),
        terminalOwnerId: `remote:${deviceId}`,
        surface: "inspect",
      }),
  });
  const close = (): void => {
    void gateway.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
void main().catch(() => {
  process.exitCode = 1;
});
