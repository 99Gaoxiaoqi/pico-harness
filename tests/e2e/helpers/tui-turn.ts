import { performance } from "node:perf_hooks";
import {
  parseApprovalRequestedPayload,
  type RuntimeNotification,
  type RuntimeNotificationMap,
} from "@pico/protocol";
import { redactProviderErrorText } from "../../../src/provider/error-redaction.js";
import type {
  ClientSessionRuntime,
  DaemonSessionClient,
} from "../../../src/tui/client-session-runtime.js";
import type { TuiReporter } from "../../../src/tui/tui-reporter.js";

/** Observe a new wire Run, never an assistant entry left by an earlier turn. */
export async function sendTuiTurn(options: {
  runtime: Pick<ClientSessionRuntime, "sendText" | "running" | "activeSessionId" | "resolvePlain">;
  reporter: Pick<TuiReporter, "getProjection">;
  client: Pick<DaemonSessionClient, "subscribe">;
  workspacePath: string;
  text: string;
  redact?: (text: string) => string;
  approve?: (approval: NonNullable<ReturnType<typeof parseApprovalRequestedPayload>>) => boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  const { runtime, reporter } = options;
  const deadline = performance.now() + (options.timeoutMs ?? 180_000);
  const baseline = new Set(reporter.getProjection().entries.map((entry) => entry.id));
  const events: RuntimeNotification[] = [];
  const handledApprovals = new Set<string>();
  const subscription = await options.client.subscribe(
    { workspacePath: options.workspacePath },
    (event) => {
      if (
        [
          "run.started",
          "run.updated",
          "run.finished",
          "runtime.error",
          "approval.requested",
          "prompt.requested",
        ].includes(event.topic)
      )
        events.push(event);
    },
  );
  // Historical replay belongs to earlier turns and is deliberately not consumed.
  const redact = options.redact ?? ((text: string) => redactProviderErrorText(text, []));
  let runId: string | undefined;
  let status: string | undefined;
  let finishedAt: number | undefined;
  let pendingSettingsError: string | undefined;
  const fail = (reason: string): never => {
    const tools = Object.values(reporter.getProjection().toolCalls)
      .filter((tool) => !baseline.has(tool.entryId))
      .map(({ name, status }) => ({ name, status }));
    throw new Error(
      redact(
        `TUI turn: ${reason}; run=${runId ?? "unobserved"}; status=${status ?? "unobserved"}; running=${runtime.running}; phase=${reporter.getProjection().phase.mode}; tools=${JSON.stringify(tools)}; pendingSettingsError=${pendingSettingsError ?? "none"}`,
      ).slice(0, 2_000),
    );
  };
  try {
    // session.send is non-idempotent: a rejection must be diagnosed, not blindly resent.
    if (!(await runtime.sendText(options.text))) {
      const error = reporter
        .getProjection()
        .entries.findLast(({ entry }) => entry.kind === "error");
      fail(error?.entry.kind === "error" ? error.entry.message : "session.send rejected");
    }
    for (;;) {
      for (const event of events.splice(0)) {
        if (event.scope.sessionId && event.scope.sessionId !== runtime.activeSessionId) continue;
        if (
          event.topic === "run.started" ||
          event.topic === "run.updated" ||
          event.topic === "run.finished"
        ) {
          const run = (event.payload as RuntimeNotificationMap["run.started"]).run;
          if (runId && run.runId !== runId) continue;
          runId = run.runId;
          status = run.status;
          if (status === "succeeded") finishedAt ??= performance.now();
          if (status === "failed" || status === "cancelled") fail(run.error ?? `Run ${status}`);
        } else if (event.topic === "runtime.error") {
          fail((event.payload as RuntimeNotificationMap["runtime.error"]).message);
        } else if (event.topic === "approval.requested") {
          const approval = parseApprovalRequestedPayload(event.payload);
          if (!approval || !options.approve?.(approval))
            return fail("unexpected approval.requested");
          if (!handledApprovals.has(approval.approvalId)) {
            handledApprovals.add(approval.approvalId);
            if (!(await runtime.resolvePlain("approve", approval.approvalId)))
              fail("allow_once was not accepted");
          }
        } else if (event.topic === "prompt.requested") {
          fail("unexpected prompt.requested");
        }
      }
      const current = reporter.getProjection().entries.filter(({ id }) => !baseline.has(id));
      const error = current.find(({ entry }) => {
        if (entry.kind !== "error") return false;
        // ClientSessionRuntime retries a startup override after the active Run.
        // The matrix independently verifies that settings actually converge.
        if (
          entry.action === "session.settings.update" &&
          entry.retryable &&
          /^应用启动覆盖失败：Session \S+ 仍有活动 Run，不能修改会话设置（将在下次触发点重试）$/u.test(
            entry.message,
          )
        ) {
          pendingSettingsError = entry.message;
          return false;
        }
        return true;
      });
      if (error?.entry.kind === "error") fail(error.entry.message);
      const terminal = current.find(
        ({ entry }) =>
          entry.kind === "run-boundary" && ["failed", "cancelled"].includes(entry.status),
      );
      if (terminal?.entry.kind === "run-boundary")
        fail(terminal.entry.error ?? `Run ${terminal.entry.status}`);
      const answered = current.some(({ entry }) => entry.kind === "assistant");
      if (status === "succeeded" && !runtime.running && answered) return true;
      if (finishedAt !== undefined && performance.now() - finishedAt >= 5_000)
        fail("successful Run did not drain into a new assistant projection within 5 seconds");
      if (performance.now() >= deadline)
        fail("deadline exceeded before terminal Run and new assistant projection");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    subscription.dispose();
  }
}
