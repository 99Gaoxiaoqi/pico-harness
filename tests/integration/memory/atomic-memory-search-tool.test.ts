import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message, ToolDefinition } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { buildMemorySearchTool } from "@pico/pico-host/memory-trigger-tools";

test("runtime memory_search is read-only, scope-bound and rechecks admission in Agent/Plan/Research/Responses", async (t) => {
  for (const profile of [
    "agent",
    "plan",
    "research",
    "responses",
    "headless",
    "untrusted",
    "disabled",
    "revoked",
    "restricted",
  ] as const) {
    await t.test(profile, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pico-memory-search-"));
      const workDir = join(root, "workspace"),
        picoHome = join(root, "home"),
        sessionId = `search-${profile}`;
      await mkdir(workDir);
      const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      if (profile !== "untrusted") await trust.trust(await trust.canonicalize(workDir));
      const lifecycle = new AtomicMemoryLifecycle();
      const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
      const paths = resolvePicoPaths(workDir, { picoHome });
      t.after(async () => {
        await lifecycle.close();
        await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      });
      const seed = await store.applyMutations({
        operationId: "seed",
        mutations: [
          {
            type: "create",
            item: {
              content: "SearchAnchor has the answer SafeMarker832.",
              kind: "knowledge",
              statementType: "fact",
              temporalType: "undated",
              scopeType: "workspace",
              scopeKey: paths.workspace.id,
              observedAt: 1,
              origin: "user_requested",
              keys: [{ key: "unrelated", keyType: "concept", keyOrigin: "user" }],
              sources: [],
            },
          },
          {
            type: "create",
            item: {
              content: "SearchAnchor has the secret OtherWorkspace932.",
              kind: "knowledge",
              statementType: "fact",
              temporalType: "undated",
              scopeType: "workspace",
              scopeKey: "other-workspace",
              observedAt: 1,
              origin: "user_requested",
              keys: [{ key: "unrelated", keyType: "concept", keyOrigin: "user" }],
              sources: [],
            },
          },
        ],
      });
      const before = await store.readItem(seed.results[0]!.itemId);
      let calls = 0,
        auxiliaryCalls = 0;
      let surface: readonly ToolDefinition[] = [];
      let toolOutput = "";
      await executeAgentRuntime(
        {
          prompt: "检索 SearchAnchor",
          dir: workDir,
          sessionSelection: { mode: "new", sessionId },
          provider: profile === "responses" ? "responses" : "openai",
          modelRouteId: "test/test",
          collaborationMode: profile === "plan" || profile === "research" ? profile : "agent",
          ...(["headless", "untrusted"].includes(profile)
            ? {}
            : {
                allowedTools: profile === "restricted" ? [] : ["memory_search"],
              }),
        },
        {
          picoHome,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          isolatedHeadless: profile === "headless",
          reporter: new SilentReporter(),
          atomicMemoryModelFactory: async () => ({
            model: {
              async call() {
                auxiliaryCalls++;
                return "{}";
              },
            },
          }),
          provider: {
            async generate(messages: Message[], tools?: readonly ToolDefinition[]) {
              if (calls++ === 0) {
                surface = tools ?? [];
                if (["headless", "untrusted", "restricted"].includes(profile))
                  return { role: "assistant", content: "Unavailable." };
                if (profile === "disabled") {
                  const settings = await store.readSettings(paths.workspace.id);
                  await store.updateSettings({
                    workspaceKey: paths.workspace.id,
                    expectedVersion: settings.version,
                    recallEnabled: false,
                  });
                }
                if (profile === "revoked")
                  await trust.setTrusted(await trust.canonicalize(workDir), false);
                return {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    { id: "search", name: "memory_search", arguments: '{"query":"SearchAnchor"}' },
                  ],
                };
              }
              toolOutput = messages
                .filter(({ toolCallId }) => toolCallId !== undefined)
                .map(({ content }) => content)
                .join("\n");
              if (profile === "plan")
                return {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    {
                      id: "submit",
                      name: "submit_plan",
                      arguments: JSON.stringify({
                        title: "Verify remembered fact",
                        steps: [{ title: "Verify", description: "Read SearchAnchor fact." }],
                      }),
                    },
                  ],
                };
              return { role: "assistant", content: "Done." };
            },
          },
        },
      );
      const unavailable = ["headless", "untrusted", "restricted"].includes(profile);
      assert.equal(
        surface.some(({ name }) => name === "memory_search"),
        !unavailable,
      );
      if (["disabled", "revoked"].includes(profile)) {
        assert.match(toolOutput, /Memory search unavailable/);
        assert.ok(!toolOutput.includes("SafeMarker832"));
      } else if (!unavailable) {
        assert.match(toolOutput, /SafeMarker832/);
        assert.match(toolOutput, /trust="low"/);
        assert.ok(!toolOutput.includes("OtherWorkspace932"));
      }
      assert.equal(auxiliaryCalls, 0);
      assert.deepEqual(await store.readItem(seed.results[0]!.itemId), before);
    });
  }
  const tool = buildMemorySearchTool({ search: async () => "unused" });
  for (const args of ["{}", '{"query":" "}', '{"query":"x","workspacePath":"other"}'])
    await assert.rejects(tool.execute(args), /query only/);
});
