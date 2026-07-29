import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
      const observed = await observeLock(lockPath, ownerPath);
      if (observed === null) continue;
      if (observed.owner !== null && isProcessAlive(observed.owner.pid)) {
        await rm(candidatePath, { recursive: true, force: true });
        throw new Error("Another Terminal-Bench publication process owns the benchmark lock", {
          cause: error,
        });
      }
      const generation =
        observed.owner?.token ?? `${observed.identity.dev}-${observed.identity.ino}`;
      const generationHash = createHash("sha256").update(generation).digest("hex").slice(0, 32);
      const stalePath = `${lockPath}.stale-${generationHash}`;
      try {
        await rename(lockPath, stalePath);
      } catch (renameError) {
        if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(renameError?.code)) continue;
        await rm(candidatePath, { recursive: true, force: true });
        throw renameError;
      }
      await fsyncPath(benchmarkRoot);
    }
  }
  await rm(candidatePath, { recursive: true, force: true });
  throw new Error("Could not acquire the Terminal-Bench publication lock");
}

async function observeLock(lockPath, ownerPath) {
  try {
    const before = await stat(lockPath);
    const owner = await readOwner(ownerPath);
    const after = await stat(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) return null;
    return { owner, identity: { dev: before.dev, ino: before.ino } };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
