import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { globalSessionManager } from "../../src/engine/session.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";

test("runtime refuses bare LLM environment credentials without a host-resolved user route", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-user-model-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  context.after(async () => {
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    executeAgentRuntime(
      {
        prompt: "This request must not reach the legacy endpoint.",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: "runtime-user-model-config" },
        provider: "openai",
        model: "legacy-model",
        modelRouteId: "legacy/legacy-model",
      },
      {
        picoHome,
        env: {
          PICO_HOME: picoHome,
          LLM_BASE_URL: "https://legacy-provider.invalid/v1",
          LLM_API_KEY: "legacy-key-must-not-be-used",
          LLM_MODEL: "legacy-model",
        },
        isolatedHeadless: true,
      },
    ),
    /宿主必须从用户模型路由注入 baseURL 和 apiKey/u,
  );
});
