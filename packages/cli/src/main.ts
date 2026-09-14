// pico 的唯一外壳入口:TUI。
// 网络服务、机器人、ACP 和 one-shot CLI 都已移除,避免多入口共享 session 造成状态串扰。

// 发布后的 pico 直接执行 dist/cli/main.js,不会经过 npm dev 的 --import。
// 必须在其他依赖图执行前预加载,避免 Pino 先以 stderr transport 初始化。
import "./tui/preload-env.js";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import { resolveCanonicalPicoHome } from "@pico/pico-host/pico-paths";
import { sleepForRetry } from "@pico/runtime/provider-retry";
import { primeTokenizer } from "@pico/runtime";
import { ensureWorkspaceTrusted } from "@pico/pico-host/workspace-trust";
import { startClientRepl } from "./tui/client-repl.js";
import { resolveCliStartupSession, resolveCliWorkDir } from "@pico/cli/session-args";
import { createTerminalWorkspaceTrustPrompt } from "@pico/cli/workspace-trust-prompt";
import { runCli, type CliRuntime } from "@pico/cli/entry-dispatch";

/** @deprecated CLI 分派已迁至 @pico/cli。 */
export { runCli, type CliRuntime } from "@pico/cli/entry-dispatch";

async function loadPackageVersion(packagePath: URL): Promise<string> {
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json 缺少有效 version: ${fileURLToPath(packagePath)}`);
  }
  return parsed.version;
}

/**
 * `pico --daemon-stop`：请求常驻 daemon 优雅关停（3-B-4）。先按 registration
 * 探测是否真有 daemon 在跑——没有就报"未在运行"直接返回，绝不借 connectOrSpawn
 * 拉起一个新 daemon 再停掉（那会把"停 daemon"变成"启动一次完整装配"的副作用）。
 * 客户端只在成功响应刷出、registration 消失且原进程退出后返回；这里再次读取
 * registration，避免 CLI 在状态根并发变化时误报。
 */
async function stopLocalDaemon(runtime: CliRuntime): Promise<void> {
  const picoHome = resolveCanonicalPicoHome({ env: runtime.env });
  const registration = await readLocalDaemonRegistration(picoHome);
  if (!registration) {
    runtime.writeStdout("本机 Runtime daemon 未在运行。\n");
    return;
  }
  const client = new LocalRuntimeClient({ runtimeHostRootPath: picoHome });
  try {
    await client.shutdownDaemon();
  } finally {
    client.close();
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await readLocalDaemonRegistration(picoHome);
    if (!current || current.pid !== registration.pid || !(await isProcessAlive(registration.pid))) {
      runtime.writeStdout("本机 Runtime daemon 已优雅停止。\n");
      return;
    }
    await sleepForRetry(200);
  }
  throw new Error("Runtime daemon 关停超时（15s 内未退出），请检查进程状态");
}

async function readLocalDaemonRegistration(picoHome: string): Promise<{ pid: number } | undefined> {
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    return await readHostRegistration(join(resolveRootControlNamespace(), capability.rootId));
  } catch {
    return undefined;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isEntrypoint(entrypointUrl: string): Promise<boolean> {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    const [modulePath, launchedPath] = await Promise.all([
      realpath(fileURLToPath(entrypointUrl)),
      realpath(argvPath),
    ]);
    return modulePath === launchedPath;
  } catch {
    return false;
  }
}

async function executeEntrypoint(packagePath: URL): Promise<void> {
  const runtime: CliRuntime = {
    env: process.env,
    version: await loadPackageVersion(packagePath),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    primeTokenizer,
    resolveCliWorkDir,
    ensureWorkspaceTrusted: async (workDir) => {
      const prompt =
        process.stdin.isTTY && process.stdout.isTTY
          ? createTerminalWorkspaceTrustPrompt({ input: process.stdin, output: process.stdout })
          : undefined;
      await ensureWorkspaceTrusted(workDir, { ...(prompt ? { prompt } : {}) });
    },
    resolveCliStartupSession,
    startClientRepl,
    stopLocalDaemon: async () => {
      await stopLocalDaemon(runtime);
    },
  };
  process.exitCode = await runCli(process.argv.slice(2), runtime);
}

/** The process shim supplies its URLs, preserving source and packaged layouts. */
export async function runCliEntrypoint(options: {
  readonly entrypointUrl: string;
  readonly packageUrl: URL;
}): Promise<void> {
  if (await isEntrypoint(options.entrypointUrl)) {
    await executeEntrypoint(options.packageUrl);
  }
}
