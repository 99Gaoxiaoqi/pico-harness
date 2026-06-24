import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";

export interface DelegationResult {
  taskIndex: number;
  status: "completed" | "error";
  summary?: string;
  error?: string;
  durationMs: number;
}

export interface DelegationBatchResult {
  results: DelegationResult[];
  totalDurationMs: number;
}

export interface DelegationManagerOptions {
  maxConcurrentChildren?: number;
  maxAsyncChildren?: number;
}

interface DelegationRecord {
  id: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  completedAt?: number;
  result?: DelegationBatchResult;
  error?: string;
  promise: Promise<void>;
}

export class DelegationManager {
  private readonly records = new Map<string, DelegationRecord>();
  private nextId = 1;

  readonly maxConcurrentChildren: number;
  private readonly maxAsyncChildren: number;

  constructor(options: DelegationManagerOptions = {}) {
    this.maxConcurrentChildren = options.maxConcurrentChildren ?? 3;
    this.maxAsyncChildren = options.maxAsyncChildren ?? 3;
  }

  dispatch(runner: () => Promise<DelegationBatchResult>): {
    status: string;
    delegationId?: string;
    error?: string;
  } {
    if (this.activeCount >= this.maxAsyncChildren) {
      return {
        status: "rejected",
        error: `后台委派数量已达上限 ${this.maxAsyncChildren}`,
      };
    }

    const id = `delegation-${Date.now()}-${this.nextId}`;
    this.nextId++;

    const record: DelegationRecord = {
      id,
      status: "running",
      startedAt: Date.now(),
      promise: Promise.resolve(),
    };

    record.promise = Promise.resolve()
      .then(runner)
      .then((result) => {
        record.status = "completed";
        record.result = result;
        record.completedAt = Date.now();
      })
      .catch((err: unknown) => {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
      });

    this.records.set(id, record);
    return { status: "dispatched", delegationId: id };
  }

  snapshot(id: string): Record<string, unknown> {
    const record = this.records.get(id);
    if (!record) {
      return { status: "not_found", error: `找不到委派任务: ${id}` };
    }

    return {
      delegationId: record.id,
      status: record.status,
      startedAt: record.startedAt,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  async wait(id: string): Promise<void> {
    await this.records.get(id)?.promise;
  }

  private get activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") {
        count++;
      }
    }
    return count;
  }
}

export class DelegateStatusTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly manager: DelegationManager) {}

  name(): string {
    return "delegate_status";
  }

  definition(): ToolDefinition {
    return {
      name: "delegate_status",
      description: "查询 background=true 委派任务的状态和完成结果。",
      inputSchema: {
        type: "object",
        properties: {
          delegation_id: {
            type: "string",
            description: "delegate_task 返回的 delegationId。",
          },
        },
        required: ["delegation_id"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let delegationId: string;
    try {
      const input = JSON.parse(args) as { delegation_id?: string; delegationId?: string };
      delegationId = input.delegation_id ?? input.delegationId ?? "";
    } catch {
      throw new Error("解析 delegate_status 参数失败:需 JSON 格式 {delegation_id: string}");
    }

    if (!delegationId) {
      return JSON.stringify({ status: "error", error: "缺少 delegation_id 参数" });
    }

    return JSON.stringify(this.manager.snapshot(delegationId));
  }
}
