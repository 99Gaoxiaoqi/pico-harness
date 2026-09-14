import type { RuntimeToolResultLogger } from "./tool-result-builder.js";

const NOOP_RUNTIME_RUN_DIAGNOSTICS: RuntimeToolResultLogger = {
  warn: () => undefined,
};

let runtimeRunDiagnostics: RuntimeToolResultLogger = NOOP_RUNTIME_RUN_DIAGNOSTICS;

/** Host compatibility hook for RuntimeRun's structured warnings. */
export function configureRuntimeRunDiagnostics(logger?: RuntimeToolResultLogger): void {
  runtimeRunDiagnostics = logger ?? NOOP_RUNTIME_RUN_DIAGNOSTICS;
}

export function getRuntimeRunDiagnostics(): RuntimeToolResultLogger {
  return runtimeRunDiagnostics;
}
