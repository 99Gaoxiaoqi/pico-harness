import { withWorkspaceSqliteLease } from "./sqlite/workspace-scopes.js";

/** 任务状态。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 任务优先级。 */
export type TodoPriority = "high" | "medium" | "low";

/** 单条任务。 */
export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

/** 完整清单状态(序列化到 workspace_kv 的结构)。 */
export interface TodoState {
  items: TodoItem[];
  /** 下一个自增 id,避免删除后 id 重叠。 */
  nextId: number;
}

/** Storage 不绑定具体日志实现；宿主可选择记录降级原因。 */
export interface TodoStoreLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

const WORKSPACE_KV_TODO_KEY = "todo";

/** 优先级排序权重(高→中→低),用于 list/buildTodoContext 稳定排序。 */
const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * 结构化 TodoList 的 SQLite 存储实现。调用方须传入已由宿主解析的 workspace
 * storageRoot；该包不解释 workDir 或 picoHome，因此不反向依赖 Pico Host。
 */
export class TodoStore {
  /** 内存缓存:所有变更先落到内存,再异步落盘。 */
  private state: TodoState = { items: [], nextId: 1 };

  /** 是否已加载过磁盘状态(避免每次操作都重读)。 */
  private loaded = false;

  constructor(
    private readonly storageRoot: string,
    private readonly logger?: TodoStoreLogger,
  ) {
    if (!storageRoot.trim()) throw new Error("Todo storageRoot must not be empty");
  }

  /**
   * 从 workspace_kv 加载清单状态到内存缓存。行不存在、IO 失败或畸形 JSON
   * 均降级为空 state，不阻断主流程；仅首次真正读库。
   */
  async load(): Promise<TodoState> {
    if (this.loaded) return this.state;

    let raw: string | undefined;
    try {
      const row = withWorkspaceSqliteLease(this.storageRoot, (lease) =>
        lease.transaction("read", () =>
          lease.database
            .prepare("SELECT value_json FROM workspace_kv WHERE key = ?")
            .get(WORKSPACE_KV_TODO_KEY),
        ),
      ) as { value_json?: unknown } | undefined;
      raw = typeof row?.["value_json"] === "string" ? row["value_json"] : undefined;
    } catch (err) {
      this.logger?.warn(
        { err, storageRoot: this.storageRoot },
        "读取 workspace_kv todo 失败,降级为空清单",
      );
      this.loaded = true;
      return this.state;
    }

    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as Partial<TodoState>;
        if (parsed && Array.isArray(parsed.items) && typeof parsed.nextId === "number") {
          this.state = normalizeState(parsed as TodoState);
        } else {
          this.logger?.warn(
            { storageRoot: this.storageRoot },
            "workspace_kv todo 结构非法,降级为空清单",
          );
        }
      } catch (err) {
        this.logger?.warn(
          { err, storageRoot: this.storageRoot },
          "workspace_kv todo 解析失败,降级为空清单",
        );
      }
    }

    this.loaded = true;
    return this.state;
  }

  /** 强制重读存储，丢弃内存中尚未成功落盘的改动。 */
  async reload(): Promise<TodoState> {
    this.loaded = false;
    return this.load();
  }

  /** workspace_kv 单行 UPSERT，在单个写事务内提交；失败只记录告警。 */
  async save(): Promise<void> {
    try {
      const json = JSON.stringify(this.state, null, 2);
      withWorkspaceSqliteLease(this.storageRoot, (lease) =>
        lease.transaction("write", () =>
          lease.database
            .prepare(
              `INSERT INTO workspace_kv (key, value_json) VALUES (?, ?)
               ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
            )
            .run(WORKSPACE_KV_TODO_KEY, json),
        ),
      );
    } catch (err) {
      this.logger?.warn({ err, storageRoot: this.storageRoot }, "workspace_kv todo 持久化失败");
    }
  }

  async add(content: string, priority: TodoPriority = "medium"): Promise<TodoItem> {
    await this.load();
    const item: TodoItem = {
      id: this.state.nextId,
      content,
      status: "pending",
      priority,
    };
    this.state.items.push(item);
    this.state.nextId++;
    await this.save();
    return item;
  }

  async update(
    id: number,
    patch: Partial<Pick<TodoItem, "content" | "priority" | "status">>,
  ): Promise<TodoItem | undefined> {
    await this.load();
    const item = this.state.items.find((it) => it.id === id);
    if (!item) return undefined;
    if (patch.content !== undefined) item.content = patch.content;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.status !== undefined) item.status = patch.status;
    await this.save();
    return item;
  }

  async toggle(id: number): Promise<TodoItem | undefined> {
    await this.load();
    const item = this.state.items.find((it) => it.id === id);
    if (!item) return undefined;
    item.status = nextStatus(item.status);
    await this.save();
    return item;
  }

  async remove(id: number): Promise<boolean> {
    await this.load();
    const idx = this.state.items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    this.state.items.splice(idx, 1);
    await this.save();
    return true;
  }

  list(): TodoItem[] {
    return [...this.state.items].sort(compareItems);
  }

  async buildTodoContext(): Promise<string> {
    await this.load();
    const items = this.list();
    if (items.length === 0) return "";

    const lines: string[] = ["## 📋 当前 TodoList"];
    for (const item of items) {
      lines.push(`- ${statusMark(item.status)} #${item.id} (${item.priority}) ${item.content}`);
    }
    return lines.join("\n");
  }
}

function statusMark(status: TodoStatus): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "in_progress":
      return "[~]";
    case "completed":
      return "[x]";
  }
}

function nextStatus(status: TodoStatus): TodoStatus {
  switch (status) {
    case "pending":
      return "in_progress";
    case "in_progress":
      return "completed";
    case "completed":
      return "pending";
  }
}

function compareItems(a: TodoItem, b: TodoItem): number {
  const weight = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (weight !== 0) return weight;
  return a.id - b.id;
}

function normalizeState(state: TodoState): TodoState {
  const validPriorities: ReadonlySet<string> = new Set(["high", "medium", "low"]);
  const validStatuses: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

  const items: TodoItem[] = [];
  let maxId = 0;
  for (const raw of state.items) {
    if (!raw || typeof raw !== "object") continue;
    const { id, content, status, priority } = raw as Partial<TodoItem>;
    if (typeof id !== "number" || typeof content !== "string") continue;
    if (!validStatuses.has(status ?? "")) continue;
    if (!validPriorities.has(priority ?? "")) continue;
    items.push({ id, content, status: status as TodoStatus, priority: priority as TodoPriority });
    if (id > maxId) maxId = id;
  }

  const nextId = Math.max(state.nextId, maxId + 1);
  return { items, nextId };
}
