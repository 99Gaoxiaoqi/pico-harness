import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RepoMapService } from "../../src/code-intelligence/repo-map.js";
import { expandMentionsToPrompt } from "../../src/input/context-attachments.js";

const FILE_SECRET_MARKER = "PICO_EXTERNAL_FILE_SECRET";
const DIRECTORY_SECRET_MARKER = "PICO_EXTERNAL_DIRECTORY_SECRET";

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
  assert.equal(attachments.get("ordinary-directory")?.type, "directory");
  assert.match(attachments.get("ordinary-directory")?.content ?? "", /visible\.txt/u);
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
