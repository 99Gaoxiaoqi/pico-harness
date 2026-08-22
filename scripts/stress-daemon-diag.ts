/**
 * daemon 间歇死锁诊断压测（2026-08-16，遗留高优先项）。
 *
 * 背景：多轮高频 e2e 下 daemon 连接 terminal（RUNTIME_DISCONNECTED），稍后
 * ping 可恢复但窗口不定。两个竞争假设无法从外部区分：
 *   A. daemon 进程崩溃（未捕获 rejection；此前 stderr 全丢）→ connectOrSpawn
 *      重生 → "可恢复"。证据 = registration pid 变化 + candidate-logs 崩溃栈。
 *   B. daemon 进程活着但连接/写路径卡死（writer 背压等）→ 稍后自行解卡。
 *      证据 = pid 不变 + kernel 环形日志 + 无 stderr。
 *
 * 本脚本用死端点模型（无 LLM 依赖）以 e2e 同款形态高频轰击真 daemon：
 * 每轮新客户端连接（模拟 e2e 场景级客户端生灭）+ 并发 ping + session.send
 * 全链路 + 事件订阅；全程采样 registration pid；断连发生时记录窗口；结束时
 * 倒出 candidate-logs（stderr 落盘基础设施）+ host.diagnostics.query 环形日志。
 *
 * 运行：node --import tsx --import ./src/tui/preload-env.ts scripts/stress-daemon-diag.ts [rounds]
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  connectOrSpawnRuntimeHost,
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "../src/daemon/index.js";
import { UserConfigStore } from "../src/input/user-config-store.js";
import { ClientSessionRuntime } from "../src/tui/client-session-runtime.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";

const DEAD_ENDPOINT = "http://127.0.0.1:9";
const ROUNDS = Number(process.argv[2] ?? 20);

interface FailureRecord {
  round: number;
  at: string;
  phase: string;
  code: string;
  message: string;
  pidAtFailure?: number;
}

const failures: FailureRecord[] = [];
const pidTimeline: { at: string; pid: number | undefined; note: string }[] = [];
const startedAt = performance.now();

async function samplePid(note: string): Promise<number | undefined> {
  try {
    const capability = await resolveStorageRoot({
      path: process.env.PICO_HOME!,
      kind: "interactive",
    });
    const registration = await readHostRegistration(
      join(resolveRootControlNamespace(), capability.rootId),
    );
    pidTimeline.push({ at: new Date().toISOString(), pid: registration?.pid, note });
    return registration?.pid;
  } catch {
    pidTimeline.push({ at: new Date().toISOString(), pid: undefined, note: `${note} (无注册)` });
    return undefined;
  }
}

async function trackFailure(round: number, phase: string, error: unknown): Promise<void> {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code: unknown }).code)
      : "?";
  const message = error instanceof Error ? error.message : String(error);
  const pidAtFailure = await samplePid(`failure@r${round}`);
  failures.push({ round, at: new Date().toISOString(), phase, code, message, pidAtFailure });
  console.log(`[FAIL] r${round} ${phase}: ${code} ${message}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-diag-"));
  const picoHome = join(root, "pico-home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspaceDir = await realpath(workspaceSeed);
  process.env.PICO_HOME = picoHome;
  await configureDeadEndpointModel(picoHome);

  // 长驻基准客户端：全程并发 ping（探测"其他连接不受影响"还是"整宿主卡死"）。
  const baselineClient = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  let baselinePingStop = false;
  const baselinePing = (async () => {
    while (!baselinePingStop) {
      try {
        await baselineClient.request("runtime.ping", {});
      } catch (error) {
        await trackFailure(-1, "baseline-ping", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();

  const pidBefore = await samplePid("start");

  for (let round = 1; round <= ROUNDS; round += 1) {
    const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
    try {
      await client.request("workspace.register", { workspacePath: workspaceDir });
      await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });
      const reporter = new TuiReporter();
      const runtime = new ClientSessionRuntime({
        client,
        workspacePath: workspaceDir,
        reporter,
      });
      await runtime.start();
      // 两轮并发写（高频 e2e 形态：连接生灭 + 写 + 事件流 + teardown）。
      for (let turn = 1; turn <= 2; turn += 1) {
        try {
          const accepted = await runtime.sendText(`diag r${round} t${turn}`);
          if (!accepted) throw new Error("sendText 未被接受");
        } catch (error) {
          await trackFailure(round, `sendText@t${turn}`, error);
        }
        const settled = await waitForCondition(
          () =>
            reporter
              .getProjection()
              .entries.some(
                ({ entry }) => entry.kind === "run-boundary" && entry.status !== "running",
              ),
          90_000,
        );
        if (!settled) await trackFailure(round, `runSettle@t${turn}`, new Error("run 90s 未终态"));
        await waitForCondition(() => !runtime.running, 30_000);
      }
      runtime.dispose();
    } catch (error) {
      await trackFailure(round, "round-body", error);
    } finally {
      // 场景级客户端销毁（destroy 语义，非优雅 drain）——e2e 每场景独立客户端。
      client.close();
    }
    await samplePid(`after-r${round}`);
  }

  const pidAfter = await samplePid("end");
  baselinePingStop = true;
  await baselinePing;
  baselineClient.close();

  // ---- 报告 ----
  console.log("\n===== 诊断报告 =====");
  console.log(`rounds=${ROUNDS} duration=${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(
    `pid before=${pidBefore} after=${pidAfter} ${pidBefore === pidAfter ? "（未重生：崩溃假设排除）" : "（重生过：崩溃假设命中）"}`,
  );
  const respawns = countPidChanges();
  console.log(`pid 变化次数=${respawns}`);
  console.log(`failures=${failures.length}`);
  for (const failure of failures) {
    console.log(`  r${failure.round} ${failure.phase} ${failure.code}: ${failure.message}`);
  }

  await dumpCandidateLogs(picoHome);
  await dumpKernelRingLog(picoHome);

  // 清理：杀 daemon + 删临时目录。
  await killDaemonFor(picoHome);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log("\n完成。退出码 = failures 数 > 0 ? 2 : 0");
  process.exitCode = failures.length > 0 ? 2 : 0;
}

async function configureDeadEndpointModel(picoHome: string): Promise<void> {
  const store = new UserConfigStore({ picoHome });
  const current = await store.read();
  await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "daemon-diag/diag-model" },
      providers: {
        "daemon-diag": {
          protocol: "openai",
          baseURL: DEAD_ENDPOINT,
          apiKeyEnv: "PICO_DAEMON_DIAG_API_KEY",
          apiKey: "diag-key",
          models: ["diag-model"],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: current.revision },
  );
}

function countPidChanges(): number {
  let changes = 0;
  let last: number | undefined;
  for (const entry of pidTimeline) {
    if (entry.pid === undefined) continue;
    if (last !== undefined && entry.pid !== last) changes += 1;
    last = entry.pid;
  }
  return changes;
}

async function dumpCandidateLogs(picoHome: string): Promise<void> {
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    const logDir = join(resolveRootControlNamespace(), capability.rootId, "candidate-logs");
    const files = await readdir(logDir);
    console.log(`\ncandidate-logs（${logDir}）：${files.length} 个文件`);
    for (const name of files) {
      const contents = await readFile(join(logDir, name), "utf8");
      console.log(`--- ${name} (${contents.length}B) ---`);
      console.log(contents.slice(0, 4000));
    }
  } catch (error) {
    console.log(`candidate-logs 读取失败: ${error instanceof Error ? error.message : error}`);
  }
}

async function dumpKernelRingLog(picoHome: string): Promise<void> {
  try {
    const result = await connectOrSpawnRuntimeHost({
      rootPath: picoHome,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "daemon-diag-dump",
      connectTimeoutMs: 5000,
      handshakeTimeoutMs: 5000,
    });
    if (result.kind !== "connected") {
      console.log(`kernel 环形日志拉取失败：${result.kind}`);
      return;
    }
    const diagnostics = await result.connection.request("host.diagnostics.query", {}, 5000);
    console.log("\nhost.diagnostics.logs（kernel 环形日志）：");
    for (const entry of diagnostics.logs ?? []) console.log(`  ${JSON.stringify(entry)}`);
    await result.connection.close();
  } catch (error) {
    console.log(`kernel 环形日志拉取失败: ${error instanceof Error ? error.message : error}`);
  }
}

async function killDaemonFor(picoHome: string): Promise<void> {
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    const registration = await readHostRegistration(
      join(resolveRootControlNamespace(), capability.rootId),
    );
    if (registration) process.kill(registration.pid);
  } catch {
    // 无 daemon / 已退出。
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

main().catch((error) => {
  console.error("diag 脚本自身失败:", error);
  process.exitCode = 1;
});
