import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  StorageOperationJournal as StorageOperationJournalImplementation,
  type StorageOperationJournalOptions,
} from "@pico/storage/operation-journal";

export {
  isTerminalStorageOperation,
  type ForkStorageOperation,
  type NewStorageOperation,
  type RewindStorageOperation,
  type StorageOperation,
  type StorageOperationDisposition,
  type StorageOperationDispositionInput,
  type StorageOperationError,
  type StorageOperationState,
  type StoredFileState,
} from "@pico/storage/operation-journal";

/** @deprecated 新代码应传入显式 storageRoot 并从 @pico/storage 导入。 */
export interface OperationJournalOptions {
  readonly workDir: string;
  readonly picoHome?: string;
  readonly now?: () => Date;
}

/** 兼容 workDir/picoHome 构造方式；SQLite 实现已迁至 @pico/storage。 */
export class StorageOperationJournal extends StorageOperationJournalImplementation {
  constructor(options: OperationJournalOptions) {
    const storageOptions: StorageOperationJournalOptions = {
      storageRoot: resolvePicoPaths(options.workDir, {
        ...(options.picoHome !== undefined ? { picoHome: options.picoHome } : {}),
      }).workspace.root,
      ...(options.now !== undefined ? { now: options.now } : {}),
    };
    super(storageOptions);
  }
}
