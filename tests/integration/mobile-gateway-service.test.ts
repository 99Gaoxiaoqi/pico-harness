import assert from "node:assert/strict";
import test from "node:test";
import type {
  MobileProjectId,
  RuntimeConversationItem,
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
