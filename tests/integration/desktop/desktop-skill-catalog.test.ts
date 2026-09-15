import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listDesktopEffectiveSkills,
  listDesktopUserSkills,
} from "@pico/pico-host/desktop-resource-catalog";
import type { PluginRuntimeSnapshot } from "@pico/pico-host/plugins/plugin-runtime-snapshot";
import { SkillLoader } from "@pico/pico-host/product-skill-catalog";
import type { ExternalResourceCatalogSource } from "@pico/core/resource-catalog";
import type { HookTrustAuthority } from "@pico/pico-host/hooks/trust/store";
import { loadPicoProjectConfig } from "@pico/pico-host/input/pico-config";
import { logger } from "@pico/pico-host/logger";
import {
  listDesktopAgents as listHostDesktopAgents,
  listDesktopEffectiveSkills as listHostDesktopEffectiveSkills,
  listDesktopMcpServers as listHostDesktopMcpServers,
  listDesktopSkills as listHostDesktopSkills,
  listDesktopUserSkills as listHostDesktopUserSkills,
  type DesktopResourceCatalogOptions,
} from "@pico/pico-host/desktop-resource-catalog";

test("Pico Host 桌面目录通过窄配置端口枚举技能、Agent 与只读 Plugin MCP 来源", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-host-desktop-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const homeDir = join(root, "home");
  const picoHome = join(homeDir, ".pico");
  const pluginRoot = join(root, "plugin-skills");
  for (const [path, name] of [
    [join(workspace, ".pico", "skills"), "native"],
    [join(workspace, ".claude", "skills"), "claude"],
    [join(picoHome, "skills"), "user"],
    [pluginRoot, "plugin"],
  ] as const) {
    await writeSkill(path, name, { description: name, body: name });
  }
  const claudeAgents = join(workspace, ".claude", "agents");
  await mkdir(claudeAgents, { recursive: true });
  await writeFile(
    join(claudeAgents, "claude-agent.md"),
    "---\nname: claude-agent\ndescription: Claude agent\n---\nReview code.\n",
  );
  const pluginAgentPath = join(root, "plugin-agents.yaml");
  await writeFile(
    pluginAgentPath,
    JSON.stringify({
      agents: [
        {
          name: "plugin-agent",
          description: "Plugin agent",
          systemPrompt: "Review code.",
          tools: ["read_file"],
        },
      ],
    }),
  );
  await writeFile(
    join(workspace, ".pico", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        project: { command: "never-execute", enabled: false },
      },
    }),
  );

  let compatibilityEnabled = false;
  const configReads: string[] = [];
  const options: DesktopResourceCatalogOptions = {
    env: { PICO_HOME: picoHome },
    homeDir,
    picoHome,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    loadPicoProjectConfig: async (path) => {
      configReads.push(path);
      return {
        compatibility: {
          claude: {
            enabled: compatibilityEnabled,
            projectResources: true,
            userResources: false,
          },
        },
      };
    },
    pluginSnapshot: {
      skillSources: pluginSnapshot(pluginRoot).skillSources,
      agentSources: [
        {
          id: "plugin:fixture:agent:0",
          scope: "external",
          format: "pico-native",
          root: pluginAgentPath,
          priority: 38,
          adapter: "pico-agent-yaml",
        },
      ],
      mcpSources: [
        {
          id: "plugin:fixture:mcp:0",
          config: {
            mcpServers: {
              plugin: {
                name: "plugin",
                transport: "stdio",
                command: "never-execute",
                enabled: false,
              },
            },
          },
        },
      ],
    },
  };

  assert.deepEqual(
    (await listHostDesktopUserSkills(options)).skills.map(({ name }) => name),
    ["user"],
  );
  assert.deepEqual(configReads, []);
  const effective = await listHostDesktopEffectiveSkills(workspace, options);
  assert.deepEqual(effective.skills.map(({ name }) => name).sort(), ["native", "plugin", "user"]);
  assert.equal(effective.skills.find(({ name }) => name === "plugin")?.source.readOnly, true);
  assert.deepEqual(
    (await listHostDesktopSkills(workspace, true, options)).map(({ name }) => name).sort(),
    ["native", "plugin", "user"],
  );
  assert.deepEqual(
    (await listHostDesktopSkills(workspace, false, options)).map(({ name }) => name).sort(),
    ["claude", "native", "plugin"],
  );
  const agents = await listHostDesktopAgents(workspace, options);
  assert.ok(agents.some(({ name }) => name === "plugin-agent"));
  assert.ok(!agents.some(({ name }) => name === "claude-agent"));
  assert.deepEqual(configReads, [workspace, workspace, workspace]);

  compatibilityEnabled = true;
  assert.ok(
    (await listHostDesktopEffectiveSkills(workspace, options)).skills.some(
      ({ name }) => name === "claude",
    ),
  );
  assert.ok(
    (await listHostDesktopAgents(workspace, options)).some(({ name }) => name === "claude-agent"),
  );
  assert.deepEqual(
    (await listHostDesktopMcpServers(workspace, options)).map(({ name, sourceId, status }) => ({
      name,
      sourceId,
      status,
    })),
    [
      { name: "project", sourceId: "project", status: "disabled" },
      { name: "plugin", sourceId: "plugin:fixture:mcp:0", status: "disabled" },
    ],
  );
  assert.deepEqual(configReads, [workspace, workspace, workspace, workspace, workspace]);
});

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
    loadPicoProjectConfig,
    logger,
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
    loadPicoProjectConfig,
    logger,
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

test("Skill revision binds namespace and format but ignores Plugin materialization roots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-skill-stable-revision-"));
  const workspace = join(root, "workspace");
  const firstRoot = join(root, "runtime-copy-random-a", "skills");
  const secondRoot = join(root, "runtime-copy-random-b", "skills");
  await mkdir(workspace, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const skillRoot of [firstRoot, secondRoot]) {
    await writeSkill(skillRoot, "review", {
      description: "Stable plugin skill",
      body: "Review deterministically.",
    });
  }

  const first = await externalSkillSnapshot(
    workspace,
    externalSkillSource(firstRoot, { namespace: "fixture:", format: "pico-native" }),
  );
  const rematerialized = await externalSkillSnapshot(
    workspace,
    externalSkillSource(secondRoot, { namespace: "fixture:", format: "pico-native" }),
  );
  assert.equal(rematerialized.revision, first.revision);

  const renamedNamespace = await externalSkillSnapshot(
    workspace,
    externalSkillSource(secondRoot, { namespace: "renamed:", format: "pico-native" }),
  );
  assert.notEqual(renamedNamespace.revision, first.revision);
  const changedFormat = await externalSkillSnapshot(
    workspace,
    externalSkillSource(secondRoot, { namespace: "fixture:", format: "claude-compat" }),
  );
  assert.notEqual(changedFormat.revision, first.revision);
});

test("Skill scan and same-priority conflict winner are deterministic", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-skill-deterministic-conflict-"));
  const workspace = join(root, "workspace");
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(workspace, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeConflictSkill(firstRoot, "z-entry", "Z loses deterministically");
  await writeConflictSkill(firstRoot, "a-entry", "A wins deterministically");
  await writeConflictSkill(secondRoot, "a-entry", "A wins deterministically");
  await writeConflictSkill(secondRoot, "z-entry", "Z loses deterministically");

  const firstLoader = externalSkillLoader(workspace, externalSkillSource(firstRoot));
  const secondLoader = externalSkillLoader(workspace, externalSkillSource(secondRoot));
  assert.equal((await firstLoader.list())[0]?.description, "A wins deterministically");
  assert.equal((await secondLoader.list())[0]?.description, "A wins deterministically");
  assert.equal((await firstLoader.snapshot()).revision, (await secondLoader.snapshot()).revision);
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

function externalSkillSource(
  root: string,
  options: {
    readonly namespace?: string;
    readonly format?: ExternalResourceCatalogSource["format"];
  } = {},
): ExternalResourceCatalogSource<HookTrustAuthority> {
  return {
    id: "plugin:fixture:skill:stable:0",
    scope: "external",
    format: options.format ?? "pico-native",
    root,
    priority: 38,
    ...(options.namespace ? { namespace: options.namespace } : {}),
  };
}

function externalSkillLoader(
  workspace: string,
  source: ExternalResourceCatalogSource<HookTrustAuthority>,
): SkillLoader {
  return new SkillLoader(workspace, {
    includeUserResources: false,
    includeClaudeProjectResources: false,
    externalSources: [source],
  });
}

async function externalSkillSnapshot(
  workspace: string,
  source: ExternalResourceCatalogSource<HookTrustAuthority>,
) {
  return externalSkillLoader(workspace, source).snapshot();
}

async function writeConflictSkill(root: string, directory: string, description: string) {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "SKILL.md"),
    await skillDocument("shared-conflict", { description, body: `${description}.` }),
    "utf8",
  );
}
