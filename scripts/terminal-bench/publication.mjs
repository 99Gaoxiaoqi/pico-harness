import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function hashDirectory(root, ignored = new Set()) {
  const hash = createHash("sha256");
  async function visit(path, relative) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains a symlink: ${path}`);
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (!ignored.has(entryRelative)) await visit(join(path, entry.name), entryRelative);
      }
      return;
    }
    if (!info.isFile()) return;
    const data = await readFile(path);
    hash.update(`${relative}\0${data.length}\0`);
    hash.update(data);
  }
  await visit(root, "");
  return hash.digest("hex");
}

export async function recoverBenchmarkPublications({ runsRoot, workRunsRoot, quarantineRoot }) {
  for (const entry of await readdir(workRunsRoot, { withFileTypes: true })) {
    await quarantine(join(workRunsRoot, entry.name), quarantineRoot, "staging");
  }
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    const path = join(runsRoot, entry.name);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("published benchmark entry is not a directory");
      }
      const marker = JSON.parse(await readFile(join(path, "PUBLISHED.json"), "utf8"));
      const summaryRaw = await readFile(join(path, "summary.json"));
      const sourceHashesRaw = await readFile(join(path, "source-hashes.json"));
      const summary = JSON.parse(summaryRaw);
      const sourceHashes = JSON.parse(sourceHashesRaw);
      const status = JSON.parse(await readFile(join(path, "run-status.json"), "utf8"));
      const trialIds = new Set();
      const trialGatePassed =
        Array.isArray(summary.trials) &&
        Number.isSafeInteger(summary.scheduled) &&
        summary.scheduled > 0 &&
        summary.observed === summary.scheduled &&
        summary.trials.length === summary.scheduled &&
        summary.trials.every((trial) => {
          if (
            trial?.infra?.status !== "ok" ||
            trial?.adapter?.status !== "ok" ||
            trial?.verifier?.status !== "completed" ||
            typeof trial?.trialId !== "string" ||
            trial.trialId.length === 0 ||
            trialIds.has(trial.trialId)
          ) {
            return false;
          }
          trialIds.add(trial.trialId);
          return true;
        });
      if (
        marker.schemaVersion !== 1 ||
        marker.runId !== entry.name ||
        marker.sealed !== true ||
        marker.secretScan?.status !== "passed" ||
        summary.runId !== entry.name ||
        summary.sealed !== true ||
        sourceHashes.sealed !== true ||
        !Array.isArray(sourceHashes.sources) ||
        sourceHashes.sources.length !== summary.scheduled ||
        status.harborExitCode !== 0 ||
        status.normalized !== true ||
        status.secretScan?.status !== "passed" ||
        status.secretScan.filesScanned !== marker.secretScan.filesScanned ||
        status.secretScan.bytesScanned !== marker.secretScan.bytesScanned ||
        !trialGatePassed ||
        marker.summarySha256 !== createHash("sha256").update(summaryRaw).digest("hex") ||
        marker.sourceHashesSha256 !== createHash("sha256").update(sourceHashesRaw).digest("hex") ||
        !/^[0-9a-f]{64}$/u.test(marker.fullTreeExcludingMarkerSha256)
      ) {
        throw new Error("published benchmark marker is invalid");
      }
      const treeHash = await hashDirectory(path, new Set(["PUBLISHED.json"]));
      if (treeHash !== marker.fullTreeExcludingMarkerSha256) {
        throw new Error("published benchmark tree hash is invalid");
      }
    } catch {
      await quarantine(path, quarantineRoot, "invalid-published");
    }
  }
}

export async function fsyncTree(root) {
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Result tree contains symlink: ${path}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      await fsyncDirectory(path);
      return;
    }
    if (!info.isFile()) return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await visit(root);
}

export async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function quarantine(path, root, reason) {
  const sourceParent = dirname(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  await rename(
    path,
    join(root, `${reason}-${name}-${Date.now()}-${randomBytes(4).toString("hex")}`),
  );
  await fsyncDirectory(sourceParent);
  await fsyncDirectory(root);
}
