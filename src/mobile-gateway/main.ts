import { LocalRuntimeClient } from "../daemon/client.js";
import { createMobileProjectAuthorityPort, MobileProjectAuthority } from "./project-authority.js";
import { startMobileGateway } from "./server.js";

const client = new LocalRuntimeClient();
await client.connect();

const authority = new MobileProjectAuthority(createMobileProjectAuthorityPort(client));
const configuredToken = process.env["PICO_MOBILE_GATEWAY_TOKEN"];
const configuredPort = Number(process.env["PICO_MOBILE_GATEWAY_PORT"] ?? "47831");
const gateway = await startMobileGateway({
  authority,
  port: configuredPort,
  ...(configuredToken ? { token: configuredToken } : {}),
});

console.log("Pico Mobile Gateway 已启动");
console.log(`地址: ${gateway.origin}`);
console.log(`临时 Token: ${gateway.token}`);
console.log("仅供本机 iOS / Android 模拟器使用；按 Ctrl+C 停止。");

await new Promise<void>((resolve) => {
  const close = async () => {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await gateway.close().catch(() => undefined);
    client.close();
    resolve();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
});
