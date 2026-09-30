import type {
  DesktopCommandSuggestion,
  DesktopCommandDestination,
} from "../shared/command-policy.js";
import type { SlashArgumentCandidate } from "@pico/cli/command-contracts";
import type { ClientInputOutcome } from "@pico/cli/client-commands";
import type { RuntimeParams, RuntimeUserDefaults } from "@pico/protocol";
import type { DesktopResult } from "./contract.js";

export const DESKTOP_COMMAND_CHANNEL = "pico:commands:invoke";

export interface DesktopCommandContext {
  readonly workspacePath: string;
  readonly sessionId?: string | undefined;
  readonly initialSettings?: RuntimeUserDefaults | undefined;
  readonly running?: boolean | undefined;
}

export type DesktopCommandRequest = DesktopCommandContext &
  (
    | { readonly operation: "catalog" }
    | { readonly operation: "complete"; readonly text: string }
    | { readonly operation: "execute"; readonly text: string; readonly requestId: string }
  );

export interface DesktopCommandExecution {
  readonly outcome: ClientInputOutcome;
  /** null opens the new-task page; undefined leaves navigation unchanged. */
  readonly switchSession?: string | null | undefined;
  readonly initialSettings?: RuntimeUserDefaults | undefined;
  readonly action?: DesktopCommandAction | undefined;
  readonly redirect?: { destination: DesktopCommandDestination; label: string } | undefined;
}

export type DesktopCommandAction =
  | {
      kind: "open";
      target:
        | "goal"
        | "model"
        | "skill"
        | "agent"
        | "sessions"
        | "mode"
        | "permissions"
        | "interrupt"
        | "thinking";
    }
  | {
      kind: "settings";
      patch: Omit<RuntimeParams<"session.settings.update">, "workspacePath" | "sessionId">;
    }
  | { kind: "goal"; input: Omit<RuntimeParams<"goal.control">, "workspacePath" | "sessionId"> }
  | { kind: "compact" }
  | { kind: "rename"; title: string }
  | { kind: "fork"; sessionId: string };

export interface DesktopCommandsApi {
  catalog(
    context: DesktopCommandContext,
  ): Promise<DesktopResult<readonly DesktopCommandSuggestion[]>>;
  complete(
    context: DesktopCommandContext,
    text: string,
  ): Promise<DesktopResult<readonly SlashArgumentCandidate[]>>;
  execute(
    context: DesktopCommandContext,
    text: string,
    requestId: string,
  ): Promise<DesktopResult<DesktopCommandExecution>>;
}
