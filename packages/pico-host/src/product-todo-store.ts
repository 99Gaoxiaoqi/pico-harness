import { WorkspaceTodoStore } from "@pico/pico-host/workspace-todo-store";
import type { ResolvePicoPathsOptions } from "@pico/pico-host/pico-paths";
import { logger } from "@pico/pico-host/logger";

export type {
  TodoItem,
  TodoPriority,
  TodoState,
  TodoStatus,
  TodoStoreLogger,
} from "@pico/storage/todo-store";

/**
 * @deprecated Todo 的持久化实现已迁至 @pico/storage；此适配器仅负责把
 * workDir/picoHome 解析为宿主确定的 workspace storageRoot。
 */
export class TodoStore extends WorkspaceTodoStore {
  constructor(workDir: string, options: ResolvePicoPathsOptions = {}) {
    super(workDir, options, logger);
  }
}
