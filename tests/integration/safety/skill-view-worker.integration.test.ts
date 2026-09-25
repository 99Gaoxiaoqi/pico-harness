import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillLoader, SkillViewTool } from "../../../packages/pico-host/src/skill-catalog.js";
import { detectSandboxBackend } from "../../../packages/pico-host/src/process-sandbox/index.js";

test("managed skill_view reads the discovered exact source in an isolated File Worker", async (context) => {
  assert.notEqual(detectSandboxBackend(), "unavailable");
  const root = await mkdtemp(join(tmpdir(), "pico-managed-skill-view-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const sourceRoot = join(root, "external-skills");
  const skillDirectory = join(sourceRoot, "example");
  await mkdir(workspace);
  await mkdir(skillDirectory, { recursive: true });
  const source = join(skillDirectory, "SKILL.md");
  await writeFile(
    source,
    "---\nname: example\ndescription: Example\nhooks: {PreToolUse: []}\n---\nExact worker body\n",
  );
  const loader = new SkillLoader(workspace, {
    externalSources: [
      {
        id: "test-external",
        scope: "external",
        format: "pico-native",
        root: sourceRoot,
        priority: 80,
      },
    ],
  });
  let generation = 1;
  let activations = 0;
  let revokeDuringCall = false;
  let resolveCount = 0;
  const tool = new SkillViewTool(
    loader,
    () => {
      activations++;
    },
    {
      workDir: workspace,
      resolveSandbox: () => {
        if (revokeDuringCall && ++resolveCount === 2) generation++;
        return { profile: "workspace-write", generation };
      },
      writablePaths: () => [workspace],
    },
  );
  await assert.rejects(tool.execute('{"name":"example"}'), /技能目录尚未建立/u);
  await loader.loadAll();
  assert.equal(await tool.execute('{"name":"example"}'), "Exact worker body");
  assert.equal(activations, 1);
  await writeFile(
    source,
    "---\nname: example\ndescription: Example\nhooks: {PreToolUse: []}\n---\nReplaced body\n",
  );
  await assert.rejects(
    tool.execute('{"name":"example"}'),
    /技能来源身份已变化|目标身份已变化|技能正文与已解析目录不一致/u,
  );
  assert.equal(activations, 1);
  await writeFile(
    source,
    "---\nname: example\ndescription: Example\nhooks: {PreToolUse: []}\n---\nExact worker body\n",
  );
  await loader.loadAll();
  generation = 2;
  resolveCount = 0;
  revokeDuringCall = true;
  await assert.rejects(tool.execute('{"name":"example"}'), /技能读取期间任务边界已变化/u);
  revokeDuringCall = false;
  assert.equal(activations, 1);
  const oldDirectory = join(sourceRoot, "old-example");
  await rename(skillDirectory, oldDirectory);
  await mkdir(skillDirectory);
  await writeFile(
    source,
    "---\nname: example\ndescription: Example\nhooks: {PreToolUse: []}\n---\nExact worker body\n",
  );
  await assert.rejects(tool.execute('{"name":"example"}'), /技能来源身份已变化/u);
  assert.equal(activations, 1);
});
