import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelRoute } from "../../src/provider/model-router.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";

import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

// Windows 宿主方言为 PowerShell(对齐 maka)。真实模型收到 PowerShell 工具
// 描述后,bash 工具调用必须经 PowerShell 宿主成功执行——用含随机 UUID 的
// canary 文件名证明输出来自真实 spawn(模型无法凭空猜出 UUID)。
realModelTest(
  "real model executes bash tool through the PowerShell host on Windows",
  { timeout: TEST_TIMEOUT_MS, skip: process.platform !== "win32" },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-ps-host-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workDir, { recursive: true });
    await mkdir(picoHome, { recursive: true });
    context.after(() => rm(root, { recursive: true, force: true }));

    const canary = `PICO_PS_CANARY_${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}.txt`;
    await writeFile(join(workDir, canary), "canary\n", "utf8");

    const sessionId = `ps-host-${randomUUID()}`;
    await new AgentRuntime().execute(
      {
        provider: model.provider,
        baseURL: model.config.baseURL,
        apiKey: model.config.apiKey,
        model: model.config.model,
        modelRouteId: model.route.id,
        modelCapabilities: model.route.capabilities,
        ...(supportsThinkingOff(model.route) ? { thinkingEffort: "off" } : {}),
        prompt:
          "使用 bash 工具执行命令 Get-ChildItem(不要添加其他参数或命令)," +
          "然后在最终回复中原样列出输出中出现的每个文件名。禁止使用 read_file/glob/grep。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        allowedTools: ["bash"],
      } satisfies RunAgentCliOptions,
      {
        picoHome,
        env: process.env,
        modelRouter: model.runtime.router,
        reporter: new SilentReporter(),
      } satisfies RunAgentCliDependencies,
    );

    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    let events: RuntimeEvent[];
    try {
      events = await store.readSession(sessionId);
    } finally {
      store.close();
    }

    const bashSuccesses = events.filter(
      (event) =>
        event.kind === "tool.result.recorded" &&
        event.data.toolName === "bash" &&
        event.data.status === "succeeded",
    );
    assert.ok(bashSuccesses.length > 0, "bash 工具必须至少成功执行一次");
    assert.ok(
      events.some((event) => JSON.stringify(event).includes(canary)),
      "事件流必须包含 canary 文件名——它是随机 UUID,只有 PowerShell 真实执行 Get-ChildItem 才可能产生",
    );
    assert.equal(
      events.findLast((event) => event.kind === "run.terminal")?.data.status,
      "completed",
    );
  },
);

function supportsThinkingOff(route: ModelRoute): boolean {
  const profile = route.capabilities.reasoningProfile;
  return profile.enabled === true && profile.levels.includes("off");
}
