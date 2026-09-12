import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookService } from "../../../src/hooks/service.js";
import { globalSessionPermissionGrants } from "../../../src/approval/session-permissions.js";
import { UserConfigStore } from "../../../src/input/user-config-store.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import { executeAgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";

const searchRecord = {
  calls: [
    {
      toolCallId: "ws-1",
      toolName: "web_search",
      input: { query: "official docs" },
      status: "completed",
    },
  ],
  sources: [{ url: "https://example.com/docs", title: "Docs" }],
};

test("native search follows user settings and runtime tool/network ceilings, and persists actual search evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-native-search-runtime-")));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const store = new UserConfigStore({ picoHome });
  try {
    for (const scenario of [
      {
        id: "off",
        enabled: false,
        source: "model",
        permission: "full-access",
        allowedTools: ["web_search"],
        expected: "absent",
      },
      {
        id: "native",
        enabled: true,
        source: "model",
        permission: "full-access",
        allowedTools: ["web_search"],
        expected: "native",
      },
      {
        id: "hook-deny",
        enabled: true,
        source: "model",
        permission: "full-access",
        allowedTools: ["web_search"],
        expected: "absent",
      },
      {
        id: "ask-with-network",
        enabled: true,
        source: "model",
        permission: "ask",
        allowedTools: ["web_search"],
        expected: "absent",
      },
      {
        id: "no-network",
        enabled: true,
        source: "model",
        permission: "ask",
        allowedTools: ["web_search"],
        expected: "absent",
      },
      {
        id: "tool-ceiling",
        enabled: true,
        source: "model",
        permission: "full-access",
        allowedTools: ["read_file"],
        expected: "absent",
      },
      {
        id: "external",
        enabled: true,
        source: "external",
        permission: "full-access",
        allowedTools: ["web_search"],
        expected: "external",
      },
    ] as const) {
      const current = await store.read();
      await store.write(
        {
          version: 1,
          providers: {},
          defaults: { webSearch: { enabled: scenario.enabled, source: scenario.source } },
        },
        { expectedRevision: current.revision },
      );
      if (scenario.id === "ask-with-network")
        globalSessionPermissionGrants.addNetwork(scenario.id, workDir, picoHome);
      const hookService =
        scenario.id === "hook-deny"
          ? new HookService({
              workDir,
              sessionId: scenario.id,
              executor: {
                async execute() {
                  return { decision: "allow" };
                },
              },
              decisionProviders: [
                {
                  evaluate(event) {
                    return { decision: event === "PreToolUse" ? "deny" : "allow" };
                  },
                },
              ],
            })
          : undefined;
      let observed = false;
      const result = await executeAgentRuntime(
        {
          prompt: "Inspect the available search capability and answer.",
          dir: workDir,
          sessionSelection: { mode: "new", sessionId: scenario.id },
          provider: "responses",
          modelRouteId: "openai/gpt-4.1",
          model: "gpt-4.1",
          baseURL: "https://api.openai.com/v1",
          auth: "none",
          modelCapabilities: resolveModelRouteCapabilities("responses", "gpt-4.1", undefined, {
            baseURL: "https://api.openai.com/v1",
          }),
          collaborationMode: "agent",
          permissionMode: scenario.permission,
          allowedTools: [...scenario.allowedTools],
        },
        {
          picoHome,
          env: {
            PICO_HOME: picoHome,
            SEARCH_API_BASE: "https://search.example",
            SEARCH_API_KEY: "fixture",
          },
          ...(hookService ? { hookService } : {}),
          maxTurns: 2,
          reporter: new SilentReporter(),
          provider: {
            async generate(_messages, tools) {
              observed = true;
              const search = tools.find((tool) => tool.name === "web_search");
              if (scenario.expected === "absent") assert.equal(search, undefined, scenario.id);
              else if (scenario.expected === "native")
                assert.equal(search?.providerTool?.kind, "openai-web-search");
              else {
                assert.ok(search);
                assert.equal(search.providerTool, undefined);
              }
              return {
                role: "assistant",
                content: "Capability checked",
                ...(scenario.expected === "native"
                  ? { providerData: { picoWebSearch: searchRecord } }
                  : {}),
              };
            },
          },
        },
      );
      assert.ok(observed);
      assert.equal(result.finalMessage, "Capability checked");
      if (scenario.expected === "native") {
        const eventStore = new SqliteRuntimeEventStore({
          storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
        });
        try {
          const page = await eventStore.readTranscriptProjectionPage({
            sessionId: scenario.id,
            maxBytes: 256_000,
          });
          const payloads = page.items.map((item) => item.payload as Record<string, unknown>);
          assert.deepEqual(
            payloads.find((item) => item.kind === "assistantMessage")?.webSearch,
            searchRecord,
          );
          const events = await eventStore.readSession(scenario.id);
          assert.equal(
            events.filter((event) => event.kind === "tool.result.recorded").length,
            0,
            "provider-executed searches never dispatch locally",
          );
        } finally {
          eventStore.close();
        }
      }
    }
  } finally {
    await globalSessionManager.clearAndDrain();
    globalSessionPermissionGrants.clear();
    await rm(root, { recursive: true, force: true });
  }
});
