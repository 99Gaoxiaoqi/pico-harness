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
}

export interface WorkbarScope {
  readonly workspacePath: string;
  readonly sessionId: string;
}
