import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  captureAtomicFilePrecondition,
  writeAtomicWorkspaceFile,
} from "../../src/tools/atomic-workspace-file.js";
import { EditFileTool, WriteFileTool } from "../../src/tools/registry-impl.js";

const EDIT_FILE_MAX_BYTES = 16 * 1024 * 1024;
const TEMPORARY_FILE_PREFIX = ".pico-write-";
const execFileAsync = promisify(execFile);

test("write_file atomically creates and overwrites while preserving ordinary metadata", async (context) => {
  const fixture = await createFixture("write");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const tool = new WriteFileTool(fixture.workspace);
  const relativePath = "nested/example.txt";
  const targetPath = join(fixture.workspace, relativePath);

  const created = await tool.execute(JSON.stringify({ path: relativePath, content: "first\n" }));
  assert.match(created, /^✅ 新建文件: nested\/example\.txt \(6 字符\)$/u);
  assert.equal(await readFile(targetPath, "utf8"), "first\n");
  if (process.platform !== "win32") {
    assert.equal((await stat(targetPath)).mode & 0o777, 0o666 & ~process.umask());
  }

  await chmod(targetPath, 0o764);
  const before = await stat(targetPath);
  const overwritten = await tool.execute(
    JSON.stringify({ path: relativePath, content: "second\n" }),
  );
  const after = await stat(targetPath);

  assert.match(overwritten, /^✅ 覆盖文件: nested\/example\.txt \(7 字符\)$/u);
  assert.equal(await readFile(targetPath, "utf8"), "second\n");
  if (process.platform !== "win32") {
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.notEqual(after.ino, before.ino, "覆盖必须发布新 inode，不能原地截断旧 inode");
  }

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o4754);
    const specialMode = (await stat(targetPath)).mode & 0o7777;
    await tool.execute(JSON.stringify({ path: relativePath, content: "ordinary\n" }));
    const publishedMode = (await stat(targetPath)).mode & 0o7777;
    assert.equal(publishedMode & 0o777, specialMode & 0o777);
    assert.equal(publishedMode & 0o7000, 0, "覆盖不能复活 setuid/setgid/sticky 位");
  }

  await assertNoTemporaryFiles(join(fixture.workspace, "nested"));
});

test("edit_file atomically preserves CRLF, permissions, ownership, and replace_all output", async (context) => {
  const fixture = await createFixture("edit");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetPath = join(fixture.workspace, "windows.txt");
  await writeFile(targetPath, "alpha\r\nbeta\r\nbeta\r\n");
  await chmod(targetPath, 0o640);
  const before = await stat(targetPath);

  const result = await new EditFileTool(fixture.workspace).execute(
    JSON.stringify({
      path: "windows.txt",
      old_text: "beta",
      new_text: "gamma",
      replace_all: true,
    }),
  );
  const after = await stat(targetPath);

  assert.match(result, /^✅ 成功修改文件: windows\.txt \(匹配级别 L1, 全部替换\)/u);
  assert.equal(await readFile(targetPath, "utf8"), "alpha\r\ngamma\r\ngamma\r\n");
  if (process.platform !== "win32") {
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.notEqual(after.ino, before.ino, "编辑必须通过原子替换发布新 inode");
  }
  await assertNoTemporaryFiles(fixture.workspace);
});

test(
  "write_file rejects overwriting macOS extended attributes without changing the original",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const fixture = await createFixture("extended-attribute");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "xattr.txt");
    await writeFile(targetPath, "old-content\n");
    await execFileAsync("/usr/bin/xattr", ["-w", "com.pico.test", "preserve-me", targetPath]);
    const before = await stat(targetPath);

    await assert.rejects(
      new WriteFileTool(fixture.workspace).execute(
        JSON.stringify({ path: "xattr.txt", content: "new-content\n" }),
      ),
      /扩展属性.*拒绝覆盖/u,
    );

    assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
    assert.equal((await stat(targetPath)).ino, before.ino);
    const { stdout } = await execFileAsync("/usr/bin/xattr", ["-p", "com.pico.test", targetPath], {
      encoding: "utf8",
    });
    assert.equal(stdout.trimEnd(), "preserve-me");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "edit_file rejects overwriting a macOS extended ACL without changing the original",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const fixture = await createFixture("extended-acl");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "acl.txt");
    await writeFile(targetPath, "alpha\n");
    await execFileAsync("/bin/chmod", ["+a", "everyone allow read", targetPath]);
    const before = await stat(targetPath);

    await assert.rejects(
      new EditFileTool(fixture.workspace).execute(
        JSON.stringify({ path: "acl.txt", old_text: "alpha", new_text: "beta" }),
      ),
      /扩展 ACL.*拒绝覆盖/u,
    );

    assert.equal(await readFile(targetPath, "utf8"), "alpha\n");
    assert.equal((await stat(targetPath)).ino, before.ino);
    const { stdout } = await execFileAsync("/bin/ls", ["-lde", targetPath], {
      encoding: "utf8",
    });
    assert.match(stdout, /^\s*0:/mu);
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "write_file and edit_file preserve Linux POSIX ACLs and extended attributes",
  { skip: process.platform !== "linux" },
  async (context) => {
    const fixture = await createFixture("linux-extended-metadata");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "metadata.txt");
    await writeFile(targetPath, "alpha\n");
    await chmod(targetPath, 0o755);
    await execFileAsync("/usr/bin/setfacl", ["-m", "u:65534:r--", targetPath]);
    await execFileAsync("/usr/bin/setfattr", ["-n", "user.pico", "-v", "preserve-me", targetPath]);
    const setCapability = async (): Promise<void> => {
      await execFileAsync("/usr/sbin/setcap", ["cap_net_bind_service=ep", targetPath]);
      const { stdout } = await execFileAsync("/usr/sbin/getcap", [targetPath], {
        encoding: "utf8",
      });
      assert.match(stdout, /cap_net_bind_service=ep/u);
    };
    await setCapability();

    const assertMetadata = async (): Promise<void> => {
      const [{ stdout: acl }, { stdout: attribute }, { stdout: capability }] = await Promise.all([
        execFileAsync("/usr/bin/getfacl", ["-cpn", targetPath], { encoding: "utf8" }),
        execFileAsync("/usr/bin/getfattr", ["--only-values", "-n", "user.pico", targetPath], {
          encoding: "utf8",
        }),
        execFileAsync("/usr/sbin/getcap", [targetPath], { encoding: "utf8" }),
      ]);
      assert.match(acl, /^user:65534:r--$/mu);
      assert.equal(attribute.trimEnd(), "preserve-me");
      assert.equal(capability, "", "内容改变后不能复活旧 security.capability");
    };

    const originalInode = (await stat(targetPath)).ino;
    await new WriteFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "metadata.txt", content: "beta\n" }),
    );
    assert.equal(await readFile(targetPath, "utf8"), "beta\n");
    assert.notEqual((await stat(targetPath)).ino, originalInode);
    await assertMetadata();

    await setCapability();
    await new EditFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "metadata.txt", old_text: "beta", new_text: "gamma" }),
    );
    assert.equal(await readFile(targetPath, "utf8"), "gamma\n");
    await assertMetadata();
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test("edit_file not-found leaves the original inode and content untouched", async (context) => {
  const fixture = await createFixture("not-found");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetPath = join(fixture.workspace, "source.txt");
  await writeFile(targetPath, "alpha\nbeta\ngamma\n");
  const before = await stat(targetPath);

  await assert.rejects(
    new EditFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "source.txt", old_text: "missing", new_text: "replacement" }),
    ),
    /未找到|找不到/u,
  );

  const after = await stat(targetPath);
  assert.equal(await readFile(targetPath, "utf8"), "alpha\nbeta\ngamma\n");
  assert.equal(after.ino, before.ino);
  await assertNoTemporaryFiles(fixture.workspace);
});

test("write_file and edit_file reject external symlinks without touching the target", async (context) => {
  const fixture = await createFixture("symlink");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outsideFile = join(fixture.outside, "outside.txt");
  await writeFile(outsideFile, "outside-original\n");
  await symlink(outsideFile, join(fixture.workspace, "external-link.txt"));

  await assert.rejects(
    new WriteFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "external-link.txt", content: "write-attempt\n" }),
    ),
    /路径越界/u,
  );
  await assert.rejects(
    new EditFileTool(fixture.workspace).execute(
      JSON.stringify({
        path: "external-link.txt",
        old_text: "outside-original",
        new_text: "edit-attempt",
      }),
    ),
    /路径越界/u,
  );

  assert.equal(await readFile(outsideFile, "utf8"), "outside-original\n");
  await assertNoTemporaryFiles(fixture.workspace);
  await assertNoTemporaryFiles(fixture.outside);
});

test("edit_file rejects a sparse oversized file before allocating or fully reading it", async (context) => {
  const fixture = await createFixture("oversized");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetPath = join(fixture.workspace, "huge.txt");
  await writeFile(targetPath, "bounded-prefix\n");
  await truncate(targetPath, 2 ** 31 + 1);

  await assert.rejects(
    new EditFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "huge.txt", old_text: "bounded", new_text: "changed" }),
    ),
    new RegExp(`超过 edit_file 上限 ${EDIT_FILE_MAX_BYTES} 字节`, "u"),
  );

  assert.equal((await stat(targetPath)).size, 2 ** 31 + 1);
  await assertNoTemporaryFiles(fixture.workspace);
});

test("atomic publish rejects finalized temporary-file tampering and rolls back cleanly", async (context) => {
  const fixture = await createFixture("publish-tamper");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetPath = join(fixture.workspace, "target.txt");
  const expectedContent = "expected\n";
  await writeFile(targetPath, "old-content\n");
  const precondition = await captureAtomicFilePrecondition(targetPath);
  let tampered = false;

  await assert.rejects(
    writeAtomicWorkspaceFile({
      targetPath,
      content: expectedContent,
      precondition,
      revalidateTarget: async () => {
        const temporary = (await readdir(fixture.workspace)).find((entry) =>
          entry.startsWith(TEMPORARY_FILE_PREFIX),
        );
        if (!temporary || tampered) return;
        const temporaryPath = join(fixture.workspace, temporary);
        if ((await stat(temporaryPath)).size !== Buffer.byteLength(expectedContent)) return;
        await writeFile(temporaryPath, "tampered\n");
        await chmod(temporaryPath, 0o400);
        tampered = true;
      },
    }),
    /发布前临时文件已被替换或修改/u,
  );

  assert.equal(tampered, true, "测试必须在最终校验前实际篡改临时文件");
  assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
  await assertNoTemporaryFiles(fixture.workspace);
});

test(
  "atomic replacement keeps the original file-level write-permission guard",
  {
    skip:
      process.platform === "win32" ||
      (typeof process.geteuid === "function" && process.geteuid() === 0),
  },
  async (context) => {
    const fixture = await createFixture("read-only-target");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "read-only.txt");
    await writeFile(targetPath, "old-content\n");
    await chmod(targetPath, 0o444);

    await assert.rejects(
      new WriteFileTool(fixture.workspace).execute(
        JSON.stringify({ path: "read-only.txt", content: "write-attempt\n" }),
      ),
      /EACCES|EPERM/u,
    );
    await assert.rejects(
      new EditFileTool(fixture.workspace).execute(
        JSON.stringify({
          path: "read-only.txt",
          old_text: "old-content",
          new_text: "edit-attempt",
        }),
      ),
      /EACCES|EPERM/u,
    );

    assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "write_file staging failure keeps the old file and leaves no temporary file",
  {
    skip:
      process.platform === "win32" ||
      (typeof process.geteuid === "function" && process.geteuid() === 0),
  },
  async (context) => {
    const fixture = await createFixture("staging-failure");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "protected.txt");
    await writeFile(targetPath, "old-content\n");
    await chmod(fixture.workspace, 0o500);

    try {
      await assert.rejects(
        new WriteFileTool(fixture.workspace).execute(
          JSON.stringify({ path: "protected.txt", content: "new-content\n" }),
        ),
        /EACCES|EPERM/u,
      );
    } finally {
      await chmod(fixture.workspace, 0o700);
    }

    assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

async function createFixture(label: string): Promise<{
  root: string;
  workspace: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-file-write-${label}-`));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { root, workspace, outside };
}

async function assertNoTemporaryFiles(directory: string): Promise<void> {
  const entries = await readdir(directory);
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith(TEMPORARY_FILE_PREFIX)),
    [],
  );
}
