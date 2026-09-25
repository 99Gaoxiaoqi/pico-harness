import type { PositionQuery, SymbolQuery } from "./types.js";

export type CodeIntelligenceWorkerCall =
  | { readonly operation: "snapshot"; readonly query?: string; readonly maxFiles?: number }
  | { readonly operation: "definitions" | "references"; readonly query: PositionQuery }
  | { readonly operation: "symbols"; readonly query: SymbolQuery }
  | { readonly operation: "diagnostics"; readonly filePath: string }
  | {
      readonly operation: "callHierarchy";
      readonly query: PositionQuery;
      readonly direction: "incoming" | "outgoing";
    }
  | { readonly operation: "readDocument"; readonly filePath: string }
  | { readonly operation: "rootEntries" };

export interface CodeIntelligenceWorkerRequest {
  readonly id: number;
  readonly generation: number;
  readonly call: CodeIntelligenceWorkerCall;
}

export interface CodeIntelligenceWorkerResponse {
  readonly id: number;
  readonly generation: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface WorkerDocument {
  readonly filePath: string;
  readonly text: string;
}
