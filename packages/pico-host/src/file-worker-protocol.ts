export type FileWorkerOperation =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "glob"
  | "grep"
  | "explore_repo";

export interface FileTargetIdentity {
  readonly kind: "missing" | "file" | "directory";
  readonly dev?: string;
  readonly ino?: string;
  readonly size?: string;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
}

export function sameFileTargetIdentity(
  expected: FileTargetIdentity,
  actual: FileTargetIdentity,
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "missing") return true;
  // AppContainer's exact ACL grant changes Windows change-time even though the
  // pinned file object and its data have not changed. The Broker pins its
  // handle against replacement while the worker runs; compare the stable file
  // identity, size and data modification time here.
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs &&
    (process.platform === "win32" || expected.ctimeNs === actual.ctimeNs)
  );
}

export interface FileWorkerRequest {
  readonly operationId: string;
  readonly boundaryRevision: number;
  readonly operation: FileWorkerOperation;
  readonly args: string;
  readonly workDir: string;
  readonly stagePath: string;
  readonly targets: readonly { path: string; identity: FileTargetIdentity }[];
  readonly excludeSensitiveFiles: boolean;
}

export interface FileWorkerResponse {
  readonly operationId: string;
  readonly boundaryRevision: number;
  readonly ok: boolean;
  readonly result?: string;
  readonly preparedDigest?: string;
  readonly preparedBytes?: number;
  readonly error?: string;
}
