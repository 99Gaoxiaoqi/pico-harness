import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listDesktopEffectiveSkills,
  listDesktopUserSkills,
} from "../../src/daemon/desktop-resource-catalog.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";

test("用户级 Skill 枚举只读取用户来源并返回稳定修订", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-skill-catalog-"));
  const homeDir = join(root, "home");
  const picoHome = join(homeDir, ".pico");
  const pluginRoot = join(root, "plugin-skills");
  context.after(() => rm(root, { recursive: true, force: true }));

  const userPicoFile = await writeSkill(join(picoHome, "skills"), "shared", {
    description: "Pico user skill",
    body: "Use the Pico user instructions.",
    allowedTools: "read_file",
    model: "provider/user-model",
  });
  await writeSkill(join(homeDir, ".claude", "skills"), "shared", {
    description: "Claude user skill",
    body: "Use the Claude user instructions.",
  });
  // 若 user 模式意外构造项目来源，此目录会被当成 `${workDir}/.pico/skills` 扫描。
  await writeSkill(join(picoHome, ".pico", "skills"), "project-sentinel", {
    description: "Must stay invisible",
    body: "Project sentinel.",
  });
  await writeSkill(pluginRoot, "plugin-sentinel", {
    description: "Plugin must stay invisible",
    body: "Plugin sentinel.",
  });

  const options = {
    env: { PICO_HOME: picoHome },
    homeDir,
    picoHome,
    pluginSnapshot: pluginSnapshot(pluginRoot),
  };
  const first = await listDesktopUserSkills(options);
  assert.deepEqual(
    first.skills.map(({ name }) => name),
    ["shared", "shared"],
  );
  assert.deepEqual(
    first.skills.map(({ source }) => source),
    [
      {
        scope: "user",
        sourceId: "user-pico",
        sourceLabel: "Pico 用户级",
        readOnly: false,
        effective: true,
      },
      {
        scope: "user",
        sourceId: "user-claude",
        sourceLabel: "Claude 用户级",
        readOnly: false,
        effective: false,
        shadowedBy: "user-pico",
      },
    ],
  );
  assert.deepEqual(first.skills[0]?.allowedTools, ["read_file"]);
  assert.equal(first.skills[0]?.model, "provider/user-model");

  const unchanged = await listDesktopUserSkills(options);
  assert.equal(unchanged.revision, first.revision);
  await writeFile(
    userPicoFile,
    await skillDocument("shared", {
      description: "Pico user skill changed",
      body: "Use the updated Pico user instructions.",
    }),
  );
  const changed = await listDesktopUserSkills(options);
  assert.notEqual(changed.revision, first.revision);
});

test("可信工作区有效 Skill 枚举复用优先级并标出项目遮蔽", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-effective-skill-catalog-"));
  const homeDir = join(root, "home");
  const picoHome = join(homeDir, ".pico");
  const workspace = join(root, "workspace");
  const pluginRoot = join(root, "plugin-skills");
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeSkill(join(workspace, ".pico", "skills"), "shared", {
    description: "Project wins",
    body: "Project instructions.",
  });
  await writeSkill(join(picoHome, "skills"), "shared", {
    description: "User is shadowed",
    body: "User instructions.",
  });
  await writeSkill(pluginRoot, "shared", {
    description: "Plugin is shadowed",
    body: "Plugin instructions.",
  });
  await writeSkill(pluginRoot, "plugin-only", {
    description: "Plugin remains effective",
    body: "Plugin-only instructions.",
  });

  const options = {
    env: { PICO_HOME: picoHome },
    homeDir,
    picoHome,
    pluginSnapshot: pluginSnapshot(pluginRoot),
  };
  const user = await listDesktopUserSkills(options);
  const effective = await listDesktopEffectiveSkills(workspace, options);
  assert.equal(effective.revisions.user, user.revision);

  const shared = effective.skills.filter(({ name }) => name === "shared");
  assert.equal(shared.length, 3);
  assert.deepEqual(
    shared.map(({ source }) => source),
    [
      {
        scope: "project",
        sourceId: "project-pico",
        sourceLabel: "Pico 项目级",
        readOnly: false,
        effective: true,
      },
      {
        scope: "plugin",
        sourceId: "plugin:fixture:skill:local:0",
        sourceLabel: "Plugin · fixture",
        readOnly: true,
        effective: false,
        shadowedBy: "project-pico",
      },
      {
        scope: "user",
        sourceId: "user-pico",
        sourceLabel: "Pico 用户级",
        readOnly: false,
        effective: false,
        shadowedBy: "project-pico",
      },
    ],
  );
  assert.equal(effective.skills.find(({ name }) => name === "plugin-only")?.source.effective, true);
});

async function writeSkill(
  root: string,
  name: string,
  options: {
    readonly description: string;
    readonly body: string;
    readonly allowedTools?: string;
    readonly model?: string;
  },
): Promise<string> {
  const directory = join(root, name);
  const file = join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  await writeFile(file, await skillDocument(name, options), "utf8");
  return file;
}

async function skillDocument(
  name: string,
  options: {
    readonly description: string;
    readonly body: string;
    readonly allowedTools?: string;
    readonly model?: string;
  },
): Promise<string> {
  return [
    "---",
    `name: ${name}`,
    `description: ${options.description}`,
    ...(options.allowedTools ? [`allowed-tools: ${options.allowedTools}`] : []),
    ...(options.model ? [`model: ${options.model}`] : []),
    "---",
    options.body,
    "",
  ].join("\n");
}

function pluginSnapshot(skillRoot: string): PluginRuntimeSnapshot {
  return {
    pluginIds: ["fixture"],
    skillSources: [
      {
        id: "plugin:fixture:skill:local:0",
        scope: "external",
        format: "pico-native",
        root: skillRoot,
        priority: 38,
      },
    ],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [],
    lspServers: [],
    capabilities: [],
    diagnostics: [],
    dispose: async () => undefined,
  };
}
