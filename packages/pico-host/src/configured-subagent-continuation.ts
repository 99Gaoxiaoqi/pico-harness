import {
  resolveConfiguredSubagentContinuation as resolveConfiguredSubagentContinuationFromRuntime,
  type ConfiguredSubagentContinuation,
  type ConfiguredSubagentParentRecordReader,
} from "@pico/runtime/configured-subagent-continuation";
import type { RuntimeSubagentPreset } from "@pico/protocol";
import type { ConfiguredSubagentCatalogPort } from "@pico/core/subagent-capabilities";
import { findParentRecord } from "@pico/runtime/configured-subagent-output-store";
import { currentRuntimeRun } from "@pico/runtime/runtime-run";
import type { ConfiguredSubagentExecutionInput } from "@pico/runtime/configured-subagent-tools";

/** Resolve only durable children admitted by this parent, never caller-supplied paths/configuration. */
export async function resolveConfiguredSubagentContinuation(
  childSessionId: string,
  workDir: string,
  catalog?: ConfiguredSubagentCatalogPort,
): Promise<Omit<ConfiguredSubagentExecutionInput, "task" | "signal">> {
  const parent = currentRuntimeRun();
  if (!parent) throw new Error("Child continuation requires an active parent session");
  const parentRecordReader: ConfiguredSubagentParentRecordReader = {
    readParentRecord: ({ parentSessionId, workDir: parentWorkDir, childSessionId: childId }) =>
      findParentRecord(
        { parentSessionId, workDir: parentWorkDir, eventStore: parent.store },
        {
          locator: "child_session_latest",
          childSessionId: childId,
          view: "result",
          maxBytes: 4096,
          maxEvents: 10,
        },
      ),
  };
  const resolved: ConfiguredSubagentContinuation =
    await resolveConfiguredSubagentContinuationFromRuntime({
      parent: { sessionId: parent.sessionId, workDir: parent.workDir, store: parent.store },
      childSessionId,
      workDir,
      ...(catalog ? { catalog } : {}),
      parentRecordReader,
    });
  const { preset: _preset, ...continuation } = resolved;
  return {
    ...continuation,
    ...(resolved.preset
      ? { preset: resolved.preset as RuntimeSubagentPreset & { readonly modelRouteId: string } }
      : {}),
  };
}
