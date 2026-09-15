import assert from "node:assert/strict";
import test from "node:test";
import type { TodoItem, TodoPriority, TodoStatus } from "@pico/storage/todo-store";
import { TodoTool, type TodoStorePort } from "@pico/runtime/todo-tool";

class MemoryTodoStore implements TodoStorePort {
  private nextId = 1;
  private items: TodoItem[] = [];

  async load(): Promise<void> {}

  async add(content: string, priority: TodoPriority = "medium"): Promise<TodoItem> {
    const item: TodoItem = { id: this.nextId++, content, priority, status: "pending" };
    this.items.push(item);
    return item;
  }

  async update(
    id: number,
    patch: Partial<Pick<TodoItem, "content" | "priority" | "status">>,
  ): Promise<TodoItem | undefined> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    if (patch.content !== undefined) item.content = patch.content;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.status !== undefined) item.status = patch.status;
    return item;
  }

  async toggle(id: number): Promise<TodoItem | undefined> {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return undefined;
    item.status = nextStatus(item.status);
    return item;
  }

  async remove(id: number): Promise<boolean> {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  list(): TodoItem[] {
    return [...this.items];
  }

  async buildTodoContext(): Promise<string> {
    return this.items.map((item) => `#${item.id}:${item.status}`).join("\n");
  }
}

function nextStatus(status: TodoStatus): TodoStatus {
  if (status === "pending") return "in_progress";
  if (status === "in_progress") return "completed";
  return "pending";
}

test("TodoTool keeps the source compatibility entry while Runtime owns validation and projection", async () => {
  const tool = new TodoTool(new MemoryTodoStore());
  assert.equal(tool.name(), "todo");
  assert.deepEqual(tool.accesses("{}"), [{ kind: "all" }]);

  const added = await tool.execute(
    JSON.stringify({ action: "add", content: "迁移工具", priority: "high" }),
  );
  assert.match(added, /已添加任务 #1/u);
  assert.match(added, /#1:pending/u);

  const updated = await tool.execute(
    JSON.stringify({ action: "update", id: "1", status: "in_progress", content: "验证兼容入口" }),
  );
  assert.match(updated, /已更新任务 #1/u);
  assert.match(updated, /#1:in_progress/u);

  const toggled = await tool.execute(JSON.stringify({ action: "toggle", id: 1 }));
  assert.match(toggled, /\[x\]/u);
  assert.match(await tool.execute(JSON.stringify({ action: "list" })), /\[x\]/u);

  await assert.rejects(tool.execute(JSON.stringify({ action: "update", id: 1 })), /至少需提供/u);
  await assert.rejects(
    tool.execute(JSON.stringify({ action: "add", content: "x", priority: "urgent" })),
    /非法 priority/u,
  );
});
