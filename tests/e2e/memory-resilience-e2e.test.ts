import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { JsonlMemoryStore } from "../../src/memory/jsonl-memory-store.js";
import { MemoryNudger } from "../../src/memory/memory-nudger.js";
import { SkillRegistry } from "../../src/memory/skill-registry.js";

describe("memory resilience integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    resetSessionSettingsForTests();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("rebuilds degraded search and summaries from durable files after restart", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-memory-resilience-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    const sessionId = "memory-resilience";
    const degradedReason = "better-sqlite3 requires another Node ABI";
    const recommendation = "Run npm rebuild better-sqlite3 under the active Node runtime.";

    const first = new Session(sessionId, workDir, {
      persistence: true,
      memorySearchStore: new JsonlMemoryStore({
        reason: degradedReason,
        recommendation,
      }),
    });
    first.append({ role: "user", content: "记住唯一标识：青铜猫头鹰计划" });
    first.append({ role: "assistant", content: "已记录青铜猫头鹰计划。" });
    first.saveMemorySummary("用户确定了青铜猫头鹰计划。", 2);
    await first.flushPersistence();
    await first.close();

    const restored = new Session(sessionId, workDir, {
      persistence: true,
      memorySearchStore: new JsonlMemoryStore({
        reason: degradedReason,
        recommendation,
      }),
    });
    await restored.recover();

    expect(restored.length).toBe(2);
    expect(restored.memoryStatus).toMatchObject({
      backend: "jsonl_memory",
      state: "degraded",
      persistentSource: "session_jsonl",
      reason: degradedReason,
    });
    expect(restored.search("青铜猫头鹰")).toEqual([
      expect.objectContaining({
        sessionId,
        turnIndex: 0,
        content: expect.stringContaining("青铜猫头鹰"),
      }),
      expect.objectContaining({
        sessionId,
        turnIndex: 1,
        content: expect.stringContaining("青铜猫头鹰"),
      }),
    ]);
    expect(restored.sessionSummaryStore.get(sessionId)?.summary).toBe("用户确定了青铜猫头鹰计划。");

    const skillRegistry = new SkillRegistry(workDir);
    await skillRegistry.init();
    const nudge = await new MemoryNudger(skillRegistry, restored.sessionSummaryStore).generate(
      sessionId,
      10,
    );
    expect(nudge).toContain("本次对话要点");
    expect(nudge).toContain("用户确定了青铜猫头鹰计划");

    const registry = await createPicoCommandRegistry({
      workDir,
      session: restored,
      sessionId,
      provider: "openai",
      model: "integration-model",
    });
    const status = await processUserInput("/status", { registry });
    const statusMessage = status.type === "local-command" ? status.result.message : "";
    expect(statusMessage).toContain("Memory: jsonl_memory (degraded; source=session_jsonl)");
    expect(statusMessage).toContain(degradedReason);

    const doctor = await processUserInput("/doctor", { registry });
    const doctorMessage = doctor.type === "local-command" ? doctor.result.message : "";
    expect(doctorMessage).toContain(`ABI ${process.versions.modules}`);
    expect(doctorMessage).toContain(recommendation);

    const sessionLog = await readFile(
      join(workDir, ".claw", "sessions", `${sessionId}.jsonl`),
      "utf8",
    );
    expect(sessionLog).toContain("青铜猫头鹰计划");
    const summaries = await readFile(join(workDir, ".claw", "memory", "summaries.json"), "utf8");
    expect(summaries).toContain("用户确定了青铜猫头鹰计划");

    await restored.close();
  });
});
