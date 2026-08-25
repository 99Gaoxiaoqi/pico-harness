export interface WorkspaceSessionRef {
  readonly workspacePath: string;
  readonly sessionId: string;
}

export interface WorkspaceScopedItem {
  readonly workspacePath: string;
}

export const TEMPORARY_WORKSPACE_LABEL = "临时工作区";

export interface WorkspaceLabelSource {
  readonly path: string;
  readonly name: string;
  readonly temporary?: true | undefined;
}

export function workspaceName(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || workspacePath;
}

export function workspaceDisplayName(
  workspacePath: string,
  workspace?: WorkspaceLabelSource,
): string {
  if (workspace?.temporary) return TEMPORARY_WORKSPACE_LABEL;
  return workspace?.name ?? workspaceName(workspacePath);
}

export function workspaceParent(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const pieces = normalized.split(/[\\/]/u);
  pieces.pop();
  return pieces.join("/") || workspacePath;
}

export function workspaceSessionKey(ref: WorkspaceSessionRef): string {
  return JSON.stringify([ref.workspacePath, ref.sessionId]);
}

export function replaceWorkspaceItems<T extends WorkspaceScopedItem>(
  current: readonly T[],
  workspacePath: string,
  incoming: readonly T[],
): readonly T[] {
  return [...incoming, ...current.filter((item) => item.workspacePath !== workspacePath)];
}

export function workspaceHref(pathname: string, workspacePath: string): string {
  const params = new URLSearchParams({ workspace: workspacePath });
  return `${pathname}?${params.toString()}`;
}

export function sessionHref(ref: WorkspaceSessionRef): string {
  return workspaceHref(`/session/${encodeURIComponent(ref.sessionId)}`, ref.workspacePath);
}

export function isActiveWorkspaceSession(
  ref: WorkspaceSessionRef,
  pathname: string,
  search: string,
): boolean {
  return (
    pathname === `/session/${encodeURIComponent(ref.sessionId)}` &&
    workspacePathFromSearch(search) === ref.workspacePath
  );
}

export function newSessionHref(workspacePath?: string): string {
  return workspacePath ? workspaceHref("/task/new", workspacePath) : "/task/new";
}

export function workspacePathFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get("workspace")?.trim();
  return value || undefined;
}
