import type { ExecutionFileCommitFact, ToolCall } from "@pico/core";
import type { ToolExecutionContext } from "./tool-registry-contract.js";
export type NativeFileCommit = Omit<ExecutionFileCommitFact, "source">;
export type NativeFileLearningContext = ToolExecutionContext & {
  readonly reportFileCommit?: (fact: NativeFileCommit) => Promise<void>;
};
export interface NativeLearningObserver {
  beforeDispatch(call: ToolCall, context: ToolExecutionContext): Promise<void>;
  fileCommitted(call: ToolCall, fact: NativeFileCommit): Promise<void>;
}
/** Learning failures never turn a completed native file write into a tool failure. */
export async function reportNativeFileCommit(
  context: ToolExecutionContext | undefined,
  fact: NativeFileCommit,
): Promise<void> {
  try {
    await (context as NativeFileLearningContext | undefined)?.reportFileCommit?.(fact);
  } catch {
    /* source operation remains authoritative */
  }
}
