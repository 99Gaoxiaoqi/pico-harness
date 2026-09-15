import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkbarGitReviewAuthority, WorkbarGitReviewError } from "@pico/pico-host";
import { DesktopWorkbarGitReviewService } from "../../../packages/pico-host/src/desktop-workbar-git-review-service.js";

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
  assert.deepEqual(initial.staged, [
    { path: "tracked.txt", stage: "staged", status: "modified", additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(initial.unstaged, [
    { path: "tracked.txt", stage: "unstaged", status: "modified", additions: 1, deletions: 1 },
    { path: "new.txt", stage: "unstaged", status: "untracked", additions: 1, deletions: 0 },
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

test("Desktop Git list counts match untracked diffs including empty, binary and newline boundaries", async (context) => {
  const repository = await createRepository(context, "counts");
  const fixtures = [
    { path: "new.txt", content: "first\n", additions: 1 },
    { path: "no-newline.txt", content: "first\nsecond", additions: 2 },
    { path: "empty.txt", content: "", additions: 0 },
    { path: "blank.txt", content: "\n\n", additions: 2 },
    { path: "binary.dat", content: Buffer.from([0, 1, 10]), additions: 0 },
    {
      path: process.platform === "win32" ? "spaces and tabs.txt" : "spaces\tand tabs.txt",
      content: "中文\r\n第二行\r\n",
      additions: 2,
    },
  ];
  for (const fixture of fixtures) await writeFile(join(repository, fixture.path), fixture.content);
  if (process.platform !== "win32") {
    await symlink("../outside-target", join(repository, "link"));
  }
  await writeFile(join(repository, "tracked.txt"), "staged\nsecond\n");
  await git(repository, "add", "tracked.txt");
  await writeFile(join(repository, "tracked.txt"), "unstaged\n");

  const service = new DesktopWorkbarGitReviewService();
  const snapshot = await service.snapshot({ workspacePath: repository, source: "unstaged" });
  for (const fixture of fixtures) {
    const file = snapshot.files.find((candidate) => candidate.path === fixture.path);
    assert.deepEqual(file, {
      path: fixture.path,
      status: "added",
      additions: fixture.additions,
      deletions: 0,
    });
    const diff = await service.diff({
      workspacePath: repository,
      path: fixture.path,
      source: "unstaged",
      expectedRevision: snapshot.revision,
    });
    const additions = diff.patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    assert.equal(additions, file.additions, fixture.path);
    if (fixture.path === "no-newline.txt")
      assert.match(diff.patch, /\\ No newline at end of file/u);
    if (fixture.path === "binary.dat") assert.match(diff.patch, /Binary files/u);
    if (fixture.path === "empty.txt") assert.doesNotMatch(diff.patch, /@@/u);
  }
  assert.deepEqual(
    snapshot.files.find((file) => file.path === "tracked.txt"),
    { path: "tracked.txt", status: "modified", additions: 1, deletions: 2 },
  );
  const staged = await service.snapshot({ workspacePath: repository, source: "staged" });
  assert.deepEqual(staged.files, [
    { path: "tracked.txt", status: "modified", additions: 2, deletions: 1 },
  ]);
  if (process.platform !== "win32")
    assert.equal(snapshot.files.find((file) => file.path === "link")?.additions, 1);

  const bounded = await WorkbarGitReviewAuthority.open(repository, {
    limits: { maxUntrackedFileBytes: 32 },
  });
  await writeFile(join(repository, "large.txt"), "a".repeat(33));
  await assert.rejects(
    bounded.snapshot(),
    (error: unknown) => error instanceof WorkbarGitReviewError && error.code === "limit_exceeded",
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
