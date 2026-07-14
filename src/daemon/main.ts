#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProductionLocalDaemonHost } from "./production-host.js";
import { installLocalDaemonShutdownHandlers } from "./runtime-host.js";

export async function runLocalDaemon(): Promise<void> {
  const host = createProductionLocalDaemonHost();
  installLocalDaemonShutdownHandlers(host);
  await host.start();
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
