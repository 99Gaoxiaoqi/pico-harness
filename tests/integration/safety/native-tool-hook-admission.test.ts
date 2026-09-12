import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHookSnapshot } from "../../../src/hooks/config.js";
import { HookService } from "../../../src/hooks/service.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

test("loaded conditional tool hooks require local admission without executing a synthetic query", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-native-hook-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(
    join(workDir, ".pico", "hooks.json"),
    JSON.stringify({
      PreToolUse: [
        {
          matcher: "web_search",
          if: { op: "contains", path: "tool_input.query", value: "private" },
          hooks: [{ type: "prompt", prompt: "Reject private queries" }],
        },
      ],
    }),
  );
  const { snapshot } = await loadHookSnapshot({ workDir, picoHome: join(root, "home") });
  let hookCalls = 0;
  let toolCalls = 0;
  const service = new HookService({
    workDir,
    sessionId: "admission-test",
    snapshot,
    executor: {
      async execute(_entry, input) {
        hookCalls++;
        assert.deepEqual(input.tool_input, { query: "private project" });
        return { decision: "deny", reason: "private query blocked" };
      },
    },
  });
  assert.equal(service.requiresLocalToolAdmission("web_search"), true);
  assert.equal(service.requiresLocalToolAdmission("read_file"), false);
  assert.equal(hookCalls, 0, "capability inspection must not execute hooks or manufacture input");
  const registry = new ToolRegistry();
  registry.setHookService(service);
  registry.register({
    name: () => "web_search",
    readOnly: true,
    definition: () => ({
      name: "web_search",
      description: "Fixture local search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }),
    execute: async () => {
      toolCalls++;
      return "must not search";
    },
  });
  const result = await registry.execute({
    id: "search-1",
    name: "web_search",
    arguments: JSON.stringify({ query: "private project" }),
  });
  assert.equal(result.isError, true);
  assert.match(result.output, /private query blocked/);
  assert.equal(hookCalls, 1);
  assert.equal(toolCalls, 0);
});
