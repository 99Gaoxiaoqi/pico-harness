import type { RuntimeSubagentPreset } from "@pico/protocol";
import {
  requireSubagentCapability,
  type ConfiguredSubagentCatalogPort,
} from "../agents/subagent-profiles.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import { projectRuntimeSessionState } from "../engine/session-runtime-projection.js";
import { childRecord, findParentRecord } from "./configured-subagent-output-store.js";
import { currentRuntimeRun } from "./runtime-run.js";
import type { ConfiguredSubagentExecutionInput } from "../tools/configured-subagent-tools.js";

/** Resolve only durable children admitted by this parent, never caller-supplied paths/configuration. */
export async function resolveConfiguredSubagentContinuation(
  childSessionId: string,
  workDir: string,
  catalog?: ConfiguredSubagentCatalogPort,
): Promise<Omit<ConfiguredSubagentExecutionInput, "task" | "signal">> {
  const parent = currentRuntimeRun();
  if (!parent || canonicalizeWorkspacePath(parent.workDir) !== canonicalizeWorkspacePath(workDir))
    throw new Error("Child continuation requires an active parent session");
  const store = parent.store;
  const record = await findParentRecord(
    { parentSessionId: parent.sessionId, workDir, eventStore: store },
    {
      locator: "child_session_latest",
      childSessionId,
      view: "result",
      maxBytes: 4096,
      maxEvents: 10,
    },
  );
  if (!record) throw new Error("Child session is not authorized for this parent or does not exist");
  if (
    canonicalizeWorkspacePath(record.workDir) !== canonicalizeWorkspacePath(workDir) ||
    record.patch
  )
    throw new Error(
      "Isolated worktree child continuation is not supported; keep its patch and start a new task",
    );
  const manifest = await store.readSessionManifest(childSessionId);
  if (
    !manifest ||
    canonicalizeWorkspacePath(manifest.workDir) !== canonicalizeWorkspacePath(workDir)
  )
    throw new Error("Child session workspace is unavailable or changed");
  const start = (
    await store.readSessionEventsByKind(childSessionId, "run.started", { order: "desc", limit: 1 })
  )[0]?.event;
  if (!start || start.runId !== record.runId)
    throw new Error("Child session has changed; inspect its latest run before continuing");
  const terminal = (
    await store.readSessionEventsForRun(childSessionId, start.runId, {
      kind: "run.terminal",
      order: "desc",
      limit: 1,
    })
  )[0]?.event;
  if (
    terminal?.kind !== "run.terminal" ||
    !["completed", "failed", "cancelled"].includes(terminal.data.status)
  )
    throw new Error("Child session is still running or has no durable terminal result");
  const admissions = await store.readSessionEventsForRun(childSessionId, start.runId, {
    kind: "message.committed",
    limit: 100,
  });
  const admission = admissions.find(({ event }) => {
    const child = childRecord(event);
    return (
      child?.childSessionId === childSessionId &&
      child.parentSessionId === parent.sessionId &&
      child.runId === start.runId &&
      child.parentRunId === record.parentRunId &&
      child.parentToolCallId === record.parentToolCallId
    );
  })?.event;
  if (admission?.kind !== "message.committed")
    throw new Error("Child session has no matching runtime admission");
  const snapshot = admission.data.message.providerData?.["picoConfiguredChild"] as Record<
    string,
    unknown
  >;
  const definition = requireSubagentCapability(String(snapshot["profile"] ?? ""));
  if (definition.workspace !== "shared")
    throw new Error("Isolated worktree child continuation is not supported");
  // Settings are complete snapshots in state commits; bounded reverse pages also support older children.
  let upper: number | undefined;
  let settings;
  for (;;) {
    const entries = await store.readSessionEventsByKind(childSessionId, "session.state.committed", {
      order: "desc",
      limit: 100,
      ...(upper === undefined ? {} : { upToSequence: upper }),
    });
    settings = projectRuntimeSessionState(entries.map(({ event }) => event).reverse()).settings;
    if (settings || entries.length < 100) break;
    upper = entries.at(-1)!.sequence - 1;
  }
  if (!settings?.modelRouteId)
    throw new Error("Child model snapshot is unavailable; start a new child task");
  if (
    typeof snapshot["modelRouteId"] === "string" &&
    snapshot["modelRouteId"] !== settings.modelRouteId
  )
    throw new Error("Child model changed; start a new child task");
  let preset: (RuntimeSubagentPreset & { modelRouteId: string }) | undefined;
  const saved = snapshot["preset"] as
    | (RuntimeSubagentPreset & { modelRouteId: string })
    | undefined;
  if (saved) {
    if (!catalog || typeof saved.id !== "string") throw new Error("Child preset is unavailable");
    const current = await catalog.resolve(saved.id);
    if (
      current.profile !== definition.profile ||
      current.modelRouteId !== settings.modelRouteId ||
      current.thinkingLevel !== saved.thinkingLevel
    )
      throw new Error("Child preset configuration changed; start a new child task");
    preset = saved;
  }
  return {
    definition,
    ...(preset ? { preset } : {}),
    continuation: {
      childSessionId,
      sourceRunId: start.runId,
      modelRouteId: settings.modelRouteId,
      ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
      ...(record.agentName ? { agentName: record.agentName } : {}),
    },
  };
}
