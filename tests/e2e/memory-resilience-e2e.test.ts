import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { InMemorySearchStore } from "../../src/memory/in-memory-search-store.js";
import type {
  ConversationSearchStore,
  MemoryBackendStatus,
  MemorySearchResult,
} from "../../src/memory/memory-store.js";
import { MemoryNudger } from "../../src/memory/memory-nudger.js";
import type { Message } from "../../src/schema/message.js";
import { SkillRegistry } from "../../src/memory/skill-registry.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

class RuntimeDegradingStore implements ConversationSearchStore {
  status: MemoryBackendStatus = {
    backend: "sqlite_fts5",
    state: "healthy",
    persistentSource: "sqlite",
    nodeVersion: process.version,
    nodeModuleAbi: process.versions.modules,
  };

  insert(_sessionId: string, _turnIndex: number, _message: Message): void {
    this.status = {
      ...this.status,
      state: "degraded",
      reason: "simulated SQLite write failure",
      recommendation: "restart after checking the database",
    };
  }

  replaceSession(_sessionId: string, _messages: readonly Message[]): void {}
  search(_query: string, _limit?: number, _sessionId?: string): MemorySearchResult[] {
    return [];
  }
  close(): void {}
}

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
      memorySearchStore: new InMemorySearchStore({
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
      memorySearchStore: new InMemorySearchStore({
        reason: degradedReason,
        recommendation,
      }),
    });
    await restored.recover();

    expect(restored.length).toBe(2);
    expect(restored.memoryStatus).toMatchObject({
      backend: "in_memory",
      state: "degraded",
      persistentSource: "sqlite",
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
    expect(statusMessage).toContain("Memory: in_memory (degraded; source=sqlite)");
    expect(statusMessage).toContain(degradedReason);

    const doctor = await processUserInput("/doctor", { registry });
    const doctorMessage = doctor.type === "local-command" ? doctor.result.message : "";
    expect(doctorMessage).toContain(`ABI ${process.versions.modules}`);
    expect(doctorMessage).toContain(recommendation);

    const workspacePaths = resolvePicoPaths(workDir).workspace;
    const runtimeStore = new RuntimeEventStore({ databasePath: workspacePaths.runtimeDatabase });
    expect(JSON.stringify(await runtimeStore.readSession(sessionId))).toContain("青铜猫头鹰计划");
    await expect(access(join(workspacePaths.root, "sessions"))).rejects.toThrow();
    const summaries = await readFile(join(workspacePaths.memory, "summaries.json"), "utf8");
    expect(summaries).toContain("用户确定了青铜猫头鹰计划");

    await restored.close();
  });

  it("switches to in-memory search and rebuilds history after an FTS5 failure", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-memory-runtime-fallback-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    const session = new Session("runtime-fallback", workDir, {
      persistence: false,
      memorySearchStore: new RuntimeDegradingStore(),
    });

    session.append({ role: "user", content: "运行期降级后仍可搜索青铜灯塔" });

    expect(session.memoryStatus).toMatchObject({
      backend: "in_memory",
      state: "degraded",
      persistentSource: "none",
      reason: "simulated SQLite write failure",
    });
    expect(session.search("青铜灯塔")).toEqual([
      expect.objectContaining({
        sessionId: "runtime-fallback",
        turnIndex: 0,
        content: expect.stringContaining("青铜灯塔"),
      }),
    ]);

    await session.close();
  });
});
