import assert from "node:assert/strict";
import test from "node:test";
import { DesktopReporter } from "@pico/pico-host";
import { publishDesktopReporterEvent } from "@pico/pico-host/production-host";
import type { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { isRuntimeNotification, type RuntimeNotification } from "@pico/protocol";

test("desktop reporter publishes safe retry progress and updates one timeline row", () => {
  const published: RuntimeNotification[] = [];
  const service = {
    publishDesktopNotification: (notification: RuntimeNotification) => published.push(notification),
  } as unknown as WorkspaceRuntimeService;
  let resourceVersion = 0;
  const reporter = new DesktopReporter({
    runId: "run-retry",
    sessionId: "session-retry",
    publish: (event) =>
      publishDesktopReporterEvent(service, "/workspace", event, () => ++resourceVersion),
  });
  const info = {
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 10,
    delayMs: 1200,
    failureStatus: "error" as const,
    transportCode: "ECONNRESET",
    diagnosticId: "diagnostic-1",
  };

  reporter.onProviderRetry({ phase: "scheduled", ...info });
  reporter.onProviderRetry({ phase: "started", ...info });

  assert.equal(published.length, 4);
  assert.ok(published.every((event) => isRuntimeNotification(event)));
  assert.deepEqual(
    published.filter((event) => event.topic === "run.providerRetry").map((event) => event.payload),
    [{ phase: "scheduled", ...info }, { phase: "started", ...info }],
  );
  const timeline = published
    .filter((event) => event.topic === "run.timeline")
    .map(
      (event) =>
        (event.payload as { readonly item: Readonly<Record<string, unknown>> }).item,
    );
  assert.equal(timeline[0]?.id, "status:provider-retry:run-retry:1");
  assert.equal(timeline[1]?.id, timeline[0]?.id);
  assert.deepEqual(timeline.map((item) => item.state), ["active", "done"]);
});
