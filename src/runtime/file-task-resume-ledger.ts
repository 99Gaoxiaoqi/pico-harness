import type {
  TaskResumeLedger,
  TaskResumeLedgerAppendInput,
  TaskResumeLedgerAppendResult,
} from "./safe-boundary-resume.js";
import { TaskRunStore, TaskRunStoreRevisionConflictError } from "../tasks/task-run-store.js";

/** Adapts the canonical file-backed TaskRun store to the revision-CAS resume port. */
export class FileTaskResumeLedger implements TaskResumeLedger {
  constructor(private readonly store: TaskRunStore) {}

  readProjection(taskRunId: string) {
    return this.store.readTaskRunProjection(taskRunId);
  }

  async appendBatch(input: TaskResumeLedgerAppendInput): Promise<TaskResumeLedgerAppendResult> {
    try {
      await this.store.appendBatch(input.taskRunId, input.events, {
        transactionId: input.transactionId,
        expectedRevision: input.expectedRevision,
      });
    } catch (error) {
      if (error instanceof TaskRunStoreRevisionConflictError) {
        return { status: "conflict", projection: error.projection };
      }
      throw error;
    }
    const projection = await this.store.readTaskRunProjection(input.taskRunId);
    if (!projection) {
      throw new Error(
        `TaskRun ${input.taskRunId} disappeared after its resume transaction committed`,
      );
    }
    return { status: "committed", projection };
  }
}
