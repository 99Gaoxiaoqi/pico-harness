import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalSessionPermissionGrants } from "../src/approval/session-permissions.js";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { SessionForkService } from "../src/engine/session-fork-service.js";
import { SessionManager } from "../src/engine/session.js";
import { FileSessionSummaryStore } from "../src/memory/summary-store.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import { materializeRuntimeHistory } from "../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../src/runtime/runtime-event-store.js";
import {
  createFileHistoryState,
  fileHistoryBeginRewindPoint,
  fileHistoryLoadState,
} from "../src/safety/file-history.js";
import type { ToolCall } from "../src/schema/message.js";
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
    const workspacePaths = resolvePicoPaths(workDir).workspace;
    const fileHistoryBaseDir = join(root, "file-history");
    const manager = new SessionManager();
    const sourceId = "source-session";
    const targetId = "target-session";
    const operationId = "fork-mainline";
    const source = await manager.getOrCreate(sourceId, workDir, { persistence: true });
    const artifactStore = new ToolResultArtifactStore({
      baseDir: workspacePaths.artifacts,
    });
    const sourceArtifact = await artifactStore.write({
      id: "artifact-mainline",
      sessionId: sourceId,
      toolName: "bash",
      args: { command: "large output" },
      output: "durable artifact body",
    });
    const sourceUri =
      "artifact://" + encodeURIComponent(sourceId) + "/" + encodeURIComponent(sourceArtifact.id);
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
    globalSessionPermissionGrants.add(sourceId, workDir, { type: "tool", toolName: "bash" });
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

    const runtimeStore = new RuntimeEventStore({
      databasePath: workspacePaths.runtimeDatabase,
    });
    await expect(runtimeStore.readSessionManifest(targetId)).resolves.toBeUndefined();
    await expect(crashing.journal.get(operationId)).resolves.toMatchObject({
      state: "workspace_applied",
      sourceCursor: sourceForkPoint.cursor,
      targetMode: "yolo",
    });

    // workspace_applied 后 source 可继续推进；重启只能发布已经冻结的 bundle。
    await source.commitMessages({ role: "user", content: "fork 之后的新消息" });
    await source.flushPersistence();
    const restarted = new SessionForkService({
      workDir,
      sessionManager: manager,
      fileHistoryBaseDir,
    });
    await expect(restarted.reconcileUnfinished()).resolves.toEqual([
      { operationId, state: "completed" },
    ]);
    const publishedHash = createHash("sha256")
      .update(JSON.stringify(await runtimeStore.readSession(targetId)))
      .digest("hex");
    await expect(restarted.reconcileUnfinished()).resolves.toEqual([]);
    expect(
      createHash("sha256")
        .update(JSON.stringify(await runtimeStore.readSession(targetId)))
        .digest("hex"),
    ).toBe(publishedHash);

    const target = await manager.getOrCreate(targetId, workDir, { persistence: true });
    const hydration = await target.readHydrationSnapshot();
    expect(hydration.messages).toHaveLength(2);
    expect(hydration.messages.some((message) => message.content.includes("fork 之后"))).toBe(false);
    expect(hydration.messages.every((message) => message.usage === undefined)).toBe(true);
    const runtimeEvents = await runtimeStore.readSession(targetId);
    expect(materializeRuntimeHistory(runtimeEvents)).toEqual(hydration.messages);
    expect(await runtimeStore.readSessionManifest(targetId)).toMatchObject({
      sessionId: targetId,
      historySource: "runtime-event-v1",
    });
    const targetArtifact = (await artifactStore.readMeta(sourceArtifact.id, targetId))!;
    expect(hydration.messages[1]?.content).toContain(targetArtifact.path);
    expect(hydration.messages[1]?.content).toContain(
      "artifact://" + encodeURIComponent(targetId) + "/" + encodeURIComponent(sourceArtifact.id),
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
    const completedFork = await restarted.journal.get(operationId);
    expect(completedFork).toMatchObject({ state: "completed" });
    expect(hydration.runtime.goal).toEqual({
      ...sourceForkPoint.hydration.runtime.goal,
      goals: sourceForkPoint.hydration.runtime.goal!.goals.map((goal) => ({
        ...goal,
        budgetUsage: {
          turns: 0,
          tokens: 0,
          costCNY: 0,
          startedAt: Date.parse(completedFork!.createdAt),
        },
      })),
    });
    expect(hydration.runtime.usage).toMatchObject({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalProviderCalls: 0,
    });

    const sourceThroughEventId = (await runtimeStore.readSessionEntries(sourceId))
      .filter(
        (entry) =>
          entry.sequence <= sourceForkPoint.cursor.seq && entry.event.kind === "message.committed",
      )
      .at(-1)?.event.eventId;

    const targetFileHistory = createFileHistoryState();
    await expect(
      fileHistoryLoadState(targetFileHistory, targetId, fileHistoryBaseDir),
    ).resolves.toBe(true);
    expect(targetFileHistory.snapshots).toHaveLength(1);
    expect(
      new FileSessionSummaryStore(join(workspacePaths.memory, "summaries.json")).get(targetId),
    ).toMatchObject({
      summary: "source summary",
      basis: { throughEventId: sourceForkPoint.cursor.eventId, messageCount: 2 },
    });
    expect(runtimeEvents.find((event) => event.kind === "session.forked")).toMatchObject({
      kind: "session.forked",
      data: {
        parentSessionId: sourceId,
        throughEventId: sourceThroughEventId,
        sourceDigest: expect.any(String) as string,
        messageCount: 2,
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

  it("keeps the requested target mode when a prepared fork is reconciled after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-fork-mode-recovery-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const manager = new SessionManager();
    const source = await manager.getOrCreate("mode-source", workDir, { persistence: true });
    await source.commitMessages({ role: "user", content: "先形成计划" });
    source.updateRuntimeState({
      settings: {
        provider: "openai",
        model: "glm-5.2",
        mode: "yolo",
        thinkingEffort: "high",
        thinkingEffortExplicit: true,
        additionalDirectories: [],
      },
    });
    await source.flushPersistence();
    let injected = false;
    const service = new SessionForkService({
      workDir,
      sessionManager: manager,
      fileHistoryBaseDir: join(root, "file-history"),
      createOperationId: () => "prepared-plan-fork",
      hooks: {
        afterSidecars() {
          if (injected) return;
          injected = true;
          throw new Error("pause before Runtime publish");
        },
      },
    });
    await expect(
      service.fork({
        sourceSessionId: source.id,
        targetSessionId: "mode-target",
        targetMode: "plan",
      }),
    ).rejects.toThrow("pause before Runtime publish");

    const restarted = new SessionForkService({
      workDir,
      sessionManager: manager,
      fileHistoryBaseDir: join(root, "file-history"),
    });
    await expect(restarted.reconcileUnfinished()).resolves.toEqual([
      { operationId: "prepared-plan-fork", state: "completed" },
    ]);
    const target = await manager.getOrCreate("mode-target", workDir, { persistence: true });
    expect((await target.readHydrationSnapshot()).runtime.settings).toMatchObject({
      mode: "plan",
      prePlanMode: "yolo",
      forkFrom: source.id,
    });
    await target.close();
    await source.close();
  });

  it("freezes File History in the same source-session boundary as the RuntimeEvent cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-fork-atomic-scene-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const fileHistoryBaseDir = join(root, "file-history");
    const manager = new SessionManager();
    const sourceId = "atomic-source";
    const targetId = "atomic-target";
    const source = await manager.getOrCreate(sourceId, workDir, { persistence: true });
    await source.commitMessages({ role: "user", content: "冻结这一幕" });
    await source.flushPersistence();
    const initialSnapshot = await source.readDurableForkSnapshot();
    const fileHistory = createFileHistoryState();
    await fileHistoryBeginRewindPoint(
      fileHistory,
      {
        messageId: "initial-point",
        userPrompt: "冻结这一幕",
        messageIndex: 0,
        sourceMessageEventId: initialSnapshot.cursor.eventId,
        beforeSessionSeq: initialSnapshot.cursor.seq,
      },
      sourceId,
      fileHistoryBaseDir,
    );

    const originalReadSnapshot = source.readDurableForkSnapshot.bind(source);
    let signalSnapshotRead!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotRead = new Promise<void>((resolve) => {
      signalSnapshotRead = resolve;
    });
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let firstRead = true;
    vi.spyOn(source, "readDurableForkSnapshot").mockImplementation(async () => {
      const snapshot = await originalReadSnapshot();
      if (firstRead) {
        firstRead = false;
        signalSnapshotRead();
        await snapshotGate;
      }
      return snapshot;
    });

    const service = new SessionForkService({
      workDir,
      sessionManager: manager,
      fileHistoryBaseDir,
    });
    const fork = service.fork({
      sourceSessionId: sourceId,
      targetSessionId: targetId,
      targetMode: "yolo",
    });
    await snapshotRead;

    const laterSourceMutation = source.serialize(async () => {
      await fileHistoryBeginRewindPoint(
        fileHistory,
        {
          messageId: "future-point",
          userPrompt: "fork 后的新一轮",
          messageIndex: 1,
          sourceMessageEventId: initialSnapshot.cursor.eventId,
          beforeSessionSeq: initialSnapshot.cursor.seq,
        },
        sourceId,
        fileHistoryBaseDir,
      );
    });
    // 未持有 source.serialize 的旧实现会在这个窗口完成 mutation，并把
    // future-point 克隆到旧 cursor 的 target。新实现中 mutation 必须排队。
    await Promise.race([
      laterSourceMutation,
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
    releaseSnapshot();
    await fork;
    await laterSourceMutation;

    const targetFileHistory = createFileHistoryState();
    await expect(
      fileHistoryLoadState(targetFileHistory, targetId, fileHistoryBaseDir),
    ).resolves.toBe(true);
    expect(targetFileHistory.snapshots.map((snapshot) => snapshot.messageId)).toEqual([
      "initial-point",
    ]);

    const sourceFileHistory = createFileHistoryState();
    await expect(
      fileHistoryLoadState(sourceFileHistory, sourceId, fileHistoryBaseDir),
    ).resolves.toBe(true);
    expect(sourceFileHistory.snapshots.map((snapshot) => snapshot.messageId)).toEqual([
      "initial-point",
      "future-point",
    ]);
    await source.close();
  });
});
