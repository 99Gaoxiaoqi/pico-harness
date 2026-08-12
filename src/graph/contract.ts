import { createHash } from "node:crypto";

export type GraphWorkStatus = "requested" | "dispatched" | "recorded" | "failed";
export type GraphStatus = "active" | "closed";

export interface GraphWork {
  readonly workId: string;
  readonly instruction: string;
  readonly inputIds: readonly string[];
  readonly mode: "explore" | "worker";
  readonly status: GraphWorkStatus;
  readonly delegationId?: string;
  readonly recordId?: string;
}

export interface GraphRecord {
  readonly recordId: string;
  readonly workId: string;
  readonly outputSummary: string;
  readonly evidenceRefs?: readonly string[];
}

export interface GraphProjection {
  readonly graphId: string;
  readonly sessionSequence: number;
  readonly works: readonly GraphWork[];
  readonly records: readonly GraphRecord[];
  readonly status: GraphStatus;
}

export class GraphConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphConflictError";
  }
}

export function workIdFor(graphId: string, instruction: string, inputIds: readonly string[]): string {
  const hash = createHash("sha256")
    .update(`${graphId}:${instruction}:${[...inputIds].sort().join(",")}`)
    .digest("hex");
  return `work_${hash.slice(0, 32)}`;
}

export function recordIdFor(graphId: string, workId: string): string {
  const hash = createHash("sha256").update(`${graphId}:${workId}`).digest("hex");
  return `record_${hash.slice(0, 32)}`;
}

export interface GraphWorkInput {
  readonly instruction: string;
  readonly inputIds?: readonly string[];
  readonly mode?: string;
}

export function normalizeGraphWorkInput(input: GraphWorkInput): {
  instruction: string;
  inputIds: readonly string[];
  mode: "explore" | "worker";
} {
  const instruction = input.instruction?.trim();
  if (!instruction)
    throw new GraphConflictError("Graph work instruction must not be empty");
  const inputIds = input.inputIds ?? [];
  for (const id of inputIds) {
    if (typeof id !== "string" || !id.trim())
      throw new GraphConflictError("Graph work input id must be a non-empty string");
  }
  const mode = input.mode === "worker" ? "worker" : "explore";
  return { instruction, inputIds, mode };
}
