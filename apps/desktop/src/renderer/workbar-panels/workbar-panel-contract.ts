export type WorkbarPanelHostKind =
  | "inspector"
  | "review"
  | "tasks"
  | "files"
  | "terminal"
  | "graph";

export interface WorkbarPanelHostProps {
  readonly kind: WorkbarPanelHostKind;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly terminalTitle?: string;
  readonly inspectorTab?: "timeline" | "overview";
  readonly onInspectorTabChange?: (tab: "timeline" | "overview") => void;
}

export interface WorkbarScope {
  readonly workspacePath: string;
  readonly sessionId: string;
}
