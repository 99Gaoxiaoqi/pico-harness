#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
  parseRuntimeHostCandidateArguments,
  runRuntimeHostProcessLifecycle,
} from "@pico/runtime-host";
import { startPicoDaemonRuntimeHostCandidate } from "./runtime-host-candidate.js";

/**
 * Pico daemon 的严格 Runtime Host candidate 入口。
 * connectOrSpawn 必须传入 --root 与 --expected-root-id；不提供无参自举路径。
 * 退出码：0 正常关停 / 2 flock loser / 65 存储根不兼容（永久，客户端
 * fast-fail）/ 70 其他启动失败（非永久）/ 1 关停超时。
 */
export async function runLocalDaemon(): Promise<void> {
  const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
  const result = await startPicoDaemonRuntimeHostCandidate(options);
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
    // 启动失败按退出码协议分类退出：客户端 connectOrSpawn 据此 fast-fail（65）
    // 或携带诊断收场（70）。
    const failure = classifyCandidateStartupFailure(error);
    process.stderr.write(
      `Pico daemon 启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(candidateStartupFailureExitCode(failure));
  });
}
