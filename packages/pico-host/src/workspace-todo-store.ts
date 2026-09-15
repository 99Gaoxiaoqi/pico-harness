import { TodoStore as StorageTodoStore, type TodoStoreLogger } from "@pico/storage/todo-store";
import { resolvePicoPaths, type ResolvePicoPathsOptions } from "./pico-paths.js";

/** Host adapter from workspace identity to Storage's canonical Todo store root. */
export class WorkspaceTodoStore extends StorageTodoStore {
  constructor(workDir: string, options: ResolvePicoPathsOptions = {}, logger?: TodoStoreLogger) {
    super(resolvePicoPaths(workDir, options).workspace.root, logger);
  }
}

export type {
  TodoItem,
  TodoPriority,
  TodoState,
  TodoStatus,
  TodoStoreLogger,
} from "@pico/storage/todo-store";
