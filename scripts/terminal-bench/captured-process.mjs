import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function runCaptured(
  command,
  args,
  cwd,
  env,
  supervisorConfig,
  {
    maxOutputBytes = 64 * 1024 * 1024,
    processGroupExitTimeoutMs = 10_000,
    inheritedFileDescriptors = [],
  } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe", "pipe", ...inheritedFileDescriptors],
    });
    child.stdio[3].end(supervisorConfig);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let outputLimitExceeded = false;
    let killError = null;
    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const enforceOutputLimit = async () => {
      try {
        if (killError) throw killError;
        if (detached && child.pid) {
          await confirmProcessGroupExit(child.pid, processGroupExitTimeoutMs);
        }
        settleReject(new Error(`${command} output exceeded the benchmark capture limit`));
      } catch (error) {
        settleReject(
          new Error(`${command} output-limit process-group cleanup was unconfirmed`, {
            cause: error,
          }),
        );
      }
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (!outputLimitExceeded && bytes > maxOutputBytes) {
        outputLimitExceeded = true;
        try {
          killProcessGroup(child, detached);
        } catch (error) {
          killError = error;
        }
        void enforceOutputLimit();
        return;
      }
      if (!outputLimitExceeded) target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (!outputLimitExceeded) settleReject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (outputLimitExceeded) return;
      settled = true;
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function killProcessGroup(child, detached) {
  try {
    if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function confirmProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      if (error?.code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("captured process group remained alive after SIGKILL");
    }
    await delay(25);
  }
}
