import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { PICO_TOOL_GROUPS } from "@pico/runtime/tool-surface";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { resolvePicoPaths } from "@pico/pico-host";

test("retired memory_learn is absent from discovery and cannot write through an old tool allowlist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-lesson-retired-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "legacy-profile";
  await mkdir(workDir);
  await mkdir(picoHome);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const lifecycle = new AtomicMemoryLifecycle();
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  t.after(async () => {
    await closeExecutionLearningWorker(picoHome);
    await lifecycle.close();
    for (const id of [sessionId, `${sessionId}-allowlist`])
      await globalSessionManager.delete(id, workDir, { picoHome })?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(
    PICO_TOOL_GROUPS.some((group) => group.toolNames.includes("memory_learn")),
    false,
  );
  await assert.rejects(
    executeAgentRuntime(
      {
        prompt: "检查旧工具范围。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: `${sessionId}-allowlist` },
        provider: "openai",
        modelRouteId: "test/test",
        permissionMode: "full-access",
        allowedTools: ["memory_learn"],
      },
      {
        picoHome,
        memoryTrustStore: trust,
        atomicMemoryLifecycle: lifecycle,
        reporter: new SilentReporter(),
        provider: {
          async generate() {
            throw new Error("A retired command tool must be rejected before model dispatch");
          },
        },
      },
    ),
    /未知工具: memory_learn/u,
  );
  let step = 0;
  const run = await executeAgentRuntime(
    {
      prompt: "检查旧经验工具已经退役。",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      permissionMode: "full-access",
      allowedTools: ["memory_search"],
    },
    {
      picoHome,
      memoryTrustStore: trust,
      atomicMemoryLifecycle: lifecycle,
      reporter: new SilentReporter(),
      provider: {
        async generate(messages, tools) {
          assert.equal(
            tools.some((tool) => tool.name === "memory_learn"),
            false,
          );
          if (step++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "legacy-proposal",
                  name: "memory_learn",
                  arguments: JSON.stringify({
                    action: "propose",
                    lesson: "A retired tool cannot retain this lesson.",
                    taskFamily: "LegacyCheck",
                    failure: { toolCallId: "historical-failure" },
                  }),
                },
              ],
            };
          const result = messages.findLast((message) => message.toolCallId === "legacy-proposal");
          assert.match(result?.content ?? "", /不存在|不可用|unknown|unavailable/iu);
          return { role: "assistant", content: "retired" };
        },
      },
      atomicMemoryModelFactory: async () => {
        throw new Error("This retirement check does not extract user facts");
      },
    },
  );
  assert.equal(run.finalMessage, "retired");
  const key = resolvePicoPaths(workDir, { picoHome }).workspace.id;
  assert.deepEqual(await store.listItems({ workspaceKey: key }), []);
  assert.deepEqual(await store.executionLearning.listAdmissions(), []);
});
