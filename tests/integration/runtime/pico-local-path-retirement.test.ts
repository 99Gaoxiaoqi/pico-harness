import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentCatalog } from "../../../src/agents/catalog.js";
import { SkillLoader } from "../../../src/context/skill.js";
import { ResourceDoctor } from "../../../src/diagnostics/resource-doctor.js";
import { loadHookSnapshot } from "../../../src/hooks/config.js";
import { createHookifyProposal, loadHookifyRules } from "../../../src/hooks/hookify/rules.js";
import { resolveProjectMcpConfigPath } from "../../../src/mcp/config-path.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  prepareBackgroundAutonomousPolicy,
} from "../../../src/safety/background-autonomous-policy.js";
import { AgentProfileLoader } from "../../../src/tools/agent-profile.js";

test("Pico local resource loaders ignore retired .claw inputs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-local-path-retired-"));
  const workspace = join(root, "workspace");
  const homeDir = join(root, "home");
  const picoHome = join(homeDir, ".pico");
  const retiredRoot = join(workspace, ".claw");
  await Promise.all([
    mkdir(join(workspace, ".pico", "skills", "native"), { recursive: true }),
    mkdir(join(retiredRoot, "skills", "retired"), { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(
    join(workspace, ".pico", "skills", "native", "SKILL.md"),
    skillDocument("native", "Native Pico skill"),
    "utf8",
  );
  await writeFile(
    join(retiredRoot, "skills", "retired", "SKILL.md"),
    skillDocument("retired", "Retired Claw skill"),
    "utf8",
  );
  await writeFile(
    join(workspace, ".pico", "agents.yaml"),
    agentDocument("native-agent", "Native Pico agent"),
    "utf8",
  );
  await writeFile(
    join(retiredRoot, "agents.yaml"),
    agentDocument("retired-agent", "Retired Claw agent"),
    "utf8",
  );
  await writeFile(join(retiredRoot, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
  await writeFile(
    join(retiredRoot, "hooks.local.json"),
    JSON.stringify({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "retired" }] }] }),
    "utf8",
  );
  await writeFile(
    join(retiredRoot, "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "false" }] }] } }),
    "utf8",
  );
  await writeFile(join(retiredRoot, "hookify.retired.local.md"), "not a Pico rule\n", "utf8");

  const skills = await new SkillLoader(workspace, {
    homeDir,
    picoHome,
    includeClaudeProjectResources: false,
    includeClaudeUserResources: false,
  }).list();
  assert.deepEqual(
    skills.map(({ name }) => name),
    ["native"],
  );

  const profiles = await new AgentProfileLoader(workspace).load();
  assert.deepEqual(
    profiles.map(({ name }) => name),
    ["native-agent"],
  );
  const catalog = await loadAgentCatalog({
    workDir: workspace,
    homeDir,
    picoHome,
    includeBuiltins: false,
    includeClaudeProjectResources: false,
    includeClaudeUserResources: false,
  });
  assert.deepEqual(
    catalog.map(({ name }) => name),
    ["native-agent"],
  );

  const mcp = await resolveProjectMcpConfigPath(workspace);
  assert.deepEqual(mcp, {
    path: join(workspace, ".pico", "mcp.json"),
    source: "pico",
    exists: false,
  });

  const hooks = await loadHookSnapshot({ workDir: workspace, picoHome });
  assert.equal(
    Object.values(hooks.snapshot.handlers).flat().length,
    0,
    "retired hook files must not contribute handlers",
  );
  assert.ok(hooks.sources.every(({ source }) => !source.path.includes(".claw")));

  const proposal = createHookifyProposal({ workDir: workspace, description: "block unsafe shell" });
  await writeFile(proposal.targetPath, proposal.content, "utf8");
  assert.deepEqual(
    (await loadHookifyRules(workspace)).map(({ id }) => id),
    [proposal.rule.id],
  );

  const report = await new ResourceDoctor({ workDir: workspace, homeDir, picoHome }).scan();
  assert.ok(report.entries.every(({ path }) => !path.includes(".claw")));
});

test("background policy ignores a retired .claw settings file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-background-claw-retired-"));
  const workspace = join(root, "workspace");
  const retiredRoot = join(workspace, ".claw");
  await mkdir(retiredRoot, { recursive: true });
  await writeFile(join(retiredRoot, "settings.json"), "{ invalid legacy json", "utf8");
  context.after(() => rm(root, { recursive: true, force: true }));

  const prepared = await prepareBackgroundAutonomousPolicy({
    workDir: workspace,
    policy: {
      mode: "full-access",
      backgroundEnabled: true,
      trustedWorkspace: true,
      toolNetworkPolicy: "disabled",
      allowedTools: [],
      hardlineVersion: BACKGROUND_HARDLINE_VERSION,
      hookVersion: BACKGROUND_HOOK_VERSION,
      createdAt: Date.now(),
    },
    trustStore: {
      async canonicalize() {
        return workspace;
      },
      async isTrusted() {
        return true;
      },
    },
  });
  assert.equal(prepared.hookRunner, undefined);
});

function skillDocument(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nInstructions.\n`;
}

function agentDocument(name: string, systemPrompt: string): string {
  return [
    "agents:",
    `  - name: ${name}`,
    `    description: ${name}`,
    `    systemPrompt: ${systemPrompt}`,
    "    tools: [read_file]",
    "",
  ].join("\n");
}
