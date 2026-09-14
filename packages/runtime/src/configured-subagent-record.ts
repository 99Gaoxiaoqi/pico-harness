import { isAbsolute } from "node:path";
import type { RuntimeEvent } from "@pico/core";

export interface ChildRecord {
  readonly version: 1;
  readonly profile?: string;
  readonly parentWorkspacePath: string;
  readonly agentName?: string;
  readonly parentSessionId: string;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly childSessionId: string;
  readonly workDir: string;
  readonly status: "started" | "completed" | "failed" | "cancelled";
  readonly runId?: string;
  readonly turnId?: string;
  readonly summary?: string;
  readonly artifactIds?: readonly string[];
  readonly patch?: { readonly path: string; readonly worktree: string; readonly branch: string };
}

/** Parse the hidden durable admission fact which authorizes a configured child. */
export function childRecord(event: RuntimeEvent): ChildRecord | undefined {
  if (
    event.kind !== "message.committed" ||
    event.partial ||
    event.data.message.role !== "assistant" ||
    event.data.message.providerData?.["picoHiddenFromTranscript"] !== true
  )
    return undefined;
  const value = event.data.message.providerData["picoConfiguredChild"];
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !["started", "completed", "failed", "cancelled"].includes(String(value["status"]))
  )
    return undefined;
  for (const key of ["parentSessionId", "parentRunId", "parentToolCallId", "childSessionId"])
    if (!validIdentity(value[key])) return undefined;
  for (const key of ["runId", "turnId"])
    if (value[key] !== undefined && !validIdentity(value[key])) return undefined;
  if (typeof value["parentWorkspacePath"] !== "string" || !isAbsolute(value["parentWorkspacePath"]))
    return undefined;
  if (typeof value["workDir"] !== "string" || !isAbsolute(value["workDir"])) return undefined;
  const patch = value["patch"];
  return {
    version: 1,
    ...(typeof value["profile"] === "string" ? { profile: value["profile"] } : {}),
    parentWorkspacePath: value["parentWorkspacePath"],
    ...(typeof value["agentName"] === "string" ? { agentName: value["agentName"] } : {}),
    parentSessionId: value["parentSessionId"] as string,
    parentRunId: value["parentRunId"] as string,
    parentToolCallId: value["parentToolCallId"] as string,
    childSessionId: value["childSessionId"] as string,
    workDir: value["workDir"],
    status: value["status"] as ChildRecord["status"],
    ...(typeof value["runId"] === "string" ? { runId: value["runId"] } : {}),
    ...(typeof value["turnId"] === "string" ? { turnId: value["turnId"] } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(Array.isArray(value["artifactIds"])
      ? {
          artifactIds: value["artifactIds"].filter(
            (item): item is string => typeof item === "string" && item.length <= 512,
          ),
        }
      : {}),
    ...(isRecord(patch) &&
    typeof patch["path"] === "string" &&
    typeof patch["worktree"] === "string" &&
    typeof patch["branch"] === "string"
      ? { patch: { path: patch["path"], worktree: patch["worktree"], branch: patch["branch"] } }
      : {}),
  };
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\s/\\\p{Cc}]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
