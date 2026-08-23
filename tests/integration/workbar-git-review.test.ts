import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  WorkbarGitReviewAuthority,
  WorkbarGitReviewError,
} from "../../src/daemon/workbar-git-review.js";

const execFileAsync = promisify(execFile);

test("Git Review 用内容 revision 绑定 staged/unstaged/untracked 快照", async (context) => {
  const repository = await createRepository(context, "snapshot");
  await writeFile(join(repository, "tracked.txt"), "staged\n");
  await git(repository, "add", "tracked.txt");
  await writeFile(join(repository, "tracked.txt"), "unstaged\n");
  await writeFile(join(repository, "new.txt"), "first\n");

  const authority = await WorkbarGitReviewAuthority.open(repository);
  const initial = await authority.snapshot();
  assert.equal(initial.branch, "main");
  assert.deepEqual(initial.staged, [{ path: "tracked.txt", stage: "staged", status: "modified" }]);
  assert.deepEqual(initial.unstaged, [
    { path: "tracked.txt", stage: "unstaged", status: "modified" },
    { path: "new.txt", stage: "unstaged", status: "untracked" },
  ]);

  const untrackedDiff = await authority.diff({
    path: "new.txt",
    stage: "unstaged",
    expectedRevision: initial.revision,
  });
  assert.match(untrackedDiff.patch, /\+first/u);
  const stagedDiff = await authority.diff({
    path: "tracked.txt",
    stage: "staged",
    expectedRevision: initial.revision,
  });
  assert.match(stagedDiff.patch, /\+staged/u);

  await writeFile(join(repository, "new.txt"), "second\n");
  const refreshed = await authority.snapshot();
  assert.notEqual(refreshed.revision, initial.revision);
  await assert.rejects(
    authority.diff({
      path: "new.txt",
      stage: "unstaged",
      expectedRevision: initial.revision,
    }),
    (error: unknown) =>
      error instanceof WorkbarGitReviewError && error.code === "revision_conflict",
  );
});

test("Git Review 固定 Git 参数禁用 external diff，并限制路径与容量", async (context) => {
  const repository = await createRepository(context, "security");
  await git(repository, "config", "diff.external", "/definitely/not/a/real/diff-driver");
  await writeFile(join(repository, "tracked.txt"), "changed\n");
  await writeFile(join(repository, "new.txt"), "new\n");

  const authority = await WorkbarGitReviewAuthority.open(repository);
  const snapshot = await authority.snapshot();
  assert.equal(snapshot.unstaged.length, 2);
  await authority.diff({
    path: "tracked.txt",
    stage: "unstaged",
    expectedRevision: snapshot.revision,
  });
  await assert.rejects(
    authority.diff({
      path: "../outside.txt",
      stage: "unstaged",
      expectedRevision: snapshot.revision,
    }),
    (error: unknown) => error instanceof WorkbarGitReviewError && error.code === "invalid_request",
  );

  const bounded = await WorkbarGitReviewAuthority.open(repository, {
    limits: { maxFiles: 1 },
  });
  await assert.rejects(
    bounded.snapshot(),
    (error: unknown) => error instanceof WorkbarGitReviewError && error.code === "limit_exceeded",
  );
});

test("Git Review 拒绝把工作区的外层仓库当成 authority 边界", async (context) => {
  const repository = await createRepository(context, "containment");
  const nestedWorkspace = join(repository, "nested-workspace");
  await mkdir(nestedWorkspace);
  await assert.rejects(
    WorkbarGitReviewAuthority.open(nestedWorkspace),
    (error: unknown) =>
      error instanceof WorkbarGitReviewError && error.code === "outside_workspace",
  );
});

async function createRepository(
  context: { after(callback: () => Promise<void> | void): void },
  name: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pico-workbar-git-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "pico@example.invalid");
  await git(root, "config", "user.name", "Pico Test");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "base");
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}
