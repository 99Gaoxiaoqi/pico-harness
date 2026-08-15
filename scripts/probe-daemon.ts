// 诊断探针：连真 .pico daemon，ping + 拉环形日志 + workspace 状态（尽力而为）。
import { LocalRuntimeClient } from "../src/daemon/index.js";
import { connectOrSpawnRuntimeHost, RUNTIME_HOST_PROTOCOL_VERSION } from "@pico/runtime-host";

const ROOT = "C:\\Users\\gaoxiaoqi\\.pico";

async function main() {
  console.log("== kernel 层探针 ==");
  try {
    const result = await connectOrSpawnRuntimeHost({
      rootPath: ROOT,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "diag-probe",
      connectTimeoutMs: 3000,
      handshakeTimeoutMs: 3000,
    });
    if (result.kind !== "connected") {
      console.log("connectOrSpawn:", result.kind, JSON.stringify(result));
    } else {
      console.log("kernel 连接成功，拉诊断…");
      const diag = await result.connection.request("host.diagnostics.query", {}, 5000);
      for (const entry of diag.logs ?? []) console.log(" ", JSON.stringify(entry));
      const status = await result.connection.request("host.status", {}, 5000);
      console.log("host.status:", JSON.stringify(status));
      await result.connection.close();
    }
  } catch (error) {
    console.log("kernel 探针失败:", error instanceof Error ? error.message : error);
  }

  console.log("== 业务层探针（runtime.ping + workspace.list）==");
  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: ROOT });
  try {
    const t0 = Date.now();
    await client.request("runtime.ping", {});
    console.log(`runtime.ping OK (${Date.now() - t0}ms)`);
    const workspaces = await client.request("workspace.list", {});
    console.log("workspace.list:", JSON.stringify(workspaces).slice(0, 2000));
  } catch (error) {
    console.log(
      "业务探针失败:",
      error instanceof Error ? `${String(error)} ${error.message}` : error,
    );
  } finally {
    client.close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
