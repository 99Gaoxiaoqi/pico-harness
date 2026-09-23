import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import { createProvider } from "@pico/pico-host/provider/factory";
import type { SessionRuntime } from "@pico/pico-host/session-runtime";
import { bindRuntimeHookCapabilities } from "../../packages/pico-host/src/runtime-hook-assembly.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";
const realTest = process.env.RUN_COMPACTION_E2E === "1" ? test : test.skip;
realTest("Hook子会话真实模型读取两步证据、压缩后返回准确JSON", { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-real-"));
  const session = new Session("parent", root, {
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  });
  const configured = await configuredUserDefaultRealModel();
  const provider = createProvider(configured.provider, {
    ...configured.config,
    sessionId: randomUUID(),
  });
  type Binding = Parameters<SessionRuntime["bindHookRuntime"]>[0];
  let binding: Binding | undefined;
  let summaries = 0;
  let acceptedSteps = 0;
  const budget = {
    contextWindowTokens: 128000,
    declaredContextWindowTokens: 128000,
    inputBudgetTokens: 118976,
    reservedOutputTokens: 8000,
    safetyMarginTokens: 1024,
  };
  const marker = `MARKER_${randomUUID().replaceAll("-", "")}`;
  const second = `${randomUUID()}.txt`;
  try {
    await session.recover();
    await writeFile(
      join(root, "first.txt"),
      `第二份证据位于 ${second}，读取它后返回其中的精确标记。`,
    );
    await writeFile(join(root, second), `核验成功，精确标记：${marker}`);
    bindRuntimeHookCapabilities({
      session,
      runtimeState: {
        bindHookRuntime(value: Binding) {
          binding = value;
        },
      } as SessionRuntime,
      provider: {
        generate: async (messages, tools, options) => {
          if (options?.maxOutputTokens === 8000) summaries++;
          const result = await provider.generate(messages, tools, options);
          if (options?.maxOutputTokens !== 8000 && ++acceptedSteps === 2) {
            assert.ok(result.usage && result.usage.promptTokens > 0);
            // Lower only the test declaration after two complete tool steps provide a safe cut.
            budget.declaredContextWindowTokens =
              result.usage.promptTokens + result.usage.completionTokens;
          }
          return result;
        },
      },
      workDir: root,
      workspaceRoots: WorkspaceRoots.createSync(root),
      picoHome: join(root, "home"),
      runtimeEnv: {},
      sandboxConfig: { network: "deny" },
      mcpManager: () => undefined,
      contextRouteIdentity: "real-hook",
      contextBudget: budget,
    });
    const result = await binding!.agentVerifier!.verify({
      prompt:
        '先用 read_file 读取 first.txt，再单独读取它指向的第二个文件。只能使用 read_file。完成两次读取后返回 {"ok":true,"reason":"第二个文件中的精确标记"}。',
      input: {
        session_id: session.id,
        cwd: root,
        hook_event_name: "Stop",
        payload: { reason: "test" },
      },
      maxTurns: 5,
      readonlyToolsOnly: true,
      suppressHooks: true,
      signal: new AbortController().signal,
    });
    assert.deepEqual(JSON.parse(String(result)), { ok: true, reason: marker });
    assert.ok(summaries > 0, "must actually summarize using real provider");
    assert.equal(session.getHistory().length, 0);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
