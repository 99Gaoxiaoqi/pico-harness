import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

const hasRealLlmConfig = Boolean(
  process.env.RUN_LLM_E2E === "1" &&
  process.env.LLM_BASE_URL &&
  process.env.LLM_API_KEY &&
  process.env.LLM_MODEL,
);
const describeRealLLM = hasRealLlmConfig ? describe : describe.skip;

describeRealLLM("RuntimeEvent real-model recovery", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("recovers a second model turn from runtime.sqlite after process-memory eviction", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-real-runtime-recovery-"));
    const paths = resolvePicoPaths(workDir);
    cleanupPaths.push(workDir, paths.workspace.root);
    const sessionId = `real-runtime-recovery-${Date.now()}`;
    const marker = "PICO_RUNTIME_SQLITE_MEMORY_7F2C9A";

    const first = await new AgentRuntime().execute(
      {
        prompt: `Remember this exact marker for the next turn: ${marker}. Reply only ACK.`,
        dir: workDir,
        session: sessionId,
      },
      { provider: realProvider(), reporter: new SilentReporter() },
    );
    expect(first.finalMessage.trim().length).toBeGreaterThan(0);

    // Force the next request through Session recovery instead of reusing process memory.
    globalSessionManager.clear();

    const second = await new AgentRuntime().execute(
      {
        prompt:
          "What exact marker did I ask you to remember in the previous turn? Reply only with the marker.",
        dir: workDir,
        session: sessionId,
      },
      { provider: realProvider(), reporter: new SilentReporter() },
    );
    expect(second.finalMessage).toContain(marker);

    globalSessionManager.clear();
    const recovered = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    expect(
      recovered
        .getModelContext()
        .map((message) => message.content)
        .join("\n"),
    ).toContain(marker);

    const store = new RuntimeEventStore({ databasePath: paths.workspace.runtimeDatabase });
    const events = await store.readSession(sessionId);
    const startedRunIds = events
      .filter((event) => event.kind === "run.started")
      .map((event) => event.runId);
    const terminalRunIds = new Set(
      events.filter((event) => event.kind === "run.terminal").map((event) => event.runId),
    );
    expect(startedRunIds.length).toBeGreaterThanOrEqual(2);
    expect(startedRunIds.every((runId) => terminalRunIds.has(runId))).toBe(true);
    expect(
      events.filter((event) => event.kind === "message.committed").length,
    ).toBeGreaterThanOrEqual(4);
    await expect(access(join(paths.workspace.root, "sessions"))).rejects.toThrow();
    await expect(access(join(paths.workspace.root, "runs"))).rejects.toThrow();
  });
});

function realProvider(): OpenAIProvider {
  return new OpenAIProvider({
    baseURL: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
  });
}
