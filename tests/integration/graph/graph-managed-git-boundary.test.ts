import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRuntime } from "@pico/pico-host/agent-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "@pico/runtime";

test("Graph Operator exposes host-managed Git only with full access", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-graph-git-boundary-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  context.after(async () => {
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  });
  const profileSnapshot = createBuiltinAgentGraphOperatorProfileCatalog().resolve({
    profileId: "implement",
    rootModelRouteId: "test/test",
  });
  for (const mode of ["ask", "full-access"] as const) {
    let offered: readonly string[] = [];
    let prompt = "";
    let generated = 0;
    let gitCalls = 0;
    await new AgentRuntime().execute(
      {
        prompt: "Inspect the available Graph tools.",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: `graph-git-${mode}` },
        provider: "openai",
        modelRouteId: "test/test",
        collaborationMode: "agent",
        permissionMode: mode,
        allowedTools: ["agent_output", "graph_git"],
      },
      {
        picoHome,
        isolatedHeadless: true,
        reporter: new SilentReporter(),
        maxTurns: 2,
        agentGraph: {
          kind: "operator",
          executionPermissionMode: mode,
          getActivationContext: () => undefined,
          outputPort: {} as never,
          managedGit: {
            async execute() {
              gitCalls++;
              return { branch: "pico/graph-test", head: "test-head", output: "" };
            },
          },
          profileSnapshot,
        },
        provider: {
          async generate(messages, tools) {
            generated++;
            offered = tools.map((tool) => tool.name);
            prompt = messages[0]?.content ?? "";
            if (generated === 1) {
              return {
                role: "assistant",
                content: "",
                toolCalls: [
                  { id: `git-${mode}`, name: "graph_git", arguments: '{"operation":"status"}' },
                ],
              };
            }
            return { role: "assistant", content: "done" };
          },
        },
      },
    );
    assert.equal(offered.includes("graph_git"), mode === "full-access");
    assert.equal(prompt.includes("隔离工作树 Git 必须使用 graph_git"), mode === "full-access");
    assert.equal(gitCalls, mode === "full-access" ? 1 : 0);
  }
});
