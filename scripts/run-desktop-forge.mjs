import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const supportedCommands = new Set(["start", "package", "make"]);
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (!command || !supportedCommands.has(command)) {
  console.error("Usage: node scripts/run-desktop-forge.mjs <start|package|make> [...args]");
  process.exitCode = 2;
} else {
  try {
    await run(command, commandArgs);
  } catch (error) {
    console.error(`[desktop-forge] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function run(forgeCommand, forgeArgs) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "..");
  const desktopRoot = join(repositoryRoot, "apps", "desktop");
  const lockDirectory = forgeLockDirectory(repositoryRoot);
  let child;

  acquireLock(lockDirectory, forgeCommand, repositoryRoot);
  const forwardSignal = (signal) => {
    if (child && !child.killed) child.kill(signal);
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);

  try {
    for (const workspace of ["@pico/protocol", "@pico/transcript-replica", "@pico/runtime-host"]) {
      await runChild(npmExecutable(), ["run", "build", "--workspace", workspace], repositoryRoot);
    }

    const forgeCli = join(
      repositoryRoot,
      "node_modules",
      "@electron-forge",
      "cli",
      "dist",
      "electron-forge.js",
    );
    if (forgeCommand === "package") {
      rmSync(packagedTargetRoot(desktopRoot), { recursive: true, force: true });
    }
    await runChild(
      process.execPath,
      [forgeCli, forgeCommand, ...forgeArgs],
      desktopRoot,
      (spawned) => {
        child = spawned;
      },
    );
    child = undefined;

    if (forgeCommand === "package") verifyPackagedApplication(desktopRoot);
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}

function forgeLockDirectory(repositoryRoot) {
  const repositoryId = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
  return join(tmpdir(), `pico-desktop-forge-${repositoryId}.lock`);
}

function acquireLock(lockDirectory, forgeCommand, repositoryRoot) {
  try {
    mkdirSync(lockDirectory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readLockOwner(lockDirectory);
    if (owner?.pid && processIsAlive(owner.pid)) {
      throw new Error(
        `Desktop Forge 正在执行 ${owner.command ?? "未知操作"}（PID ${owner.pid}）。` +
          `请先停止该进程，再运行 ${forgeCommand}。`,
        { cause: error },
      );
    }
    rmSync(lockDirectory, { recursive: true, force: true });
    mkdirSync(lockDirectory);
  }

  writeFileSync(
    join(lockDirectory, "owner.json"),
    `${JSON.stringify({ pid: process.pid, command: forgeCommand, repositoryRoot, at: Date.now() })}\n`,
    { mode: 0o600 },
  );
}

function readLockOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runChild(executable, args, cwd, onSpawn) {
  return new Promise((resolvePromise, reject) => {
    const spawned = spawn(executable, args, { cwd, env: process.env, stdio: "inherit" });
    onSpawn?.(spawned);
    spawned.once("error", reject);
    spawned.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(spawned);
        return;
      }
      reject(
        new Error(
          signal
            ? `${executable} 被信号 ${signal} 中止。`
            : `${executable} 以退出码 ${code ?? "unknown"} 失败。`,
        ),
      );
    });
  });
}

function verifyPackagedApplication(desktopRoot) {
  const targetRoot = packagedTargetRoot(desktopRoot);
  const executable =
    process.platform === "darwin"
      ? join(targetRoot, "Pico.app", "Contents", "MacOS", "Pico")
      : process.platform === "win32"
        ? join(targetRoot, "Pico.exe")
        : join(targetRoot, "Pico");

  try {
    accessSync(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch (error) {
    throw new Error(`Electron Forge 未生成可执行桌面产物：${executable}`, { cause: error });
  }
  console.log(`[desktop-package] verified ${executable}`);
}

function packagedTargetRoot(desktopRoot) {
  return join(desktopRoot, "out", `Pico-${process.platform}-${process.arch}`);
}
