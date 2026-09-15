import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SideChatAuthority,
  SideChatNoSettledTurnError,
  latestCompletedTurnBoundary,
  readSideChatLeases,
} from "@pico/pico-host/side-chat-authority";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import type { RuntimeTerminalStatus } from "@pico/core";
import { closeAllOperationalDatabasesForTest } from "@pico/storage";
import { Session, SessionManager } from "@pico/pico-host/session";
import { SessionForkService } from "@pico/pico-host/session-fork-service";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createSessionForkRuntimePort } from "@pico/pico-host/session-fork-runtime-port-adapter";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { getOrCreateSessionSettings } from "@pico/pico-host/input/session-settings";
import { ingestDesktopRuntimeNotification } from "@pico/pico-host/desktop-transcript-persistence";
import { projectTranscriptEvents } from "@pico/pico-host/transcript-event-store";
import { createRuntimeNotification } from "@pico/protocol";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";

function terminal(eventId: string, status: RuntimeTerminalStatus): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId: "source",
    invocationId: `invocation-${eventId}`,
    runId: `run-${eventId}`,
    turnId: `turn-${eventId}`,
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    kind: "run.terminal",
    data: { status },
  };
}

test("side chat selects only the latest successfully completed turn", () => {
  const events = [terminal("completed-1", "completed"), terminal("failed", "failed")];
  assert.equal(latestCompletedTurnBoundary(events)?.eventId, "completed-1");
  assert.equal(latestCompletedTurnBoundary([terminal("failed", "failed")]), undefined);
});

test("侧聊真实 fork 包含完成回合晚到的 answered 记录，并排除下一回合", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-side-chat-settled-tail-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  const manager = new SessionManager();
  const source = await manager.getOrCreate("source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  let target: Session | undefined;
  const service = new SessionForkService({
    workDir,
    picoHome,
    sessionManager: manager,
    runtimeStore: source.runtimeEventStore!,
    runtimePort: createSessionForkRuntimePort(),
  });
  try {
    getOrCreateSessionSettings(
      {
        sessionId: source.id,
        cwd: workDir,
        picoHome,
        provider: "openai",
        model: "test",
        modelRouteId: "openai/test",
        collaborationMode: "agent",
        permissionMode: "ask",
      },
      { persistence: source },
    );
    await source.flushPersistence();
    const run = await RuntimeRun.start({
      capability: source.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    const scope = { workspacePath: workDir, sessionId: source.id, runId: "desktop-run" };
    await run.run(async () => {
      await run.commitMessages(source, [{ role: "user", content: "choose a format" }]);
      await ingestDesktopRuntimeNotification(
        source,
        createRuntimeNotification({
          eventId: "prompt-requested",
          topic: "prompt.requested",
          scope,
          resourceVersion: 1,
          at: 1,
          payload: { promptId: "prompt-1", prompt: { question: "YAML?", options: [] } },
        }),
        projectTranscriptEvents,
      );
    });
    await ingestDesktopRuntimeNotification(
      source,
      createRuntimeNotification({
        eventId: "prompt-answered",
        topic: "prompt.resolved",
        scope,
        resourceVersion: 2,
        at: 2,
        payload: { promptId: "prompt-1" },
      }),
      projectTranscriptEvents,
    );
    const events = await source.runtimeEventStore!.readSession(source.id);
    const boundary = latestCompletedTurnBoundary(events);
    assert.equal(boundary?.eventId, "transcript:prompt-answered");
    const nextRun = {
      ...terminal("next", "completed"),
      kind: "run.started" as const,
      data: { workDir, agentSwarmAuthorization: "none" as const },
    };
    const late = events.at(-1)!;
    assert.equal(
      latestCompletedTurnBoundary([...events, nextRun, { ...late, eventId: "later" }])?.eventId,
      boundary?.eventId,
    );
    const authority = new SideChatAuthority({
      storageRoot: join(root, "leases"),
      fork: async (input) => {
        await service.fork(input);
      },
      markSideConversation: async () => undefined,
      removeSession: async () => undefined,
    });
    await authority.create({
      panelId: "panel",
      sourceSessionId: source.id,
      targetSessionId: "side",
      sourceEvents: events,
    });
    target = new Session("side", workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    await target.recover();
    const page = await target.runtimeEventStore!.readTranscriptProjectionPage({
      sessionId: target.id,
      maxBytes: 512 * 1024,
    });
    const conversation = parseConversation(
      { items: page.items.map(({ payload }) => payload) },
      workDir,
      target.id,
    );
    const prompts = conversation.items.filter((item) => item.kind === "prompt");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.state, "answered");
  } finally {
    await target?.close();
    service.close();
    await manager.delete(source.id, workDir, { picoHome })?.close();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test("side chat persists a recoverable lease and removes it only after cleanup succeeds", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-side-chat-"));
  context.after(async () => {
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  const forked: unknown[] = [];
  const marked: string[] = [];
  const removed: string[] = [];
  const authority = new SideChatAuthority({
    storageRoot: join(root, "storage"),
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    fork: async (input) => void forked.push(input),
    markSideConversation: async (sessionId) => void marked.push(sessionId),
    removeSession: async (sessionId) => void removed.push(sessionId),
  });

  const lease = await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "side-1",
    sourceEvents: [terminal("completed", "completed"), terminal("failed", "failed")],
  });
  assert.equal(lease.state, "live");
  assert.deepEqual(forked, [
    { sourceSessionId: "source", targetSessionId: "side-1", throughEventId: "completed" },
  ]);
  assert.deepEqual(marked, ["side-1"]);
  assert.equal(readSideChatLeases(join(root, "storage")).length, 1);

  await authority.cleanup("side-1");
  assert.deepEqual(removed, ["side-1"]);
  assert.deepEqual(readSideChatLeases(join(root, "storage")), []);
});

test("side chat rejects creation when the parent has no completed turn", async () => {
  const authority = new SideChatAuthority({
    storageRoot: join(tmpdir(), `pico-side-chat-no-turn-${process.pid}`),
    fork: async () => undefined,
    markSideConversation: async () => undefined,
    removeSession: async () => undefined,
  });
  await assert.rejects(
    authority.create({
      panelId: "panel",
      sourceSessionId: "source",
      targetSessionId: "target",
      sourceEvents: [terminal("failed", "failed")],
    }),
    SideChatNoSettledTurnError,
  );
});

test("side chat live lease heartbeat postpones crash recovery cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-side-chat-heartbeat-"));
  context.after(async () => {
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  let now = new Date("2026-08-23T00:00:00.000Z");
  const removed: string[] = [];
  const authority = new SideChatAuthority({
    storageRoot: join(root, "storage"),
    now: () => now,
    liveLeaseTtlMs: 60_000,
    fork: async () => undefined,
    markSideConversation: async () => undefined,
    removeSession: async (sessionId) => void removed.push(sessionId),
  });

  await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "side-1",
    sourceEvents: [terminal("completed", "completed")],
  });
  now = new Date("2026-08-23T00:00:30.000Z");
  const refreshed = await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "unused-idempotent-target",
    sourceEvents: [terminal("completed", "completed")],
  });
  assert.equal(refreshed.targetSessionId, "side-1");
  assert.equal(refreshed.updatedAt, "2026-08-23T00:00:30.000Z");

  now = new Date("2026-08-23T00:01:15.000Z");
  await authority.recover();
  assert.deepEqual(removed, []);
  assert.equal(authority.list().length, 1);

  now = new Date("2026-08-23T00:01:31.000Z");
  await authority.recover();
  assert.deepEqual(removed, ["side-1"]);
  assert.deepEqual(authority.list(), []);
});
