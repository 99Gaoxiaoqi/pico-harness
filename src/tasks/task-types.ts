export type TaskType =
  | "local_bash"
  | "local_agent"
  | "remote_agent"
  | "local_workflow"
  | "monitor_mcp";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export interface TaskSnapshot {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile?: string;
  outputOffset: number;
  notified: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface CreateTaskInput {
  description?: string;
  toolUseId?: string;
  outputFile?: string;
  outputOffset?: number;
  notified?: boolean;
  data?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  description?: string;
  toolUseId?: string;
  outputFile?: string;
  outputOffset?: number;
  notified?: boolean;
  data?: Record<string, unknown>;
}

export type TaskSubscriber = (snapshot: TaskSnapshot) => void;

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}
