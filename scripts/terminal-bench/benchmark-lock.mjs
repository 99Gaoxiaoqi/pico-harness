import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function acquireBenchmarkLock(benchmarkRoot) {
  const lockPath = join(benchmarkRoot, ".run-lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = randomBytes(16).toString("hex");
  const candidatePath = `${lockPath}.candidate-${token}`;
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  await mkdir(candidatePath, { mode: 0o700 });
  const candidateOwnerPath = join(candidatePath, "owner.json");
  await writeFile(candidateOwnerPath, `${JSON.stringify(owner)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fsyncPath(candidateOwnerPath);
  await fsyncPath(candidatePath);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(candidatePath, lockPath);
      await fsyncPath(benchmarkRoot);
      return {
        async release() {
          if ((await readOwner(ownerPath))?.token === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        },
        releaseSync() {
          try {
            const current = JSON.parse(readFileSync(ownerPath, "utf8"));
            if (current.token === token) rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Fail closed when ownership cannot be proven.
          }
        },
      };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw error;
      }
      const current = await readOwner(ownerPath);
      if (current !== null && isProcessAlive(current.pid)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw new Error("Another Terminal-Bench publication process owns the benchmark lock", {
          cause: error,
        });
      }
      const stalePath = `${lockPath}.stale-${token}-${attempt}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        await rm(candidatePath, { recursive: true, force: true });
        throw renameError;
      }
      await fsyncPath(benchmarkRoot);
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  await rm(candidatePath, { recursive: true, force: true });
  throw new Error("Could not acquire the Terminal-Bench publication lock");
}

async function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (
      owner?.schemaVersion !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.token !== "string"
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function fsyncPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
