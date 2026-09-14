/** Shared semantic body for durable Transcript entries, without UI identity. */
export type TranscriptToolCallStatus =
  | "queued"
  | "running"
  | "approval"
  | "success"
  | "error"
  | "denied";

export type TranscriptSubagentActivityStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface TranscriptSubagentActivity {
  activityId: string;
  task: string;
  status: TranscriptSubagentActivityStatus;
  mode: "explore" | "worker";
  completionPolicy: "required" | "optional" | "detached";
  childSessionId?: string;
  childWorkspacePath?: string;
  toolCallId?: string;
  durationMs?: number;
  agentName?: string;
  currentAction?: string;
  summary?: string;
  requestedModelRoute?: string;
  resolvedModelRoute?: string;
  thinkingEffort?: string;
  modelSelectionSource?: "ephemeral" | "profile" | "parent";
}

export type TranscriptEntryData =
  | {
      kind: "logo";
      model?: string;
      cwd?: string;
      sessionMode?: string;
      permissionMode?: string;
      mcpSummary?: string;
      taskSummary?: string;
    }
  | { kind: "user"; content: string }
  | { kind: "skill"; name: string; args: string; trigger: "user-slash" | "model-tool" }
  | { kind: "system"; content: string }
  | { kind: "error"; message: string; retryable?: boolean; action?: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool"; name: string; args: string; status: TranscriptToolCallStatus; summary?: string }
  | {
      kind: "plan";
      title: string;
      detail?: string;
      state?: "waiting" | "active" | "done" | "failed";
    }
  | {
      kind: "approval" | "prompt" | "changes";
      title: string;
      detail?: string;
      state?: string;
      data?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "run-boundary";
      runId: string;
      status:
        | "queued"
        | "running"
        | "pause_requested"
        | "paused"
        | "cancelling"
        | "cancelled"
        | "failed"
        | "succeeded";
      startedAt: number;
      finishedAt?: number;
      error?: string;
    }
  | ({ kind: "subagent-activity" } & Omit<TranscriptSubagentActivity, "activityId">)
  | { kind: "thinking"; content?: string };
