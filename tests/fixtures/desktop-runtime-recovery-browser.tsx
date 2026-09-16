/// <reference lib="dom" />
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TRANSCRIPT_PROJECTOR_VERSION, type RuntimeNotification } from "@pico/protocol";
import type { DesktopBridge } from "../../apps/desktop/src/preload/contract.js";
import { useRuntimeStore, type RuntimeStore } from "../../apps/desktop/src/renderer/runtime.js";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const workspaceA = "/project-a";
const workspaceB = "/project-b";
const trusted = new Set([workspaceA, workspaceB]);
let runs: { runId: string; status: string; version?: number; updatedAt?: number }[] = [];
let runsFailure = false;
let jobsFailure = false;
let holdTrust: Promise<void> | undefined;
let holdWorkspace: Promise<void> | undefined;
let listener: ((event: RuntimeNotification) => void) | undefined;
let subscribedWorkspace: string | undefined;
let eventSequence = 0;
const statusCalls: string[] = [];
const ok = (value: unknown) => ({ ok: true, value });
const failure = (message: string) => ({
  ok: false,
  error: { code: "TEST_FAILURE", message, retryable: false },
});
const session = {
  workspacePath: workspaceA,
  sessionId: "session-a",
  title: "Plan session",
  status: "active",
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
};
const bridge = {
  runtime: new Proxy(
    {},
    {
      get: (_, method: string) => async (params: { workspacePath?: string; trusted?: boolean }) => {
        const workspacePath = params.workspacePath ?? workspaceA;
        switch (method) {
          case "runtime.ping":
            return ok({ capabilities: ["session-conversation-v1"] });
          case "workspace.list":
            return ok({
              workspaces: [workspaceA, workspaceB].map((path) => ({
                workspacePath: path,
                registered: true,
              })),
            });
          case "workspace.status":
            statusCalls.push(workspacePath);
            if (workspacePath === workspaceB) await holdWorkspace;
            return ok({ workspacePath, mode: "folder" });
          case "workspace.trustStatus":
            return ok({ trusted: trusted.has(workspacePath) });
          case "workspace.trust":
            await holdTrust;
            if (params.trusted) trusted.add(workspacePath);
            else trusted.delete(workspacePath);
            return ok({ trusted: params.trusted });
          case "runs.list":
            return runsFailure
              ? failure("运行快照暂时不可用")
              : ok({
                  runs:
                    workspacePath === workspaceA
                      ? runs
                      : [{ runId: "foreign", status: "cancelled" }],
                });
          case "jobs.list":
            if (!trusted.has(workspacePath)) return failure("项目尚未信任");
            if (jobsFailure) return failure("自动化加载失败");
            return ok({
              jobs: [{ jobId: workspacePath, name: `Job ${workspacePath}`, enabled: true }],
            });
          case "session.list":
            return ok({ sessions: [] });
          case "events.replay":
            return ok({ events: [], highWatermarkEventId: "boundary" });
          case "session.subscription.open":
            return ok({
              session,
              hostEpoch: "host",
              subscriptionId: "subscription",
              nextSequence: 1,
              watermark: {
                historyEpoch: "history",
                projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
                throughSequence: 0,
              },
              durableTail: [],
              activeOverlay: [],
              queuedInputs: [],
              planControl: {
                version: 1,
                availability: "ready",
                state: "pending_review",
                projection: {
                  sessionId: session.sessionId,
                  sessionSequence: 0,
                  controlEpoch: "epoch",
                  operationId: "operation",
                  proposals: [],
                  pendingProposal: {
                    planId: "plan",
                    revision: 1,
                    title: "Review plan",
                    steps: [],
                    status: "pending",
                    proposedAt: "2026-09-17T00:00:00.000Z",
                  },
                },
              },
            });
          case "session.subscription.close":
            return ok({ closed: true });
          case "session.get":
            return ok({ session });
          default:
            return ok({});
        }
      },
    },
  ),
  events: {
    subscribe(params: { workspacePath: string }, callback: (event: RuntimeNotification) => void) {
      subscribedWorkspace = params.workspacePath;
      listener = callback;
      return {
        ready: Promise.resolve(ok({ subscriptionId: "events" })),
        dispose() {
          listener = undefined;
          subscribedWorkspace = undefined;
        },
      };
    },
  },
  sessionFrames: { subscribe: () => ({ dispose() {} }) },
  onUnavailable: () => () => {},
  onRecovered: () => () => {},
  platform: { getLaunchAtLogin: async () => ok(false) },
  lifecycle: { getBackgroundMode: async () => ok(false) },
} as unknown as DesktopBridge;
Object.assign(window, { pico: bridge });
let store: RuntimeStore;
const target = document.getElementById("app")!;
const root = createRoot(target);
function Harness() {
  store = useRuntimeStore();
  return (
    <output>
      {JSON.stringify({
        workspace: store.data.workspacePath,
        pending: store.data.approvals.length + store.data.prompts.length,
        jobs: store.data.jobs.map((job) => job.id),
        notices: store.data.notices,
      })}
    </output>
  );
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(message);
}
function notify(topic: string, runId: string, payload: unknown = {}, workspacePath = workspaceA) {
  check(listener, "Workspace event subscription missing");
  listener({
    eventId: `event-${++eventSequence}`,
    at: Date.now(),
    topic,
    scope: { workspacePath, runId },
    payload,
  } as RuntimeNotification);
}
async function request(runId: string) {
  await act(async () => {
    notify("approval.requested", runId, {
      approvalId: `approval-${runId}`,
      runId,
      request: {
        kind: "tool",
        title: "Approve",
        detail: "Run tool",
        risk: "low",
        toolName: "shell",
        args: "{}",
        providerCallId: runId,
      },
    });
    notify("prompt.requested", runId, {
      promptId: `prompt-${runId}`,
      runId,
      prompt: { question: "Continue?", options: ["yes"] },
    });
  });
}
function hasPending(runId: string) {
  return (
    store.data.approvals.some((item) => item.kind !== "plan" && item.runId === runId) &&
    store.data.prompts.some((item) => item.runId === runId)
  );
}
async function refresh() {
  await act(async () => {
    await store.actions.selectWorkspace(workspaceA);
  });
}
async function main() {
  await act(async () => root.render(<Harness />));
  await waitFor(() => store.connection.kind === "ready", "Bootstrap failed");
  runs = ["cancelled", "failed", "succeeded", "active", "unknown", "foreign"].map((runId) => ({
    runId,
    status: "running",
    version: 1,
    updatedAt: 10,
  }));
  await refresh();
  await waitFor(() => subscribedWorkspace === workspaceA, "No A subscription");
  await act(async () => {
    await store.actions.loadSession({ workspacePath: workspaceA, sessionId: session.sessionId });
  });
  check(
    store.data.approvals.some((item) => item.kind === "plan"),
    "Plan control must hydrate",
  );
  for (const id of ["cancelled", "failed", "succeeded", "active", "unknown", "foreign", "missing"])
    await request(id);
  check(store.data.prompts.length === 7, "Requested interactions must render");

  runsFailure = true;
  await refresh();
  check(store.data.prompts.length === 7, "Failed run listing must preserve pending interactions");
  runsFailure = false;
  runs = [];
  await refresh();
  check(store.data.prompts.length === 7, "Absent runs must not imply completion");
  runs = [
    { runId: "cancelled", status: "cancelled" },
    { runId: "failed", status: "failed" },
    { runId: "succeeded", status: "succeeded" },
    { runId: "active", status: "running" },
    { runId: "unknown", status: "unknown" },
    { runId: "foreign", status: "running" },
    { runId: "plan-hydrate:plan", status: "cancelled" },
  ].map((run) => ({ ...run, version: 2, updatedAt: 20 }));
  await act(async () => notify("run.cancelled", "cancelled"));
  await waitFor(
    () => store.data.prompts.length === 4,
    "Terminal hydration did not clear pending count",
  );
  check(
    !hasPending("cancelled") && !hasPending("failed") && !hasPending("succeeded"),
    "All terminal statuses must settle prompts and approvals",
  );
  check(
    ["active", "unknown", "missing", "foreign"].every(hasPending),
    "Other active, unknown, absent or foreign runs must survive",
  );
  check(
    store.data.approvals.some((item) => item.kind === "plan"),
    "Plan control must survive terminal run cleanup",
  );
  await request("cancelled");
  check(!hasPending("cancelled"), "Late requested event must not resurrect terminal run");
  runs = [];
  await refresh();
  await request("cancelled");
  check(!hasPending("cancelled"), "Omitted terminal history must not revive old requests");

  runs = [{ runId: "failed", status: "running", version: 1, updatedAt: 100 }];
  await refresh();
  await request("failed");
  check(!hasPending("failed"), "Older active revision cannot revive a terminal run");
  runs = [{ runId: "failed", status: "failed", version: 2, updatedAt: 20 }];
  await act(async () =>
    notify("run.started", "failed", {
      run: { runId: "failed", status: "running", version: 3, startedAt: 10, updatedAt: 20 },
    }),
  );
  await request("failed");
  check(
    hasPending("failed"),
    "Newer run.started revision must immediately allow recovered run requests",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  check(hasPending("failed"), "Older terminal snapshot cannot clear recovered run requests");
  runs = [{ runId: "failed", status: "failed", version: 4, updatedAt: 30 }];
  await refresh();
  check(!hasPending("failed"), "Recovered run can settle again");
  runs = [{ runId: "failed", status: "running", version: 5, updatedAt: 30 }];
  await refresh();
  await request("failed");
  check(hasPending("failed"), "Newer active snapshot must allow the same run to recover");

  trusted.delete(workspaceA);
  await refresh();
  check(
    !store.data.trusted && store.data.notices.jobs && store.data.jobs.length === 0,
    "Untrusted jobs error must be visible",
  );
  await act(async () => {
    await store.actions.trustWorkspace(workspaceA, true);
  });
  check(
    store.data.trusted && !store.data.notices.jobs && store.data.jobs[0]?.id === workspaceA,
    "Trust must refresh jobs and clear stale notice without reload",
  );
  jobsFailure = true;
  await act(async () => {
    await store.actions.trustWorkspace(workspaceA, true);
  });
  check(
    store.data.notices.jobs?.includes("自动化加载失败"),
    "Trust must retain a real refresh failure",
  );
  jobsFailure = false;

  let releaseTrust!: () => void;
  holdTrust = new Promise<void>((resolve) => {
    releaseTrust = resolve;
  });
  let trustRequest!: Promise<void>;
  await act(async () => {
    trustRequest = store.actions.trustWorkspace(workspaceA, true);
  });
  let releaseWorkspace!: () => void;
  holdWorkspace = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });
  let selection!: Promise<void>;
  await act(async () => {
    selection = store.actions.selectWorkspace(workspaceB);
  });
  check(store.data.workspacePath === workspaceA, "B selection must still be in flight");
  const callsBeforeTrust = statusCalls.length;
  await act(async () => {
    releaseTrust();
    await trustRequest;
  });
  check(
    statusCalls.length === callsBeforeTrust,
    "A trust completion must not supersede pending B load",
  );
  await act(async () => {
    releaseWorkspace();
    await selection;
  });
  holdTrust = undefined;
  holdWorkspace = undefined;
  await waitFor(() => subscribedWorkspace === workspaceB, "B subscription must replace A");
  check(
    String(store.data.workspacePath) === workspaceB &&
      String(store.data.jobs[0]?.id) === workspaceB,
    "Workspace B must remain selected after A trust completes",
  );
  await act(async () => {
    notify(
      "prompt.requested",
      "cancelled",
      { promptId: "b-prompt", runId: "cancelled", prompt: { question: "B question", options: [] } },
      workspaceB,
    );
  });
  check(
    store.data.prompts.some((item) => item.id === "b-prompt"),
    "Terminal run IDs must be scoped to workspace",
  );
  await act(async () => root.unmount());
}
void main().then(
  () => report("PASS: runtime pending reconciliation and trust recovery"),
  (error: unknown) => report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`),
);
async function report(result: string) {
  document.getElementById("result")!.textContent = result;
  await fetch("/result", { method: "POST", body: result });
}
