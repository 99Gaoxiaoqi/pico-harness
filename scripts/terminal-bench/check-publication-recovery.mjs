import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDirectory, recoverBenchmarkPublications } from "./publication.mjs";

const root = await mkdtemp(join(tmpdir(), "pico-publication-recovery-"));
const runsRoot = join(root, "runs");
const workRunsRoot = join(root, "work");
const quarantineRoot = join(root, "quarantine");
await Promise.all(
  [runsRoot, workRunsRoot, quarantineRoot].map((path) =>
    mkdir(path, { recursive: true, mode: 0o700 }),
  ),
);

try {
  await createRun("valid");
  await cp(join(runsRoot, "valid"), join(runsRoot, "bad-tree"), { recursive: true });
  await renameRun("bad-tree");
  await writeFile(join(runsRoot, "bad-tree", "payload.txt"), "tampered\n");

  await cp(join(runsRoot, "valid"), join(runsRoot, "bad-summary-marker"), {
    recursive: true,
  });
  await renameRun("bad-summary-marker");
  const badSummaryMarker = await readMarker("bad-summary-marker");
  badSummaryMarker.summarySha256 = "f".repeat(64);
  await writeMarker("bad-summary-marker", badSummaryMarker);

  await cp(join(runsRoot, "valid"), join(runsRoot, "bad-status"), { recursive: true });
  await renameRun("bad-status");
  await writeFile(
    join(runsRoot, "bad-status", "run-status.json"),
    `${JSON.stringify({ harborExitCode: 0, normalized: false })}\n`,
  );
  await refreshTreeHash("bad-status");

  await cp(join(runsRoot, "valid"), join(runsRoot, "bad-trial-gate"), { recursive: true });
  await renameRun("bad-trial-gate");
  const badGateSummary = JSON.parse(
    await readFile(join(runsRoot, "bad-trial-gate", "summary.json"), "utf8"),
  );
  badGateSummary.trials[0].adapter.status = "error";
  await writeFile(
    join(runsRoot, "bad-trial-gate", "summary.json"),
    `${JSON.stringify(badGateSummary)}\n`,
  );
  const badGateMarker = await readMarker("bad-trial-gate");
  badGateMarker.summarySha256 = createHash("sha256")
    .update(await readFile(join(runsRoot, "bad-trial-gate", "summary.json")))
    .digest("hex");
  await writeMarker("bad-trial-gate", badGateMarker);
  await refreshTreeHash("bad-trial-gate");

  await mkdir(join(workRunsRoot, "interrupted"), { mode: 0o700 });
  await writeFile(join(workRunsRoot, "interrupted", "partial.txt"), "partial\n");
  await recoverBenchmarkPublications({ runsRoot, workRunsRoot, quarantineRoot });

  assert.deepEqual(await readdir(runsRoot), ["valid"]);
  assert.deepEqual(await readdir(workRunsRoot), []);
  const quarantine = await readdir(quarantineRoot);
  assert.equal(quarantine.length, 5);
  assert(quarantine.some((name) => name.startsWith("staging-interrupted-")));
  for (const name of ["bad-tree", "bad-summary-marker", "bad-status", "bad-trial-gate"]) {
    assert(quarantine.some((entry) => entry.startsWith(`invalid-published-${name}-`)));
  }
  process.stdout.write("Terminal-Bench publication recovery boundary passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createRun(runId) {
  const path = join(runsRoot, runId);
  await mkdir(path, { mode: 0o700 });
  const summary = Buffer.from(
    `${JSON.stringify({
      runId,
      sealed: true,
      scheduled: 1,
      observed: 1,
      trials: [
        {
          trialId: `${runId}-trial`,
          infra: { status: "ok" },
          adapter: { status: "ok" },
          verifier: { status: "completed" },
        },
      ],
    })}\n`,
  );
  const sources = Buffer.from(
    `${JSON.stringify({ sealed: true, sources: [{ trial: `${runId}-trial` }] })}\n`,
  );
  await writeFile(join(path, "summary.json"), summary);
  await writeFile(join(path, "source-hashes.json"), sources);
  await writeFile(
    join(path, "run-status.json"),
    `${JSON.stringify({
      harborExitCode: 0,
      normalized: true,
      secretScan: { status: "passed", filesScanned: 4, bytesScanned: 100 },
    })}\n`,
  );
  await writeFile(join(path, "payload.txt"), "payload\n");
  await writeMarker(runId, {
    schemaVersion: 1,
    runId,
    sealed: true,
    secretScan: { status: "passed", filesScanned: 4, bytesScanned: 100 },
    summarySha256: createHash("sha256").update(summary).digest("hex"),
    sourceHashesSha256: createHash("sha256").update(sources).digest("hex"),
    fullTreeExcludingMarkerSha256: await hashDirectory(path),
  });
}

async function renameRun(runId) {
  const path = join(runsRoot, runId);
  const summary = { ...JSON.parse(await readFile(join(path, "summary.json"))), runId };
  await writeFile(join(path, "summary.json"), `${JSON.stringify(summary)}\n`);
  const marker = await readMarker(runId);
  marker.runId = runId;
  marker.summarySha256 = createHash("sha256")
    .update(await readFile(join(path, "summary.json")))
    .digest("hex");
  await writeMarker(runId, marker);
  await refreshTreeHash(runId);
}

async function refreshTreeHash(runId) {
  const marker = await readMarker(runId);
  marker.fullTreeExcludingMarkerSha256 = await hashDirectory(
    join(runsRoot, runId),
    new Set(["PUBLISHED.json"]),
  );
  await writeMarker(runId, marker);
}

async function readMarker(runId) {
  return JSON.parse(await readFile(join(runsRoot, runId, "PUBLISHED.json"), "utf8"));
}

async function writeMarker(runId, marker) {
  await writeFile(join(runsRoot, runId, "PUBLISHED.json"), `${JSON.stringify(marker)}\n`);
}
