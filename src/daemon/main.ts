#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runRuntimeHostProcessLifecycle } from "@pico/runtime-host";
import {
  parsePicoDaemonCandidateArguments,
  startPicoDaemonRuntimeHostCandidate,
} from "./runtime-host-candidate.js";

/**
 * 3-B-3 起 daemon main = runtime-host candidate 入口：
 *   升级守卫（旧 instance-lock）→ flock 选主 → kernel + production composition。
 * 无参启动（旧 LaunchAgent / 手动 spawn）以 canonical PICO_HOME 自举交互根；
 * connectOrSpawn spawn 路径传 kernel CLI 参数（--root/--expected-root-id）。
 * 退出码：0 正常关停 / 1 启动失败或关停超时 / 2 flock loser / 3 旧 daemon 仍在运行。
 */
export async function runLocalDaemon(): Promise<void> {
  const options = parsePicoDaemonCandidateArguments(process.argv.slice(2));
  const result = await startPicoDaemonRuntimeHostCandidate(options);
  if (result.kind === "legacy_daemon_running") {
    process.stderr.write(`${result.message}\n`);
    process.exit(3);
  }
  if (result.kind === "loser") process.exit(2);
  // SIGINT/SIGTERM → host.close()；shutdownGrace 超时 → process_termination_required → exit 1。
  await runRuntimeHostProcessLifecycle(result.host);
}

async function isEntrypoint(): Promise<boolean> {
  const launched = process.argv[1];
  if (!launched) return false;
  try {
    return (await realpath(launched)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isEntrypoint()) {
  await runLocalDaemon().catch((error: unknown) => {
    process.stderr.write(
      `Pico daemon 启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
