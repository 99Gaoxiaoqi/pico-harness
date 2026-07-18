import assert from "node:assert/strict";
import test from "node:test";
import { createTypedRuntimeRequest } from "../../src/daemon/protocol.js";
import type { DesktopRequestHandlers } from "../../src/daemon/desktop-request-router.js";
import {
  createDesktopSessionRequestHandlers,
  type DesktopSessionRequestContext,
} from "../../src/daemon/desktop-session-request-handlers.js";

test("desktop session handlers keep protocol mapping separate from the service owner", async () => {
  const calls: string[] = [];
  const context: DesktopSessionRequestContext = {
    initializeWorkspace: async (workspacePath) => ({ workspacePath }),
    listWorkspaces: async () => ({ workspaces: [] }),
    trustStatus: async () => ({ trusted: true }),
    setTrust: async (_workspacePath, trusted) => ({ trusted }),
    unregisterWorkspace: async (workspacePath) => ({ workspacePath, unregistered: true }),
    listSessions: async () => ({ sessions: [] }),
    getSession: async () => ({ session: {} }),
    createSession: async () => ({ session: {} }),
    setSessionArchived: async (_workspacePath, _sessionId, archived) => ({ archived }),
    renameSession: async (_workspacePath, _sessionId, title) => ({ title }),
    forkSession: async () => ({ session: {}, sourceSessionId: "source" }),
    compactSession: async () => ({ session: {}, compacted: true }),
    getRuntimeSessionSettings: async () => ({ settings: {} }),
    updateRuntimeSessionSettings: async () => ({ settings: {} }),
    getGoal: async () => ({ goal: null }),
    sendSession: async (params) => {
      calls.push(`send:${params.input.text}`);
      return { disposition: "started" };
    },
    getSessionTranscript: async () => ({ items: [] }),
    cancelRun: async (_workspacePath, runId) => ({ runId, cancelled: true }),
    withProviderDependencyLock: async (operation) => await operation(),
    runStart: async () => ({ started: true }),
  };
  const handlers = createDesktopSessionRequestHandlers(context);

  const send = handlers["session.send"] as DesktopRequestHandlers["session.send"];
  assert.ok(send);
  assert.deepEqual(
    await send(
      createTypedRuntimeRequest("session.send", {
        workspacePath: "/workspace",
        input: { text: "hello" },
        idempotencyKey: "request-1",
      }),
    ),
    { disposition: "started" },
  );
  assert.deepEqual(calls, ["send:hello"]);

  const archive = handlers["session.archive"] as DesktopRequestHandlers["session.archive"];
  assert.ok(archive);
  assert.deepEqual(
    await archive(
      createTypedRuntimeRequest("session.archive", {
        workspacePath: "/workspace",
        sessionId: "session-1",
      }),
    ),
    { archived: true },
  );
});
