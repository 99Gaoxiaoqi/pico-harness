import assert from "node:assert/strict";
import test from "node:test";
import type {
  MobileProjectId,
  MobileRealtimeEvent,
  RuntimeConversationItem,
  RuntimeNotification,
  RuntimeRun,
  RuntimeSession,
  SessionId,
} from "@pico/protocol";
import type { RuntimeClient } from "../../src/daemon/client.js";
import { MobileGatewayService } from "../../src/mobile-gateway/service.js";

const projectId = "opaque-project" as MobileProjectId;
const workspacePath = "/private/workspaces/pico-harness";

test("mobile gateway service strips workspace authority from session results", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const runtime = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      return { sessions: [runtimeSession()] };
    },
  } as unknown as Pick<RuntimeClient, "request">;
  const service = new MobileGatewayService(
    {
      listProjects: async () => [],
      resolveProjectPath: async (receivedProjectId) => {
        assert.equal(receivedProjectId, projectId);
        return workspacePath;
      },
    },
    runtime,
  );

  const sessions = await service.listSessions(projectId);

  assert.deepEqual(requests, [
    { method: "session.list", params: { workspacePath, includeArchived: false } },
  ]);
  assert.deepEqual(sessions, [
    {
      sessionId: "session-1",
      title: "Mobile foundation",
      status: "active",
      pinned: true,
      createdAt: 10,
      updatedAt: 20,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(sessions), /workspacePath|\/private\/workspaces/);
});

test("mobile gateway service rejects Runtime sessions from another project", async () => {
  const runtime = {
    async request() {
      return { sessions: [runtimeSession("/private/workspaces/other")] };
    },
  } as unknown as Pick<RuntimeClient, "request">;
  const service = new MobileGatewayService(
    { listProjects: async () => [], resolveProjectPath: async () => workspacePath },
    runtime,
  );

  await assert.rejects(() => service.listSessions(projectId), /outside the authorized project/);
});

test("mobile gateway service strips private fields from transcripts and active runs", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const runtime = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      return {
        session: runtimeSession(),
        items: [
          { id: "user-1", kind: "userMessage", content: "Continue" },
          {
            id: "goal-1",
            kind: "goal",
            title: "Ship mobile",
            state: "active",
            data: { workspacePath, sourcePath: `${workspacePath}/PLAN.md` },
          },
        ] satisfies RuntimeConversationItem[],
        activeRun: runtimeRun(),
        queuedInputs: [],
        nextBefore: "cursor-1",
        revision: "revision-1",
      };
    },
  } as unknown as Pick<RuntimeClient, "request">;
  const service = new MobileGatewayService(
    { listProjects: async () => [], resolveProjectPath: async () => workspacePath },
    runtime,
  );

  const transcript = await service.getTranscript(projectId, "session-1" as SessionId);

  assert.deepEqual(requests, [
    {
      method: "session.transcript",
      params: { workspacePath, sessionId: "session-1", limit: 100 },
    },
  ]);
  assert.deepEqual(transcript, {
    session: {
      sessionId: "session-1",
      title: "Mobile foundation",
      status: "active",
      pinned: true,
      createdAt: 10,
      updatedAt: 20,
    },
    items: [
      { id: "user-1", kind: "userMessage", content: "Continue" },
      { id: "goal-1", kind: "goal", title: "Ship mobile", state: "active" },
    ],
    activeRun: {
      runId: "run-1",
      sessionId: "session-1",
      description: "Continue",
      status: "running",
      startedAt: 21,
      updatedAt: 22,
    },
    nextBefore: "cursor-1",
    revision: "revision-1",
  });
  assert.doesNotMatch(JSON.stringify(transcript), /workspacePath|sourcePath|\/private\/workspaces/);
});

test("mobile gateway service validates the session before forwarding text input", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const runtime = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "session.get") return { session: runtimeSession() };
      return { session: runtimeSession(), run: runtimeRun(), disposition: "started" };
    },
  } as unknown as Pick<RuntimeClient, "request">;
  const service = new MobileGatewayService(
    { listProjects: async () => [], resolveProjectPath: async () => workspacePath },
    runtime,
  );

  const result = await service.sendMessage(projectId, {
    sessionId: "session-1",
    text: "Continue",
    idempotencyKey: "mobile-message-1",
  });

  assert.deepEqual(requests, [
    { method: "session.get", params: { workspacePath, sessionId: "session-1" } },
    {
      method: "session.send",
      params: {
        workspacePath,
        sessionId: "session-1",
        input: { kind: "text", text: "Continue" },
        idempotencyKey: "mobile-message-1",
      },
    },
  ]);
  assert.deepEqual(result, {
    session: {
      sessionId: "session-1",
      title: "Mobile foundation",
      status: "active",
      pinned: true,
      createdAt: 10,
      updatedAt: 20,
    },
    run: {
      runId: "run-1",
      sessionId: "session-1",
      description: "Continue",
      status: "running",
      startedAt: 21,
      updatedAt: 22,
    },
    disposition: "started",
  });
  assert.doesNotMatch(JSON.stringify(result), /workspacePath|\/private\/workspaces/);
});

test("mobile gateway service rejects a cross-project session before sending", async () => {
  let sendCalls = 0;
  const runtime = {
    async request(method: string) {
      if (method === "session.send") sendCalls += 1;
      return { session: runtimeSession("/private/workspaces/other") };
    },
  } as unknown as Pick<RuntimeClient, "request">;
  const service = new MobileGatewayService(
    { listProjects: async () => [], resolveProjectPath: async () => workspacePath },
    runtime,
  );

  await assert.rejects(
    () =>
      service.sendMessage(projectId, {
        sessionId: "session-1",
        text: "Continue",
        idempotencyKey: "mobile-message-1",
      }),
    /outside the authorized project/,
  );
  assert.equal(sendCalls, 0);
});

test("mobile gateway service projects only one session realtime events", async () => {
  const events: MobileRealtimeEvent[] = [];
  let runtimeListener: ((notification: RuntimeNotification) => void) | undefined;
  let disposed = false;
  const runtime = {
    async request() {
      return { session: runtimeSession() };
    },
    async subscribe(_params: unknown, listener: (notification: RuntimeNotification) => void) {
      runtimeListener = listener;
      return {
        replay: {
          subscribed: true,
          events: [runNotification("run.started")],
          hasMore: false,
        },
        dispose: () => {
          disposed = true;
        },
      };
    },
  } as unknown as Pick<RuntimeClient, "request" | "subscribe">;
  const service = new MobileGatewayService(
    { listProjects: async () => [], resolveProjectPath: async () => workspacePath },
    runtime,
  );

  const subscription = await service.subscribeEvents(projectId, "session-1", (event) =>
    events.push(event),
  );
  assert.ok(runtimeListener);
  runtimeListener(liveNotification(workspacePath));
  runtimeListener(liveNotification("/private/workspaces/other"));

  assert.deepEqual(events, [
    {
      type: "run",
      run: {
        runId: "run-1",
        sessionId: "session-1",
        description: "Continue",
        status: "running",
        startedAt: 21,
        updatedAt: 22,
      },
    },
    {
      type: "live",
      runId: "run-1",
      item: {
        kind: "assistantMessage",
        operation: "append",
        streamId: "assistant:run-1:1",
        turnId: "turn:run-1:1",
        delta: "Hello",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /workspacePath|\/private\/workspaces/);
  subscription.dispose();
  assert.equal(disposed, true);
});

function runtimeSession(path = workspacePath): RuntimeSession {
  return {
    sessionId: "session-1",
    workspacePath: path,
    title: "Mobile foundation",
    status: "active",
    pinned: true,
    createdAt: 10,
    updatedAt: 20,
  };
}

function runtimeRun(path = workspacePath): RuntimeRun {
  return {
    runId: "run-1",
    workspacePath: path,
    sessionId: "session-1",
    description: "Continue",
    status: "running",
    startedAt: 21,
    updatedAt: 22,
    version: 1,
  };
}

function runNotification(
  topic: "run.started" | "run.updated" | "run.finished",
): RuntimeNotification {
  return {
    protocolVersion: 1,
    eventId: "event-run-1",
    topic,
    scope: { workspacePath, sessionId: "session-1", runId: "run-1" },
    resourceVersion: 1,
    at: 22,
    payload: { run: runtimeRun() },
  };
}

function liveNotification(path: string): RuntimeNotification {
  return {
    protocolVersion: 1,
    eventId: "event-live-1",
    topic: "run.live",
    scope: { workspacePath: path, sessionId: "session-1", runId: "run-1" },
    resourceVersion: 2,
    at: 23,
    payload: {
      runId: "run-1",
      item: {
        kind: "assistantMessage",
        operation: "append",
        streamId: "assistant:run-1:1",
        turnId: "turn:run-1:1",
        delta: "Hello",
      },
    },
  };
}
