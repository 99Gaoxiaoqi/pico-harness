import { isForegroundProcessFacts, type ForegroundProcessFacts } from "@pico/core";
import type { ToolExecutionContext } from "./tool-registry-contract.js";

/** Only Registry's physical native Bash dispatch receives this private collector. */
export type NativeProcessExecutionContext = ToolExecutionContext & {
  readonly reportProcessResult?: (facts: ForegroundProcessFacts) => void;
};

export function validateNativeProcessFacts(value: ForegroundProcessFacts): boolean {
  return isForegroundProcessFacts(value);
}
