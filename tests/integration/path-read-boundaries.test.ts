import assert from "node:assert/strict";
import { type Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RepoMapService } from "../../src/code-intelligence/repo-map.js";
import { expandMentionsToPrompt } from "../../src/input/context-attachments.js";

const FILE_SECRET_MARKER = "PICO_EXTERNAL_FILE_SECRET";
const DIRECTORY_SECRET_MARKER = "PICO_EXTERNAL_DIRECTORY_SECRET";
const SAFE_DIRECTORY_LISTING_UNAVAILABLE = /无法安全绑定已校验目录句柄，未列出目录项/u;

test("context attachments reject workspace escapes without regressing ordinary paths", async (context) => {
  const fixture = await createFixture("context");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  await mkdir(join(fixture.workspace, "docs"), { recursive: true });
  await mkdir(join(fixture.workspace, "ordinary-directory"));
  await writeFile(join(fixture.workspace, "ordinary.md"), "ordinary attachment\n");
  await writeFile(join(fixture.workspace, "ordinary-directory", "visible.txt"), "visible\n");
  await writeFile(join(fixture.workspace, "..name.ts"), "export const dotNameAllowed = true;\n");

  const outsideFile = join(fixture.outside, "secret.md");
  const outsideDirectory = join(fixture.outside, "secret-directory");
  await mkdir(outsideDirectory);
  await writeFile(outsideFile, `${FILE_SECRET_MARKER}\n`);
  await writeFile(join(outsideDirectory, DIRECTORY_SECRET_MARKER), "secret\n");
  await symlink(outsideFile, join(fixture.workspace, "docs", "setup.md"));
  await symlink(outsideDirectory, join(fixture.workspace, "external-directory"), "dir");

  const expanded = await expandMentionsToPrompt(
    "inspect @ordinary.md @ordinary-directory @..name.ts @docs/setup.md @external-directory",
    { cwd: fixture.workspaceAlias },
  );
  const attachments = new Map(
    expanded.attachments.map((attachment) => [attachment.reference, attachment]),
  );

  assert.equal(attachments.get("ordinary.md")?.type, "file");
  assert.match(attachments.get("ordinary.md")?.content ?? "", /ordinary attachment/u);
  const ordinaryDirectory = attachments.get("ordinary-directory");
  assert.equal(ordinaryDirectory?.type, "directory");
  if (SAFE_DIRECTORY_LISTING_UNAVAILABLE.test(ordinaryDirectory?.content ?? "")) {
    assert.equal(ordinaryDirectory?.truncated, true);
  } else {
    assert.match(ordinaryDirectory?.content ?? "", /visible\.txt/u);
  }
  assert.equal(attachments.get("..name.ts")?.type, "file");
  assert.match(attachments.get("..name.ts")?.content ?? "", /dotNameAllowed/u);
  assert.equal(attachments.get("docs/setup.md")?.type, "missing");
  assert.equal(attachments.get("external-directory")?.type, "missing");
  assert.doesNotMatch(expanded.prompt, new RegExp(FILE_SECRET_MARKER, "u"));
  assert.doesNotMatch(expanded.prompt, new RegExp(DIRECTORY_SECRET_MARKER, "u"));
});

test("context attachment byte limits apply before a sparse oversized file is fully loaded", async (context) => {
  const fixture = await createFixture("bounded-read");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const hugeFile = join(fixture.workspace, "huge.md");
  await writeFile(hugeFile, "bounded-prefix\n");
  await truncate(hugeFile, 2 ** 31 + 1);

  const expanded = await expandMentionsToPrompt("inspect @huge.md", {
    cwd: fixture.workspace,
    limits: { maxFileBytes: 15 },
  });
  const attachment = expanded.attachments[0];

  assert.equal(attachment?.type, "file");
  assert.equal(attachment?.truncated, true);
  assert.match(attachment?.content ?? "", /bounded-prefix/u);
});

test("directory attachments sample only the configured entry limit without claiming a full count", async (context) => {
  const fixture = await createFixture("bounded-directory");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const directory = join(fixture.workspace, "many");
  await mkdir(directory);
  await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      writeFile(join(directory, `entry-${String(index).padStart(2, "0")}.txt`), "visible\n"),
    ),
  );

  const expanded = await expandMentionsToPrompt("inspect @many", {
    cwd: fixture.workspace,
    limits: { maxDirectoryEntries: 1 },
  });
  const attachment = expanded.attachments[0];
  assert.equal(attachment?.type, "directory");
  if (SAFE_DIRECTORY_LISTING_UNAVAILABLE.test(attachment?.content ?? "")) {
    assert.equal(attachment?.truncated, true);
    return;
  }

  const visibleEntries = (attachment?.content ?? "")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("..."));

  assert.equal(attachment?.truncated, true);
  assert.equal(visibleEntries.length, 1);
  assert.match(attachment?.content ?? "", /目录项超过 1 项，已截断/u);
  assert.doesNotMatch(attachment?.content ?? "", /共 \d+ 项/u);
});

test(
  "directory attachments stay bound to the verified handle after the path is replaced",
  { skip: process.platform === "win32" ? "requires POSIX directory replacement" : false },
  async (context) => {
    const fixture = await createFixture("directory-replacement");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));

    const target = join(fixture.workspace, "victim");
    const holding = join(fixture.workspace, "victim-original");
    const safeEntry = join(target, "VISIBLE_SAFE_ENTRY");
    await mkdir(target);
    await writeFile(safeEntry, "safe\n");
    await writeFile(join(fixture.outside, DIRECTORY_SECRET_MARKER), "secret\n");

    const probe = await open(safeEntry, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as object;
    const originalStat = Reflect.get(fileHandlePrototype, "stat") as (
      this: FileHandle,
    ) => Promise<Stats>;
    await probe.close();

    let swapped = false;
    const patchedStat = async function (this: FileHandle): Promise<Stats> {
      const info = await originalStat.call(this);
      if (!swapped && info.isDirectory()) {
        await rename(target, holding);
        await symlink(fixture.outside, target, "dir");
        swapped = true;
      }
      return info;
    };
    assert.equal(Reflect.set(fileHandlePrototype, "stat", patchedStat), true);

    let expanded;
    try {
      expanded = await expandMentionsToPrompt("inspect @victim", { cwd: fixture.workspace });
    } finally {
      Reflect.set(fileHandlePrototype, "stat", originalStat);
    }

    const attachment = expanded.attachments[0];
    assert.equal(swapped, true);
    assert.equal(attachment?.type, "directory");
    assert.doesNotMatch(attachment?.content ?? "", new RegExp(DIRECTORY_SECRET_MARKER, "u"));
    assert.doesNotMatch(expanded.prompt, new RegExp(DIRECTORY_SECRET_MARKER, "u"));
    if (SAFE_DIRECTORY_LISTING_UNAVAILABLE.test(attachment?.content ?? "")) {
      assert.equal(attachment?.truncated, true);
    } else {
      assert.match(attachment?.content ?? "", /VISIBLE_SAFE_ENTRY/u);
    }
  },
);

test("RepoMap rejects external symlinks and accepts ordinary and dot-prefixed files", async (context) => {
  const fixture = await createFixture("repo-map");
  const service = new RepoMapService(fixture.workspaceAlias);
  context.after(async () => {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const outsideFile = join(fixture.outside, "outside.ts");
  await writeFile(outsideFile, `export function ${FILE_SECRET_MARKER}() {}\n`);
  await symlink(outsideFile, join(fixture.workspace, "inside.ts"));
  await writeFile(join(fixture.workspace, "ordinary.ts"), "export function ordinarySymbol() {}\n");
  await writeFile(join(fixture.workspace, "..name.ts"), "export const dotPrefixedSymbol = 1;\n");

  await assert.rejects(service.symbols({ filePath: "inside.ts" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /路径越界|越出工作区/u);
    assert.doesNotMatch(error.message, new RegExp(FILE_SECRET_MARKER, "u"));
    return true;
  });

  const ordinary = await service.symbols({ filePath: "ordinary.ts" });
  const dotPrefixed = await service.symbols({ filePath: "..name.ts" });
  assert.deepEqual(
    ordinary.map((symbol) => symbol.name),
    ["ordinarySymbol"],
  );
  assert.deepEqual(
    dotPrefixed.map((symbol) => symbol.name),
    ["dotPrefixedSymbol"],
  );
});

async function createFixture(label: string): Promise<{
  root: string;
  workspace: string;
  workspaceAlias: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-path-boundary-${label}-`));
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-alias");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(workspace, workspaceAlias, "dir");
  return { root, workspace, workspaceAlias, outside };
}
