export interface SessionCursor {
  readonly logId: string;
  readonly seq: number;
  readonly epoch: number;
  readonly eventId: string;
}

export interface CommitReceipt {
  readonly eventId: string;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
  readonly durable: boolean;
  readonly inserted: boolean;
}

export interface SessionLineage {
  readonly relation: "root" | "fork" | "spawn" | "salvage";
  readonly rootLogId: string;
  readonly parent?: SessionCursor;
  readonly parentSessionId?: string;
  readonly parentTaskId?: string;
}
