import { FilesPanelController } from "./FilesPanelController.js";
import { GraphPanelController } from "./GraphPanelController.js";
import { InspectorPanelController } from "./InspectorPanelController.js";
import { ReviewPanelController } from "./ReviewPanelController.js";
import { TasksPanelController } from "./TasksPanelController.js";
import { TerminalPanelController } from "./TerminalPanelController.js";
import type { WorkbarPanelHostProps } from "./workbar-panel-contract.js";

export {
  appendArtifactStreamChunk,
  artifactContentView,
  queryAllWorkbarArtifacts,
} from "./FilesPanelController.js";
export type { ArtifactChunkEnvelope, ArtifactStreamAccumulator } from "./FilesPanelController.js";
export {
  graphClaimDisplayState,
  parseGraphDetail,
  parseGraphList,
  queryAllGraphTimeline,
} from "./GraphPanelController.js";
export { tracePageView } from "./InspectorPanelController.js";
export {
  loadConsistentReviewSnapshot,
  loadReviewDiff,
  WorkbarReviewConflictError,
} from "./ReviewPanelController.js";
export { queryAllWorkbarTasks } from "./TasksPanelController.js";
export {
  appendTerminalOutput,
  listWorkbarTerminalBindings,
  stopWorkbarTerminalInstance,
} from "./TerminalPanelController.js";
export type {
  WorkbarTerminalBinding,
  WorkbarTerminalInstanceScope,
} from "./TerminalPanelController.js";
export { shouldRefreshWorkbarResource } from "./useResourceFrame.js";
export type { WorkbarResourceGate } from "./useResourceFrame.js";
export type { WorkbarPanelHostKind, WorkbarPanelHostProps } from "./workbar-panel-contract.js";
export { invokeWorkbarRuntime, WorkbarPanelRuntimeError } from "./workbar-runtime.js";

export function WorkbarPanelHost(props: WorkbarPanelHostProps) {
  const key = `${props.workspacePath}:${props.sessionId}:${props.instanceId}`;
  switch (props.kind) {
    case "inspector":
      return <InspectorPanelController key={key} {...props} />;
    case "review":
      return <ReviewPanelController key={key} {...props} />;
    case "tasks":
      return <TasksPanelController key={key} {...props} />;
    case "files":
      return <FilesPanelController key={key} {...props} />;
    case "terminal":
      return <TerminalPanelController key={key} {...props} />;
    case "graph":
      return <GraphPanelController key={key} {...props} />;
  }
}
