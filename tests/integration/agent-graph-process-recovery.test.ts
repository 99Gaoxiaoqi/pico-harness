import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(
  new URL("../fixtures/agent-graph-crash-worker.ts", import.meta.url),
);
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "../../src/tui/preload-env.ts");

test("Graph durable windows survive SIGKILL and reopen with exact identities", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-agent-graph-process-recovery-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);

  const preparing = spawnWorker({ mode: "prepare", repoRoot, storageRoot });
  const checkpoint = await waitForMessage(preparing, "checkpoint");
  assert.equal(checkpoint.snapshot.revisions, 1);
  assert.equal(checkpoint.snapshot.records, 0);
  assert.deepEqual(checkpoint.snapshot.claims, [
    { claimId: "claim-window", targetRunId: "runtime-run" },
  ]);
  assert.equal(
    checkpoint.snapshot.runtimeKinds.filter((kind) => kind === "model.call.started").length,
    1,
  );
  assert.equal(
    checkpoint.snapshot.runtimeKinds.filter((kind) => kind === "agent.output").length,
    1,
  );
  assert.deepEqual(checkpoint.snapshot.attempts, [
    { attemptId: "wake-attempt-window", status: "running" },
  ]);
  assert.equal(checkpoint.snapshot.workspace[0]?.state, "requested");

  const killed = waitForExit(preparing);
  assert.equal(preparing.kill("SIGKILL"), true);
  const killedExit = await killed;
  assert.equal(killedExit.signal, "SIGKILL");

  const firstRecovery = spawnWorker({ mode: "recover", repoRoot, storageRoot });
  const firstExitPromise = waitForExit(firstRecovery);
  const recovered = await waitForMessage(firstRecovery, "recovered");
  const firstExit = await firstExitPromise;
  assert.equal(firstExit.code, 0);
  assert.equal(recovered.snapshot.workspace[0]?.state, "active");
  assert.deepEqual(recovered.snapshot.claims, checkpoint.snapshot.claims);
  assert.deepEqual(recovered.snapshot.attempts, checkpoint.snapshot.attempts);
  assert.deepEqual(recovered.snapshot.runtimeKinds, checkpoint.snapshot.runtimeKinds);

  const secondRecovery = spawnWorker({ mode: "recover", repoRoot, storageRoot });
  const secondExitPromise = waitForExit(secondRecovery);
  const replay = await waitForMessage(secondRecovery, "recovered");
  const secondExit = await secondExitPromise;
  assert.equal(secondExit.code, 0);
  assert.deepEqual(replay.snapshot, recovered.snapshot);
});

function spawnWorker(config: {
  mode: "prepare" | "recover";
  repoRoot: string;
  storageRoot: string;
}) {
  return fork(workerPath, [], {
    execArgv: ["--import", "tsx", "--import", preloadPath],
    env: { ...process.env, PICO_GRAPH_CRASH_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForMessage(child: ChildProcess, type: "checkpoint" | "recovered") {
  return new Promise<{ type: string; snapshot: Snapshot }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const record = message as { type?: string; error?: string; snapshot?: Snapshot };
      if (record.type === "fatal") reject(new Error(record.error));
      if (record.type === type && record.snapshot) resolve({ type, snapshot: record.snapshot });
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && type === "recovered") return;
      if (signal === "SIGKILL" && type === "checkpoint") return;
      reject(
        new Error(
          `worker exited before ${type}: code=${code} signal=${signal}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

function waitForExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

interface Snapshot {
  readonly revisions: number;
  readonly provisions: readonly { provisionId: string; state: string }[];
  readonly claims: readonly { claimId: string; targetRunId: string }[];
  readonly runtimeKinds: readonly string[];
  readonly records: number;
  readonly wakes: readonly { wakeId: string; status: string; attemptCount: number }[];
  readonly attempts: readonly { attemptId: string; status: string }[];
  readonly workspace: readonly {
    resourceId: string;
    state: string;
    worktreePath: string;
    branch: string;
  }[];
}

async function git(args: readonly string[], cwd: string) {
  return execFileAsync("git", [...args], { cwd, encoding: "utf8" });
}
