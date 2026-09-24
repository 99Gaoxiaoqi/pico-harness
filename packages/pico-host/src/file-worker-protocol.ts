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
