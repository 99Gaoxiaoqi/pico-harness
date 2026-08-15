import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "../../src/daemon/index.js";

/**
 * daemon 对"残留注册"的容忍（2026-08-16 真机事故回归）：
 *
 * e2e/客户端崩溃会留下指向临时目录的 workspace 注册（用户真 home 实测累积
 * 118 条，其中 54 个临时目录在磁盘上真实存活——测试进程被杀时 rm 清理没跑）。
 * 修复前：listWorkspaces 对每条存活注册物化 runtime，大量残留把单次
 * workspace.list 推过 kernel 操作 deadline → 连接整条拆断
 * （RUNTIME_DISCONNECTED）；performReconcileRegisteredWorkspaces 又给每条
 * 注册物化 cron runtime → 定时器/recovery 风暴 → 常驻 daemon 持续忙循环。
 *
 * 行为契约：缺失目录由注册表 list() 过滤（既有语义，本测试固化）；list 本身
 * 不因残留报错/拆连接；存活工作区正常列出。desktop-runtime-service 的
 * existsSync 降级分支是过滤与物化之间的竞态护栏。
 */
test("workspace.list tolerates registrations whose directory no longer exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-stale-ws-"));
  const picoHome = join(root, "pico-home");
  const liveSeed = join(root, "live-workspace");
  const ghostSeed = join(root, "ghost-workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(liveSeed, { recursive: true });
  await mkdir(ghostSeed, { recursive: true });
  const liveDir = await realpath(liveSeed);
  const ghostDir = await realpath(ghostSeed);
  process.env.PICO_HOME = picoHome;
  process.env.LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:9";
  t.after(() => {
    delete process.env.PICO_HOME;
  });
  t.after(async () => {
    await killDaemonFor(picoHome);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  t.after(() => client.close());
  await client.request("runtime.ping", {});
  await client.request("workspace.register", { workspacePath: liveDir });
  await client.request("workspace.register", { workspacePath: ghostDir });

  // 注册后删除目录：与真实事故同款的残留形态。
  await rm(ghostSeed, { recursive: true, force: true });

  const { workspaces } = await client.request("workspace.list", {});
  const entries = workspaces as unknown as { workspacePath: string }[];
  assert.ok(
    !entries.some((entry) => entry.workspacePath === ghostDir),
    "缺失目录的注册应被注册表过滤（不出现、不报错）",
  );
  assert.ok(
    entries.some((entry) => entry.workspacePath === liveDir),
    "存活工作区应正常列出",
  );

  // 连接未被拆断：同连接上再次请求仍成功（修复前 list 超 deadline 会整条拆连）。
  const again = await client.request("workspace.list", {});
  assert.equal((again.workspaces as unknown[]).length, entries.length);
});

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
