import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
  DesktopConversationStateStore,
  DesktopRuntimeService,
  DesktopSessionStateStore,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeService,
  type DaemonRunExecution,
} from "../../src/daemon/index.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

describe("Desktop catalog activation integration", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("在无 Git 的 Shared Folder 由 daemon 解析 Agent/Skill 并应用运行限制", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-catalog-"));
    cleanups.push(root);
    const workspace = join(root, "notes");
    await mkdir(join(workspace, ".pico", "skills", "review"), { recursive: true });
    await writeFile(
      join(workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "local/default",
        providers: {
          local: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "PICO_TEST_TOKEN",
            models: ["default", "special"],
            discoverModels: false,
          },
        },
      }),
    );
    await writeFile(
      join(workspace, ".pico", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Review a target",
        "allowed-tools:",
        "  - read_file",
        "model: local/special",
        "---",
        "Inspect $ARGUMENTS and report findings.",
      ].join("\n"),
    );
    await writeFile(
      join(workspace, ".pico", "agents.yaml"),
      [
        "agents:",
        "  - name: reviewer",
        "    description: Delegate a focused review",
        "    systemPrompt: Review only the requested target.",
        "    tools:",
        "      - read_file",
      ].join("\n"),
    );

    const canonical = await realpath(workspace);
    const trust = new WorkspaceTrustStore({ userStateDirectory: join(root, "trust") });
    await trust.trust(canonical);
    const executions: Array<{
      prompt: string;
      sessionId?: string;
      execution?: DaemonRunExecution;
    }> = [];
    const registration = new WorkspaceRegistrationStore(join(root, "workspaces.json"));
    const runtime = new WorkspaceRuntimeService({
      registrationStore: registration,
      execute: async ({ prompt, sessionId, execution, context }) => {
        if (sessionId) context.bindSession(sessionId);
        executions.push({
          prompt,
          ...(sessionId ? { sessionId } : {}),
          ...(execution ? { execution } : {}),
        });
      },
    });
    const service = new DesktopRuntimeService({
      runtimeService: runtime,
      registrationStore: registration,
      trustStore: trust,
      sessionStateStore: new DesktopSessionStateStore({
        filePath: join(root, "desktop-sessions.json"),
      }),
      conversationStateStore: new DesktopConversationStateStore({
        filePath: join(root, "desktop-conversations.json"),
      }),
      env: { PICO_TEST_TOKEN: "secret" },
    });

    try {
      await expect(
        service.handle(createRuntimeRequest("catalog.agents", { workspacePath: workspace })),
      ).resolves.toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({
            name: "reviewer",
            tools: ["read_file"],
          }),
        ]),
      });
      await expect(
        service.handle(createRuntimeRequest("catalog.skills", { workspacePath: workspace })),
      ).resolves.toMatchObject({
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: "review",
            allowedTools: ["read_file"],
            model: "local/special",
          }),
        ]),
      });

      const skillSend = (await service.handle(
        createRuntimeRequest("session.send", {
          workspacePath: workspace,
          input: { kind: "skill", name: "review", args: "src/runtime.ts" },
          idempotencyKey: "skill-activation",
        }),
      )) as { run: { runId: string } };
      const workspaceRuntime = await runtime.getWorkspaceRuntime(workspace);
      await workspaceRuntime.waitForRun(skillSend.run.runId);
      expect(workspaceRuntime.mode).toBe("folder");
      expect(executions[0]).toMatchObject({
        prompt: expect.stringContaining('<pico-skill-loaded name="review" trigger="user-slash"'),
        execution: {
          requestedModel: "local/special",
          allowedTools: ["read_file"],
        },
      });
      expect(executions[0]?.prompt).toContain("Inspect src/runtime.ts and report findings.");

      const agentSend = (await service.handle(
        createRuntimeRequest("session.send", {
          workspacePath: workspace,
          input: { kind: "agent", name: "reviewer", task: "Review storage boundaries" },
          idempotencyKey: "agent-activation",
        }),
      )) as { run: { runId: string } };
      await workspaceRuntime.waitForRun(agentSend.run.runId);
      expect(executions[1]).toMatchObject({
        prompt: expect.stringContaining('"agent_name": "reviewer"'),
        execution: { allowedTools: ["delegate_task"] },
      });
      expect(executions[1]?.prompt).toContain('"goal": "Review storage boundaries"');
    } finally {
      await service.close();
    }
  });
});
