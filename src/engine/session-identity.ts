import { resolve } from "node:path";

export interface SessionIdentity {
  readonly sessionId: string;
  readonly originalCwd: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly sessionProjectDir: string;
}

export interface CreateSessionIdentityOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly originalCwd?: string;
  readonly projectRoot?: string;
  readonly sessionProjectDir?: string;
}

export function createSessionIdentity(options: CreateSessionIdentityOptions): SessionIdentity {
  const cwd = normalizePath(options.cwd);
  const originalCwd = normalizePath(options.originalCwd ?? cwd);
  const projectRoot = normalizePath(options.projectRoot ?? cwd);
  const sessionProjectDir = normalizePath(options.sessionProjectDir ?? projectRoot);

  return {
    sessionId: options.sessionId,
    originalCwd,
    projectRoot,
    cwd,
    sessionProjectDir,
  };
}

export function isSameSessionProjectGroup(
  left: Pick<SessionIdentity, "projectRoot" | "sessionProjectDir">,
  right: Pick<SessionIdentity, "projectRoot" | "sessionProjectDir">,
): boolean {
  return (
    normalizePath(left.sessionProjectDir) === normalizePath(right.sessionProjectDir) ||
    normalizePath(left.projectRoot) === normalizePath(right.projectRoot)
  );
}

function normalizePath(path: string): string {
  return resolve(path).normalize("NFC");
}
