import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillLoader, SkillViewTool } from "../../../packages/pico-host/src/skill-catalog.js";
import { detectSandboxBackend } from "../../../packages/pico-host/src/process-sandbox/index.js";
import { buildDefaultToolRegistry } from "../../../packages/pico-host/src/default-registry.js";
import { WorkspaceRoots } from "../../../packages/pico-host/src/workspace-roots.js";

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

test("managed registry exposes the isolated skill reader after catalog preparation", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-registry-skill-view-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const skillDirectory = join(workspace, ".pico", "skills", "example");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: example\ndescription: Example\n---\nVisible through the worker\n",
  );
  const loader = new SkillLoader(workspace);
  await loader.loadAll();
  const roots = WorkspaceRoots.createSync(workspace);
  const registry = buildDefaultToolRegistry(workspace, {
    workspaceRoots: roots,
    skillLoader: loader,
    processSandbox: {
      profile: "workspace-write",
      generation: 1,
      resolveSandbox: () => ({ profile: "workspace-write", generation: 1 }),
    },
  });
  const tool = registry.getTool("skill_view");
  assert.ok(tool);
  assert.equal(await tool.execute('{"name":"example"}'), "Visible through the worker");
});
