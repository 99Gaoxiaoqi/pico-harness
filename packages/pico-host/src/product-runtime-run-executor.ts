import {
  DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS,
  RuntimeRunExecutor as PicoHostRuntimeRunExecutor,
  emitRuntimeLifecycleEvent as emitPicoHostRuntimeLifecycleEvent,
  type RuntimeRunExecutorInput as PicoHostRuntimeRunExecutorInput,
} from "@pico/pico-host/runtime-run-executor";
import type { AgentEngine } from "@pico/pico-host/agent-engine";
import type { Session } from "@pico/pico-host/session";
import type { SessionRuntime } from "@pico/pico-host/session-runtime";
import { loadImage } from "@pico/pico-host/input/prepare-prompt";
import { logger } from "@pico/pico-host/logger";
import type { RuntimeLifecycleEvent } from "@pico/runtime/runtime-contract";

export { DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS };
export type {
  PrestartedRuntimeRun,
  PrestartedRuntimeUserInput,
  RuntimePromptHookOutput,
  RuntimePromptHookPort,
  RuntimeRunExecutorDiagnostics,
  RuntimeRunExecutorEventStore,
  RuntimeRunExecutorSession,
} from "@pico/pico-host/runtime-run-executor";

/** Concrete Engine compatibility input retained while callers move to Pico Host. */
export type RuntimeRunExecutorInput = Omit<
  PicoHostRuntimeRunExecutorInput,
  "session" | "promptHooks" | "executeModel" | "loadImage" | "diagnostics"
> & {
  readonly session: Session;
  readonly runtimeState: SessionRuntime;
  readonly engine: AgentEngine;
};

/**
 * Legacy source adapter. The package implementation only sees narrow Host ports;
 * concrete Engine, SessionRuntime, image loading and logging stay wired here.
 */
export class RuntimeRunExecutor {
  constructor(private readonly input: RuntimeRunExecutorInput) {}

  execute() {
    const { session, runtimeState, engine, ...input } = this.input;
    return new PicoHostRuntimeRunExecutor({
      ...input,
      session,
      promptHooks: {
        submit: (prompt, signal) =>
          runtimeState.dispatchHook(
            "UserPromptSubmit",
            { prompt },
            signal ? { signal } : undefined,
          ),
        expand: (prompt, expandedPrompt, signal) =>
          runtimeState.dispatchHook(
            "UserPromptExpansion",
            { prompt, expandedPrompt },
            signal ? { signal } : undefined,
          ),
      },
      executeModel: (signal) => engine.run(session, undefined, undefined, signal),
      loadImage,
      diagnostics: {
        info: (context, message) => logger.info(context, message),
        warn: (context, message) => logger.warn(context, message),
      },
    }).execute();
  }
}

export function emitRuntimeLifecycleEvent(
  sink: RuntimeRunExecutorInput["onEvent"],
  event: RuntimeLifecycleEvent,
): void {
  emitPicoHostRuntimeLifecycleEvent(sink, event, {
    info: (context, message) => logger.info(context, message),
    warn: (context, message) => logger.warn(context, message),
  });
}
