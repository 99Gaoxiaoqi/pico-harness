/** @deprecated Reporter 契约、空实现与终端展示已分别迁至 Core、Runtime、CLI。 */
export type {
  AssistantResponseSuppressionReason,
  Reporter,
  SubagentActivityEvent,
  SubagentActivityStatus,
  SubagentTraceEvent,
} from "@pico/core";
export { SilentReporter } from "@pico/runtime/silent-reporter";
export { TerminalReporter, colorizeDiff } from "@pico/cli/terminal-reporter";
