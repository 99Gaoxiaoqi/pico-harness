import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalSessionPermissionGrants } from "../src/approval/session-permissions.js";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { SessionForkService } from "../src/engine/session-fork-service.js";
import { SessionManager } from "../src/engine/session.js";
import { SessionStore } from "../src/engine/session-store.js";
import { FileSessionSummaryStore } from "../src/memory/summary-store.js";
import {
  createFileHistoryState,
  fileHistoryBeginRewindPoint,
  fileHistoryLoadState,
} from "../src/safety/file-history.js";
import type { ToolCall } from "../src/schema/message.js";
import { SessionCatalog } from "../src/storage/session-catalog.js";
import { SessionCatalogProjector } from "../src/storage/session-catalog-projection.js";
import { JobService } from "../src/tasks/job-service.js";

describe("session fork published mainline", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    globalSessionPermissionGrants.clear();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("freezes a complete scene and publishes exactly once after a sidecar crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-fork-mainline-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const fileHistoryBaseDir = join(root, "file-history");
    const catalog = new SessionCatalog({ baseDirectory: join(root, "catalog") });
    const projector = new SessionCatalogProjector(catalog);
    const manager = new SessionManager();
    const sourceId = "source-session";
    const targetId = "target-session";
    const operationId = "fork-mainline";
    const source = await manager.getOrCreate(sourceId, workDir, {
      persistence: true,
      sessionCatalog: false,
    });
    const artifactStore = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    });
    const sourceArtifact = await artifactStore.write({
      id: "artifact-mainline",
      sessionId: sourceId,
      toolName: "bash",
      args: { command: "large output" },
      output: "durable artifact body",
    });
    const sourceUri =
      "artifact://" +
      encodeURIComponent(sourceId) +
      "/" +
      encodeURIComponent(sourceArtifact.id);
    await source.commitMessages(
      { role: "user", content: "实现存储架构演进" },
      {
        role: "assistant",
        content:
          "[大型工具输出已外部化]\nartifactUri: " +
          sourceUri +
          "\nartifactPath: " +
          sourceArtifact.path,
        usage: { promptTokens: 120, completionTokens: 45 },
        providerData: { artifactPath: sourceArtifact.path, artifactUri: sourceUri },
      },
    );
    source.updateRuntimeState({
      settings: {
        title: "存储演进",
        provider: "openai",
        model: "glm-5.2",
        modelRouteId: "volcengine/glm-5.2",
        mode: "plan",
        prePlanMode: "auto",
        thinkingEffort: "high",
        thinkingEffortExplicit: true,
        additionalDirectories: [join(root, "secret-extra-root")],
      },
      goal: {
        stateVersion: 1,
        sequence: 1,
        activeGoalId: "goal-1",
        goals: [
          {
            id: "goal-1",
            title: "完成存储演进",
            description: "保持可恢复与原子发布",
            status: "active",
            createdAt: 100,
            budgetUsage: { turns: 2, tokens: 500, costCNY: 1.2, startedAt: 100 },
          },
        ],
      },
      usage: {
        totalPromptTokens: 120,
        totalCompletionTokens: 45,
        totalInputTokens: 120,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalReasoningTokens: 0,
        totalCostCNY: 1.2,
        lastCostStatus: "estimated",
        totalProviderCalls: 1,
        totalUsageReports: 1,
        totalInputReports: 1,
        totalCacheReadReports: 0,
        totalCacheWriteReports: 0,
        totalReasoningReports: 0,
        totalEstimatedCostReports: 1,
        totalIncludedCostReports: 0,
        totalUnknownCostReports: 0,
      },
    });
    await source.flushPersistence();
    const sourceForkPoint = await source.readDurableForkSnapshot();
    source.sessionSummaryStore.save(sourceId, "source summary", 2, {
      throughEventId: sourceForkPoint.cursor.eventId,
      messageCount: 2,
      prefixDigest: createHash("sha256").update("source-prefix").digest("hex"),
    });
    const fileHistory = createFileHistoryState();
    await fileHistoryBeginRewindPoint(
      fileHistory,
      {
        messageId: "message-1",
        userPrompt: "实现存储架构演进",
        messageIndex: 0,
        sourceMessageEventId: sourceForkPoint.cursor.eventId,
        beforeSessionSeq: sourceForkPoint.cursor.seq,
      },
      sourceId,
      fileHistoryBaseDir,
    );
    globalSessionPermissionGrants.add(sourceId, { type: "tool", toolName: "bash" });
    const jobs = new JobService({ workDir });
    jobs.dispatch({
      jobId: "source-job",
      type: "worker",
      executionClass: "recoverable",
      completionPolicy: "required",
      description: "must remain owned by source",
      ownerSessionId: sourceId,
    });

    let injected = false;
    const crashing = new SessionForkService({
      workDir,
      sessionManager: manager,
      catalogProjector: projector,
      fileHistoryBaseDir,
      createOperationId: () => operationId,
      hooks: {
        afterSidecars() {
          if (injected) return;
          injected = true;
          throw new Error("injected crash after sidecars");
        },
      },
    });
    await expect(
      crashing.fork({
        sourceSessionId: sourceId,
        targetSessionId: targetId,
        targetMode: "yolo",
      }),
    ).rejects.toThrow("injected crash after sidecars");

    const targetPath = join(workDir, ".claw", "sessions", targetId + ".jsonl");
    await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(catalog.list({ sessionProjectDir: workDir })).resolves.toEqual([]);
    await expect(crashing.journal.get(operationId)).resolves.toMatchObject({
      state: "workspace_applied",
      sourceCursor: sourceForkPoint.cursor,
    });

    // workspace_applied 后 source 可继续推进；重启只能发布已经冻结的 bundle。
    await source.commitMessages({ role: "user", content: "fork 之后的新消息" });
    await source.flushPersistence();
    const restarted = new SessionForkService({
      workDir,
      sessionManager: manager,
      catalogProjector: projector,
      fileHistoryBaseDir,
    });
    await expect(restarted.reconcileUnfinished()).resolves.toEqual([
      { operationId, state: "completed" },
    ]);
    const publishedHash = createHash("sha256").update(await readFile(targetPath)).digest("hex");
    await expect(restarted.reconcileUnfinished()).resolves.toEqual([]);
    expect(createHash("sha256").update(await readFile(targetPath)).digest("hex")).toBe(
      publishedHash,
    );

    const prepared = await new SessionStore(targetPath).inspectJournal({ strict: true });
    expect(prepared.records.map((record) => record.type === "event" && record.kind)).toEqual([
      "session.seeded",
      "runtime.checkpoint",
    ]);
    const target = await manager.getOrCreate(targetId, workDir, {
      persistence: true,
      sessionCatalog: false,
    });
    const hydration = await target.readHydrationSnapshot();
    expect(hydration.messages).toHaveLength(2);
    expect(hydration.messages.some((message) => message.content.includes("fork 之后"))).toBe(false);
    expect(hydration.messages.every((message) => message.usage === undefined)).toBe(true);
    const targetArtifact = (await artifactStore.readMeta(sourceArtifact.id, targetId))!;
    expect(hydration.messages[1]?.content).toContain(targetArtifact.path);
    expect(hydration.messages[1]?.content).toContain(
      "artifact://" +
        encodeURIComponent(targetId) +
        "/" +
        encodeURIComponent(sourceArtifact.id),
    );
    expect(hydration.messages[1]?.providerData).toMatchObject({
      artifactPath: targetArtifact.path,
    });
    expect(await artifactStore.read(targetArtifact)).toBe("durable artifact body");
    expect(hydration.runtime.settings).toMatchObject({
      title: "Fork of 存储演进",
      forkFrom: sourceId,
      modelRouteId: "volcengine/glm-5.2",
      mode: "yolo",
      thinkingEffort: "high",
      additionalDirectories: [],
    });
    expect(hydration.runtime.settings).not.toHaveProperty("prePlanMode");
    expect(hydration.runtime.goal).toEqual(sourceForkPoint.hydration.runtime.goal);
    expect(hydration.runtime.usage).toMatchObject({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalProviderCalls: 0,
    });

    const targetFileHistory = createFileHistoryState();
    await expect(
      fileHistoryLoadState(targetFileHistory, targetId, fileHistoryBaseDir),
    ).resolves.toBe(true);
    expect(targetFileHistory.snapshots).toHaveLength(1);
    expect(
      new FileSessionSummaryStore(join(workDir, ".claw", "memory", "summaries.json")).get(
        targetId,
      ),
    ).toMatchObject({
      summary: "source summary",
      basis: { throughEventId: sourceForkPoint.cursor.eventId, messageCount: 2 },
    });
    const catalogEntry = (await catalog.list({ sessionProjectDir: workDir })).find(
      (entry) => entry.sessionId === targetId,
    );
    expect(catalogEntry).toMatchObject({
      sessionId: targetId,
      lineage: {
        relation: "fork",
        parentLogId: sourceForkPoint.cursor.logId,
        forkEventId: sourceForkPoint.cursor.eventId,
        parentSessionId: sourceId,
      },
    });

    const bashCall = {
      id: "bash-call",
      name: "bash",
      arguments: JSON.stringify({ command: "pwd" }),
    } satisfies ToolCall;
    expect(globalSessionPermissionGrants.allows(sourceId, bashCall, workDir)).toBe(true);
    expect(globalSessionPermissionGrants.allows(targetId, bashCall, workDir)).toBe(false);
    expect(jobs.list({ ownerSessionId: sourceId })).toHaveLength(1);
    expect(jobs.list({ ownerSessionId: targetId })).toHaveLength(0);

    jobs.close();
    await target.close();
    await source.close();
  });
});
