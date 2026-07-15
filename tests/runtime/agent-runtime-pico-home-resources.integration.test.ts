import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalSessionManager } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { PluginManagementService } from "../../src/plugins/plugin-management-service.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

class ResourceCapturingProvider implements LLMProvider {
  readonly agentCalls: Array<{ messages: readonly Message[]; tools: readonly ToolDefinition[] }> =
    [];
  readonly hookPrompts: string[] = [];

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    if (options?.purpose === "hook") {
      this.hookPrompts.push(messages.map((message) => message.content).join("\n"));
      return { role: "assistant", content: '{"ok":true,"reason":"profile hook observed"}' };
    }
    this.agentCalls.push({ messages: [...messages], tools: [...tools] });
    return {
      role: "assistant",
      content: "profile resources loaded",
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }
}

describe("AgentRuntime host-owned PICO_HOME resources", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    globalSessionManager.clear();
    resetSessionSettingsForTests();
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("loads only the host profile's Plugin, Skill, Agent and Hook resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-runtime-profile-resources-"));
    cleanups.push(root);
    const workDir = join(root, "workspace");
    const hostPicoHome = join(root, "host-home");
    const processPicoHome = join(root, "process-home");
    await Promise.all([
      mkdir(workDir, { recursive: true }),
      prepareProfile(hostPicoHome, workDir, "host"),
      prepareProfile(processPicoHome, workDir, "process"),
    ]);

    const previousPicoHome = process.env.PICO_HOME;
    process.env.PICO_HOME = processPicoHome;
    const provider = new ResourceCapturingProvider();
    try {
      await new AgentRuntime().execute(
        { prompt: "inspect isolated profile resources", dir: workDir },
        {
          provider,
          reporter: new SilentReporter(),
          picoHome: hostPicoHome,
          // The explicit host state root is authoritative even if a stale inherited env disagrees.
          env: { PICO_HOME: processPicoHome },
        },
      );
    } finally {
      if (previousPicoHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = previousPicoHome;
    }

    const firstCall = provider.agentCalls[0];
    expect(firstCall).toBeDefined();
    const systemPrompt = firstCall!.messages.find((message) => message.role === "system")?.content;
    expect(systemPrompt).toContain("host-user-skill");
    expect(systemPrompt).toContain("host-plugin:host-plugin-skill");
    expect(systemPrompt).not.toContain("process-user-skill");
    expect(systemPrompt).not.toContain("process-plugin:process-plugin-skill");

    const delegateTask = firstCall!.tools.find((tool) => tool.name === "delegate_task");
    const agentNames = (
      delegateTask?.inputSchema["properties"] as
        | { agent_name?: { enum?: readonly string[] } }
        | undefined
    )?.agent_name?.enum;
    expect(agentNames).toEqual(
      expect.arrayContaining(["host-user-agent", "host-plugin:host-plugin-agent"]),
    );
    expect(agentNames).not.toContain("process-user-agent");
    expect(agentNames).not.toContain("process-plugin:process-plugin-agent");
    expect(provider.hookPrompts).toHaveLength(1);
    expect(provider.hookPrompts[0]).toContain("HOST_PROFILE_HOOK");
    expect(provider.hookPrompts[0]).not.toContain("PROCESS_PROFILE_HOOK");
  });
});

async function prepareProfile(picoHome: string, workDir: string, profile: string): Promise<void> {
  await writeSkill(
    join(picoHome, "skills", `${profile}-user-skill`, "SKILL.md"),
    `${profile}-user-skill`,
  );
  await writeNativeAgent(join(picoHome, "agents.yaml"), `${profile}-user-agent`);
  await mkdir(picoHome, { recursive: true });
  await writeFile(
    join(picoHome, "hooks.json"),
    JSON.stringify({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "prompt",
              prompt: `${profile.toUpperCase()}_PROFILE_HOOK`,
            },
          ],
        },
      ],
    }),
  );

  const pluginDir = join(dirname(picoHome), `${profile}-plugin-source`);
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: `${profile}-plugin`,
      skills: "./SKILL.md",
      agents: "./agent.md",
    }),
  );
  await writeSkill(join(pluginDir, "SKILL.md"), `${profile}-plugin-skill`);
  await writeFile(
    join(pluginDir, "agent.md"),
    [
      "---",
      `name: ${profile}-plugin-agent`,
      `description: ${profile} plugin agent`,
      "tools: Read",
      "---",
      `Use only ${profile} plugin resources.`,
    ].join("\n"),
  );

  const service = new PluginManagementService({ workDir, picoHome });
  await service.install(pluginDir, "user");
  await service.trust(await service.prepareTrust({ id: `${profile}-plugin`, scope: "user" }));
  await service.enable({ id: `${profile}-plugin`, scope: "user" });
}

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    ["---", `name: ${name}`, `description: ${name} description`, "---", `${name} body`].join("\n"),
  );
}

async function writeNativeAgent(path: string, name: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      "agents:",
      `  - name: ${name}`,
      `    description: ${name} description`,
      `    systemPrompt: Use only ${name}.`,
      "    tools: [read_file]",
    ].join("\n"),
  );
}
