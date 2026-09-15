import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeNotification,
  type RuntimeNotification,
  type RuntimeNotificationMap,
} from "@pico/protocol";
import { buildApprovalRequestedPayload } from "@pico/pico-host";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { ingestDesktopRuntimeNotification } from "@pico/pico-host/desktop-transcript-persistence";
import { projectTranscriptEvents } from "@pico/pico-host/transcript-event-store";
import {
  parseConversation,
  pendingToolApprovalFromTranscript,
} from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";

test(
  "外部交互响应在活跃运行释放锁之前持久化，后续快照保持终态且重复响应不重复入账",
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-interaction-transcript-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const env = { PICO_HOME: picoHome };
    const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
    const lease = await globalSessionManager.getOrCreatePinned("interaction-lifecycle", canonical, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    let advances = 0;
    const errors: unknown[] = [];
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      env,
      onTranscriptAdvanced: () => {
        advances += 1;
      },
    });
    const unsubscribe = desktop.subscribe((event) => {
      if (event.topic === "runtime.error") errors.push(event.payload);
    });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const activeRun = lease.session.serialize(async () => {
      started.resolve();
      await finish.promise;
    });
    const scope = { workspacePath: canonical, sessionId: lease.session.id, runId: "active-run" };
    const publish = (
      topic: keyof RuntimeNotificationMap,
      payload: RuntimeNotification["payload"],
      eventId: string,
    ) => {
      runtime.publishDesktopNotification(
        createRuntimeNotification({ topic, payload, eventId, scope, resourceVersion: 1, at: 1 }),
      );
    };
    const waitForAdvances = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (advances < count && errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(errors, []);
      assert.ok(advances >= count, "interaction projection must not wait for the active Run lock");
    };
    try {
      await started.promise;
      publish(
        "approval.requested",
        buildApprovalRequestedPayload(
          {
            kind: "tool",
            taskId: "approval-1",
            toolName: "write_file",
            providerCallId: "call-1",
            args: "{}",
            message: "write fixture",
          },
          scope.runId,
        ),
        "approval-request",
      );
      publish(
        "prompt.requested",
        { promptId: "prompt-1", prompt: { question: "choose", options: [] } },
        "prompt-request",
      );
      await waitForAdvances(2);
      publish(
        "approval.resolved",
        { approvalId: "approval-1", decision: "deny" },
        "approval-settled",
      );
      publish("prompt.resolved", { promptId: "prompt-1" }, "prompt-settled");
      await waitForAdvances(4);
      assert.equal(lease.session.hasPendingTasks, true);
      const page = await lease.session.runtimeEventStore!.readTranscriptProjectionPage({
        sessionId: lease.session.id,
        maxBytes: 512 * 1024,
      });
      const conversation = parseConversation(
        { items: page.items.map(({ payload }) => payload) },
        canonical,
        lease.session.id,
      );
      assert.equal(pendingToolApprovalFromTranscript(conversation.items), undefined);
      assert.ok(
        conversation.items.some((item) => item.kind === "prompt" && item.state === "answered"),
      );
      assert.ok(
        !conversation.items.some(
          (item) =>
            (item.kind === "approval" || item.kind === "prompt") && item.state === "pending",
        ),
      );
      assert.equal(
        await ingestDesktopRuntimeNotification(
          lease.session,
          createRuntimeNotification({
            topic: "prompt.resolved",
            payload: { promptId: "prompt-1" },
            eventId: "prompt-settled",
            scope,
            resourceVersion: 1,
            at: 1,
          }),
          projectTranscriptEvents,
        ),
        false,
      );
      finish.resolve();
      await activeRun;
      await desktop.close();
      const hydration = await lease.session.readHydrationSnapshot();
      assert.equal(
        hydration.transcriptEvents.filter((event) => event.eventId === "runtime:prompt-settled")
          .length,
        1,
      );
    } finally {
      finish.resolve();
      await activeRun;
      unsubscribe();
      await desktop.close();
      lease.release();
      await globalSessionManager.delete(lease.session.id, canonical, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
