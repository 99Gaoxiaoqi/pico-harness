import assert from "node:assert/strict";
import test from "node:test";
import type { MobileProjectId, RuntimeSession } from "@pico/protocol";
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
