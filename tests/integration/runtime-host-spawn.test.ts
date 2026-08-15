import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectOrSpawnRuntimeHost,
  connectOrSpawnRuntimeHostWithDependencies,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from "../../packages/runtime-host/src/index.js";
import { launchDetachedRuntimeHostCandidate } from "../../packages/runtime-host/src/client/launcher.js";

test("runtime-host spawn: connectOrSpawnRuntimeHost launches a detached candidate and connects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  const result = await connectOrSpawnRuntimeHost({
    rootPath: root,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "spawn-test-client",
    electionDeadlineMs: 30000,
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    // 短 idle grace：connection.close() 后 candidate 无连接，1s 内自动 idle 退出。
    idleGraceMs: 1000,
  });

  assert.equal(result.kind, "connected", `期望 connected，实际 ${JSON.stringify(result.kind)}`);
  if (result.kind !== "connected") return;

  const connection = result.connection;
  const status = await connection.request("host.status", {}, 5000);
  assert.equal(status.state, "ready");
  assert.equal(typeof status.hostEpoch, "string");
  await connection.close();
});

test("runtime-host spawn: election window caps candidate launches (A6)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawncap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 预创建 storage root marker，稳定 rootId。
  await resolveStorageRoot({ path: root, kind: "interactive" });

  // 假 launcher：spawn 立即"成功"，但没有任何真实 host 会落定——选举循环只能
  // 持续轮询到 deadline。慢冷启动环境（候选 19-31s 才就绪）此前会按 250ms 间隔
  // 在整个窗口内堆积几十个在途候选；封顶后同窗口最多 3 个。
  let launches = 0;
  const result = await connectOrSpawnRuntimeHostWithDependencies(
    {
      rootPath: root,
      surface: "tui",
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
      clientInstanceId: "spawn-cap-test-client",
      electionDeadlineMs: 1500,
      maxCandidateLaunches: 3,
    },
    {
      launchCandidate: () => {
        launches += 1;
        return { spawned: Promise.resolve({ pid: 40_000 + launches }) };
      },
      random: () => 0.5,
    },
  );

  assert.equal(result.kind, "failed", "无真实候选时选举应失败");
  assert.equal(result.reason, "startup_timeout");
  assert.equal(launches, 3, `候选 launch 数应封顶在 3，实际 ${launches}`);
});

test("runtime-host spawn: candidate stdout/stderr is persisted to the log directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-spawnlog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logDirectory = join(root, "candidate-logs");
  // 一个往 stderr/stdout 各写一行就退出的脚本候选：死锁/崩溃取证依赖的正是
  // 这条"子进程输出必须落盘"的链路（此前 stdio: 'ignore' 全部丢弃）。
  const scriptPath = join(root, "noisy-candidate.mjs");
  writeFileSync(
    scriptPath,
    "console.error('candidate stderr evidence');\nconsole.log('candidate stdout evidence');\n",
  );

  const launch = launchDetachedRuntimeHostCandidate({
    rootPath: root,
    expectedRootId: "0".repeat(64),
    executable: process.execPath,
    entrypoint: scriptPath,
    logDirectory,
  });
  const attempt = await launch.spawned;

  assert.ok(attempt.logFile, "attempt 应报告日志文件路径");
  assert.ok(
    attempt.logFile.startsWith(logDirectory),
    `日志应在指定目录内，实际 ${attempt.logFile}`,
  );
  // detached 子进程异步写入；轮询到双行证据（带 10s 上限）。
  const deadline = Date.now() + 10_000;
  let contents = "";
  while (Date.now() < deadline) {
    contents = readFileSync(attempt.logFile, "utf8");
    if (
      contents.includes("candidate stderr evidence") &&
      contents.includes("candidate stdout evidence")
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(contents, /# candidate launch/, "日志应带 launch 头部（空日志也证明 launch 发生）");
  assert.match(contents, /candidate stderr evidence/);
  assert.match(contents, /candidate stdout evidence/);
});
