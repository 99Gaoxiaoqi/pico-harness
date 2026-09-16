import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  executeGit,
  WorktreeMergeQueue,
  type GitExecutor,
  type WorktreeMergeCandidate,
} from "@pico/pico-host/worktree-merge-queue";

test("isolated integration fast-forwards the target and removes only its temporary worktree", async (t) => {
  const fixture = await createFixture(t);
  await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
  const targetBefore = await git(fixture.targetWorktree, "rev-parse", "HEAD");
  const sourceHead = await git(fixture.sourceWorktree, "rev-parse", "HEAD");
  let integrationPath: string | undefined;
  const queue = makeQueue(t, async (args, options) => {
    if (args.includes("--no-ff")) integrationPath = options.cwd;
    return executeGit(args, options);
  });
  await queue.enqueue(fixture);
  await queue.waitForIdle();
  const result = queue.get(fixture.taskId)!;
  assert.equal(result.status, "merged", result.error);
  assert.equal(await git(fixture.targetWorktree, "rev-parse", "HEAD"), result.mergeHead);
  assert.equal(await git(fixture.targetWorktree, "rev-parse", "HEAD^1"), targetBefore);
  assert.equal(await git(fixture.targetWorktree, "rev-parse", "HEAD^2"), sourceHead);
  assert.equal(await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"), "feature\n");
  assert.ok(integrationPath);
  assert.equal(existsSync(integrationPath), false);
  assert.equal(existsSync(fixture.sourceWorktree), true);
  assert.equal(result.integrationWorktree, undefined);
});

test("conflicts preserve the target byte-for-byte and resume only after the isolated resolution is committed", async (t) => {
  const fixture = await createFixture(t);
  await commitFile(fixture.sourceWorktree, "shared.txt", "source\n");
  await commitFile(fixture.targetWorktree, "shared.txt", "target\n");
  const before = await targetState(fixture.targetWorktree);
  const queue = makeQueue(t);
  await queue.enqueue(fixture);
  await queue.waitForIdle();
  const blocked = queue.get(fixture.taskId)!;
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /已保留隔离现场/);
  assert.deepEqual(await targetState(fixture.targetWorktree), before);
  assert.ok(blocked.integrationWorktree);
  assert.match(await git(blocked.integrationWorktree, "status", "--porcelain"), /UU shared.txt/);
  await assert.rejects(queue.resumeAfterResolution(fixture.taskId), /集成工作树不干净/);
  await writeFile(join(blocked.integrationWorktree, "shared.txt"), "resolved\n");
  await git(blocked.integrationWorktree, "add", "shared.txt");
  await git(blocked.integrationWorktree, "commit", "--quiet", "--no-edit");
  const merged = await queue.resumeAfterResolution(fixture.taskId);
  assert.equal(merged.status, "merged", merged.error);
  assert.equal(await readFile(join(fixture.targetWorktree, "shared.txt"), "utf8"), "resolved\n");
  assert.equal(existsSync(blocked.integrationWorktree), false);
});

test("dirty target rejection preserves HEAD, index bytes, staged, unstaged and untracked contents", async (t) => {
  const fixture = await createFixture(t);
  await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
  await writeFile(join(fixture.targetWorktree, "shared.txt"), "staged\n");
  await git(fixture.targetWorktree, "add", "shared.txt");
  await writeFile(join(fixture.targetWorktree, "shared.txt"), "unstaged\n");
  await writeFile(join(fixture.targetWorktree, "notes.txt"), "user notes\n");
  const before = await targetState(fixture.targetWorktree);
  const queue = makeQueue(t);
  await queue.enqueue(fixture);
  await queue.waitForIdle();
  assert.equal(queue.get(fixture.taskId)!.status, "blocked");
  assert.match(queue.get(fixture.taskId)!.error!, /目标工作树不干净/);
  assert.deepEqual(await targetState(fixture.targetWorktree), before);
});

for (const change of ["commit", "dirty"] as const) {
  test(`target ${change} during isolated merge blocks publication and preserves the new user state`, async (t) => {
    const fixture = await createFixture(t);
    await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
    let expected: Awaited<ReturnType<typeof targetState>> | undefined;
    const queue = makeQueue(t, async (args, options) => {
      const result = await executeGit(args, options);
      if (args.includes("--no-ff")) {
        if (change === "commit")
          await commitFile(fixture.targetWorktree, "shared.txt", "concurrent\n");
        else {
          await writeFile(join(fixture.targetWorktree, "shared.txt"), "user edits\n");
          await writeFile(join(fixture.targetWorktree, "notes.txt"), "user notes\n");
        }
        expected = await targetState(fixture.targetWorktree);
      }
      return result;
    });
    await queue.enqueue(fixture);
    await queue.waitForIdle();
    const result = queue.get(fixture.taskId)!;
    assert.equal(result.status, "blocked");
    assert.match(result.error!, change === "commit" ? /目标分支已漂移/ : /目标工作树不干净/);
    assert.ok(result.integrationWorktree && existsSync(result.integrationWorktree));
    assert.ok(expected);
    assert.deepEqual(await targetState(fixture.targetWorktree), expected);
    if (change === "commit") {
      await assert.rejects(queue.resumeAfterResolution(fixture.taskId), /目标分支已漂移/);
      assert.equal(queue.get(fixture.taskId)!.status, "blocked");
      assert.deepEqual(await targetState(fixture.targetWorktree), expected);
      await git(result.integrationWorktree, "merge", "--no-edit", expected.head);
      const merged = await queue.resumeAfterResolution(fixture.taskId);
      assert.equal(merged.status, "merged", merged.error);
      await git(fixture.targetWorktree, "merge-base", "--is-ancestor", expected.head, "HEAD");
      await git(fixture.targetWorktree, "merge-base", "--is-ancestor", result.sourceHead!, "HEAD");
      assert.equal(
        await readFile(join(fixture.targetWorktree, "shared.txt"), "utf8"),
        "concurrent\n",
      );
      assert.equal(
        await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"),
        "feature\n",
      );
      assert.equal(existsSync(result.integrationWorktree), false);
    } else {
      // User clears their own changes; the preserved, verified integration can now publish.
      await writeFile(join(fixture.targetWorktree, "shared.txt"), "baseline\n");
      await rm(join(fixture.targetWorktree, "notes.txt"));
      assert.equal((await queue.resumeAfterResolution(fixture.taskId)).status, "merged");
    }
  });
}

test("resume accepts a changed upstream only after its new commit is explicitly reintegrated", async (t) => {
  const fixture = await createFixture(t);
  const upstream = join(dirname(fixture.sourceWorktree), "upstream");
  await git(fixture.targetWorktree, "worktree", "add", "--quiet", "-b", "upstream", upstream);
  await git(fixture.targetWorktree, "branch", "--set-upstream-to=upstream", "main");
  await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
  const before = await targetState(fixture.targetWorktree);
  const queue = makeQueue(t, async (args, options) => {
    const result = await executeGit(args, options);
    if (args.includes("--no-ff")) await commitFile(upstream, "upstream.txt", "upstream\n");
    return result;
  });
  await queue.enqueue(fixture);
  await queue.waitForIdle();
  const blocked = queue.get(fixture.taskId)!;
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /上游已漂移/);
  await assert.rejects(queue.resumeAfterResolution(fixture.taskId), /尚未包含当前上游提交/);
  assert.deepEqual(await targetState(fixture.targetWorktree), before);
  assert.ok(blocked.integrationWorktree);
  const upstreamHead = await git(upstream, "rev-parse", "HEAD");
  await git(blocked.integrationWorktree, "merge", "--no-edit", upstreamHead);
  assert.equal((await queue.resumeAfterResolution(fixture.taskId)).status, "merged");
  await git(fixture.targetWorktree, "merge-base", "--is-ancestor", upstreamHead, "HEAD");
  assert.equal(await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await readFile(join(fixture.targetWorktree, "upstream.txt"), "utf8"), "upstream\n");
  assert.equal(existsSync(blocked.integrationWorktree), false);
});

for (const change of ["target", "upstream", "unrelated-upstream"] as const) {
  test(`recovering ${change} drift advances only the second task's accepted baseline`, async (t) => {
    const fixture = await createFixture(t);
    const secondSource = join(dirname(fixture.sourceWorktree), "second-source");
    await git(fixture.targetWorktree, "worktree", "add", "--quiet", "-b", "second", secondSource);
    await commitFile(secondSource, "second.txt", "second\n");
    const second = {
      ...fixture,
      taskId: "second",
      sourceBranch: "second",
      sourceWorktree: secondSource,
    };
    let changedWorktree = fixture.targetWorktree;
    if (change !== "target") {
      changedWorktree = join(dirname(fixture.sourceWorktree), "upstream");
      await git(
        fixture.targetWorktree,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "upstream",
        changedWorktree,
      );
      await git(fixture.targetWorktree, "branch", "--set-upstream-to=upstream", "main");
    }
    await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
    let drifted = false;
    const queue = makeQueue(t, async (args, options) => {
      const result = await executeGit(args, options);
      if (args.includes("--no-ff") && !drifted) {
        drifted = true;
        // Upstream recovery must advance a task queued on the old upstream U0.
        if (change === "upstream") await queue.enqueue(second);
        if (change === "unrelated-upstream") {
          await commitFile(changedWorktree, "intermediate.txt", "intermediate\n");
          await queue.enqueue(second);
        }
        await commitFile(changedWorktree, "concurrent.txt", "concurrent\n");
      }
      return result;
    });
    await queue.enqueue(fixture);
    await queue.waitForIdle();
    const blocked = queue.get(fixture.taskId)!;
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.integrationWorktree);
    // Target recovery must also advance a task queued after target moved B0 -> B1.
    if (change === "target") await queue.enqueue(second);
    assert.equal(queue.get("second")!.status, "queued");
    await assert.rejects(queue.resumeAfterResolution(fixture.taskId), /已漂移/);
    const acceptedHead = await git(changedWorktree, "rev-parse", "HEAD");
    await git(blocked.integrationWorktree, "merge", "--no-edit", acceptedHead);
    assert.equal((await queue.resumeAfterResolution(fixture.taskId)).status, "merged");
    await queue.waitForIdle();
    if (change === "unrelated-upstream") {
      assert.equal(queue.get("second")!.status, "blocked");
      assert.match(queue.get("second")!.error!, /已漂移/);
      assert.equal(existsSync(join(fixture.targetWorktree, "second.txt")), false);
      return;
    }
    assert.equal(queue.get("second")!.status, "merged", queue.get("second")!.error);
    await git(fixture.targetWorktree, "merge-base", "--is-ancestor", acceptedHead, "HEAD");
    assert.equal(await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"), "feature\n");
    assert.equal(await readFile(join(fixture.targetWorktree, "second.txt"), "utf8"), "second\n");
    assert.equal(
      await readFile(join(fixture.targetWorktree, "concurrent.txt"), "utf8"),
      "concurrent\n",
    );
  });
}

for (const change of ["late commit", "ignored file"] as const) {
  test(`fast-forward refuses a ${change} at the publication boundary without overwriting user data`, async (t) => {
    const fixture = await createFixture(t);
    await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
    if (change === "ignored file") {
      await writeFile(join(fixture.targetWorktree, ".git", "info", "exclude"), "feature.txt\n");
      await writeFile(join(fixture.targetWorktree, "feature.txt"), "ignored user data\n");
    }
    let expected: Awaited<ReturnType<typeof targetState>> | undefined;
    const queue = makeQueue(t, async (args, options) => {
      if (args.includes("--ff-only")) {
        if (change === "late commit")
          await commitFile(fixture.targetWorktree, "shared.txt", "last moment\n");
        expected = await targetState(fixture.targetWorktree);
      }
      return executeGit(args, options);
    });
    await queue.enqueue(fixture);
    await queue.waitForIdle();
    const result = queue.get(fixture.taskId)!;
    assert.equal(result.status, "blocked");
    assert.match(result.error!, /无法安全快进/);
    assert.ok(expected);
    assert.deepEqual(await targetState(fixture.targetWorktree), expected);
    if (change === "ignored file") {
      assert.equal(
        await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"),
        "ignored user data\n",
      );
    }
    assert.equal(existsSync(join(fixture.targetWorktree, ".git", "pico-merge.lock")), false);
  });
}

test("a terminated queue owner does not permanently block later integration", async (t) => {
  const fixture = await createFixture(t);
  await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
  const lockPath = join(fixture.targetWorktree, ".git", "pico-merge.lock");
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    "import { OwnerLease } from '@pico/storage'; await OwnerLease.acquire({ leaseDirectory: process.argv[1], ownerId: 'terminated-queue', now: () => Date.now() - 60_000 }); process.exit(0);",
    lockPath,
  ]);
  assert.equal(existsSync(lockPath), true);
  const queue = makeQueue(t);
  await queue.enqueue(fixture);
  await queue.waitForIdle();
  assert.equal(queue.get(fixture.taskId)!.status, "merged", queue.get(fixture.taskId)!.error);
  assert.equal(existsSync(lockPath), false);
});

test("independent queues cannot publish concurrently and the repository lock is released", async (t) => {
  const fixture = await createFixture(t);
  await commitFile(fixture.sourceWorktree, "feature.txt", "feature\n");
  const otherSource = join(dirname(fixture.sourceWorktree), "other-source");
  await git(
    fixture.targetWorktree,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "other-feature",
    otherSource,
  );
  await commitFile(otherSource, "other.txt", "other\n");
  let reached!: () => void;
  const atMerge = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let continueMerge!: () => void;
  const gate = new Promise<void>((resolve) => {
    continueMerge = resolve;
  });
  const first = makeQueue(t, async (args, options) => {
    if (args.includes("--no-ff")) {
      reached();
      await gate;
    }
    return executeGit(args, options);
  });
  const second = makeQueue(t);
  await first.enqueue(fixture);
  await atMerge;
  try {
    await second.enqueue({
      ...fixture,
      taskId: "second",
      sourceBranch: "other-feature",
      sourceWorktree: otherSource,
    });
    await second.waitForIdle();
    assert.match(second.get("second")!.error!, /无法取得合并锁/);
  } finally {
    continueMerge();
    await first.waitForIdle();
  }
  assert.equal(first.get(fixture.taskId)!.status, "merged");
  await second.resumeAfterResolution("second");
  await second.waitForIdle();
  assert.equal(second.get("second")!.status, "merged", second.get("second")!.error);
  assert.equal(await readFile(join(fixture.targetWorktree, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await readFile(join(fixture.targetWorktree, "other.txt"), "utf8"), "other\n");
});

async function createFixture(t: TestContext): Promise<WorktreeMergeCandidate> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-merge-isolation-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetWorktree = join(root, "target");
  const sourceWorktree = join(root, "source");
  await mkdir(targetWorktree);
  await git(targetWorktree, "init", "--quiet", "--initial-branch=main");
  await git(targetWorktree, "config", "user.name", "Pico Test");
  await git(targetWorktree, "config", "user.email", "pico@example.invalid");
  await git(targetWorktree, "config", "commit.gpgSign", "false");
  await git(targetWorktree, "config", "core.autocrlf", "false");
  await commitFile(targetWorktree, "shared.txt", "baseline\n");
  await git(targetWorktree, "worktree", "add", "--quiet", "-b", "feature", sourceWorktree);
  return {
    taskId: "task",
    sourceBranch: "feature",
    targetBranch: "main",
    targetWorktree,
    sourceWorktree,
  };
}

function makeQueue(t: TestContext, executor?: GitExecutor): WorktreeMergeQueue {
  const queue = new WorktreeMergeQueue(executor ? { git: executor } : {});
  t.after(async () => {
    for (const snapshot of queue.list()) {
      if (snapshot.integrationWorktree)
        await rm(dirname(snapshot.integrationWorktree), { recursive: true, force: true });
    }
  });
  return queue;
}

async function commitFile(cwd: string, path: string, contents: string): Promise<void> {
  await writeFile(join(cwd, path), contents);
  await git(cwd, "add", path);
  await git(cwd, "commit", "--quiet", "-m", `update ${path}`);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await executeGit(["--no-optional-locks", ...args], { cwd });
  assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function targetState(cwd: string) {
  return {
    head: await git(cwd, "rev-parse", "HEAD"),
    index: await readFile(join(cwd, ".git", "index")),
    status: await git(cwd, "status", "--porcelain"),
    shared: await readFile(join(cwd, "shared.txt")),
    notes: existsSync(join(cwd, "notes.txt")) ? await readFile(join(cwd, "notes.txt")) : undefined,
    mergeHead: existsSync(join(cwd, ".git", "MERGE_HEAD")),
  };
}
