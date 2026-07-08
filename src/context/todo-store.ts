// TodoStore:结构化任务清单的持久化存储层。
//
// 对应 pico-harness "状态外部化" 哲学的结构化落地:相比 PlanStore 的自由
// Markdown 文本,这里用 JSON 维护一个有 id/状态/优先级的任务清单,供
// TodoTool 程序化增删改查,并把当前进度渲染成 Markdown 注入 system prompt。
//
// 设计借鉴:
// - PlanStore 的路径绑定模式(构造时固定 <workDir>/.claw/todo.json,杜绝穿越)
// - SkillRegistry 的 JSON 持久化模式(内存缓存 + 每次变更即刻落盘 + IO 错误降级)
//
// 错误处理约定:所有 IO 错误降级不阻断主流程。
//   - load 失败(ENOENT/权限/畸形 JSON)→ 返回空 state,不抛
//   - save 失败(权限/磁盘满)→ 只记 warn 不抛,内存缓存仍生效

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { logger } from "../observability/logger.js";

const TODO_FILENAME = "todo.json";

/** 任务状态 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 任务优先级 */
export type TodoPriority = "high" | "medium" | "low";

/** 单条任务 */
export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

/** 完整清单状态(序列化到磁盘的结构) */
export interface TodoState {
  items: TodoItem[];
  /** 下一个自增 id,避免删除后 id 重叠 */
  nextId: number;
}

/** 优先级排序权重(高→中→低),用于 list/buildTodoContext 稳定排序 */
const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * 结构化 TodoList 存储层,绑定到固定工作区路径。
 *
 * 路径在构造时固定为 <workDir>/.claw/todo.json,外部无法变更,
 * 从源头杜绝路径穿越风险(无需额外防护)。
 */
export class TodoStore {
  private readonly todoPath: string;

  /** 内存缓存:所有变更先落到内存,再异步落盘 */
  private state: TodoState = { items: [], nextId: 1 };

  /** 是否已加载过磁盘状态(避免每次操作都重读文件) */
  private loaded = false;

  constructor(workDir: string) {
    this.todoPath = join(workDir, ".claw", TODO_FILENAME);
  }

  /**
   * 从磁盘加载清单状态到内存缓存。
   * - 文件不存在(ENOENT):返回空 state,不抛
   * - 权限不足(EACCES):返回空 state,不抛
   * - 畸形 JSON:返回空 state,不抛
   * 幂等:多次调用安全,仅首次真正读盘。
   *
   * 注意:首次加载后内存缓存被冻结,本实例看不到磁盘上的后续变化。
   * 跨实例实时可见性靠 host 注入同一 TodoStore 单例(对标 GoalManager),
   * 本类的 reload() 仅作跨进程/兜底场景的强制重读入口。
   */
  async load(): Promise<TodoState> {
    if (this.loaded) return this.state;

    let raw: string;
    try {
      raw = await readFile(this.todoPath, "utf8");
    } catch (err) {
      // ENOENT/EACCES:全新工作区或无权限,静默返回空 state
      if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EACCES")) {
        this.loaded = true;
        return this.state;
      }
      // 其他 IO 错误:记 warn 后返回空 state,不阻断
      logger.warn({ err, path: this.todoPath }, "读取 todo.json 失败,降级为空清单");
      this.loaded = true;
      return this.state;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<TodoState>;
      // 防御畸形 JSON:字段缺失或类型错乱时回退到空 state
      if (
        parsed &&
        Array.isArray(parsed.items) &&
        typeof parsed.nextId === "number"
      ) {
        this.state = normalizeState(parsed as TodoState);
      } else {
        logger.warn({ path: this.todoPath }, "todo.json 结构非法,降级为空清单");
      }
    } catch (err) {
      // JSON.parse 失败:降级为空 state,不抛
      logger.warn({ err, path: this.todoPath }, "todo.json 解析失败,降级为空清单");
    }

    this.loaded = true;
    return this.state;
  }

  /**
   * 强制重读磁盘,忽略已加载的内存缓存。
   *
   * 用途:跨进程读取场景(如 CLI 新进程读取旧 todo.json)或兜底排查。
   * 单进程内的实时可见性应由 host 注入同一 TodoStore 单例保证(对标 GoalManager),
   * 不应依赖 reload 轮询——否则并发写存在竞态窗口。
   *
   * 副作用:丢弃当前内存缓存中未落盘的改动(正常运行链路里 save 先于 reload,故无影响)。
   */
  async reload(): Promise<TodoState> {
    this.loaded = false;
    return this.load();
  }

  /**
   * 把内存缓存落盘。
   * mkdir recursive 保证 .claw 目录存在;失败只记 warn 不抛,
   * 内存缓存仍保持最新值,后续操作不受影响。
   */
  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.todoPath), { recursive: true });
      const json = JSON.stringify(this.state, null, 2);
      await writeFile(this.todoPath, json, "utf8");
    } catch (err) {
      // 持久化失败记 warn 但不抛出异常(优雅降级)
      logger.warn({ err, path: this.todoPath }, "todo.json 持久化失败");
    }
  }

  /**
   * 添加一条新任务。
   * @param content 任务内容
   * @param priority 优先级,默认 medium
   * @returns 新创建的任务对象(含自动分配的 id)
   */
  async add(
    content: string,
    priority: TodoPriority = "medium",
  ): Promise<TodoItem> {
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

  /**
   * 更新指定任务的部分字段。
   * @param id 任务 id
   * @param patch 要更新的字段(content/priority/status)
   * @returns 更新后的任务;找不到返回 undefined
   */
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

  /**
   * 循环切换任务状态:pending → in_progress → completed → pending。
   * @param id 任务 id
   * @returns 切换后的任务;找不到返回 undefined
   */
  async toggle(id: number): Promise<TodoItem | undefined> {
    await this.load();
    const item = this.state.items.find((it) => it.id === id);
    if (!item) return undefined;
    item.status = nextStatus(item.status);
    await this.save();
    return item;
  }

  /**
   * 删除指定任务。
   * @param id 任务 id
   * @returns 是否删除成功(找不到返回 false)
   */
  async remove(id: number): Promise<boolean> {
    await this.load();
    const idx = this.state.items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    this.state.items.splice(idx, 1);
    await this.save();
    return true;
  }

  /**
   * 返回当前任务列表(排序后)。
   * 排序规则:优先级(高→低)优先,同优先级按 id 升序,保证稳定输出。
   */
  list(): TodoItem[] {
    return [...this.state.items].sort(compareItems);
  }

  /**
   * 渲染当前清单为 Markdown,用于注入 system prompt。
   * - 空列表返回空字符串(不注入,避免污染 prompt)
   * - 状态标记:[ ] pending / [~] in_progress / [x] completed
   */
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

/** 状态对应的 checkbox 标记 */
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

/** 循环推进状态:pending → in_progress → completed → pending */
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

/** 排序比较:优先级权重优先,同优先级按 id 升序 */
function compareItems(a: TodoItem, b: TodoItem): number {
  const w = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (w !== 0) return w;
  return a.id - b.id;
}

/**
 * 归一化从磁盘加载的 state:逐项校验字段,丢弃畸形条目,
 * 确保 nextId 不小于现有最大 id + 1。
 */
function normalizeState(state: TodoState): TodoState {
  const validPriorities: ReadonlySet<string> = new Set(["high", "medium", "low"]);
  const validStatuses: ReadonlySet<string> = new Set([
    "pending",
    "in_progress",
    "completed",
  ]);

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

  // nextId 不能小于现有最大 id + 1,否则会复用已删除/已存在的 id
  const nextId = Math.max(state.nextId, maxId + 1);
  return { items, nextId };
}

/** 判断异常是否为指定 code 的 Node ErrnoException */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
