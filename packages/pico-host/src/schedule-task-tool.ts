import type { ScheduleDraftCoordinator } from "@pico/core/cron-draft-contract";
import { ScheduleTaskTool as RuntimeScheduleTaskTool } from "@pico/runtime/schedule-task";
import type { ToolExecutionContext } from "./tool-registry-contract.js";
import { NO_FILE_SIDE_EFFECTS } from "./tool-registry-contract.js";

export { looksLikeScheduleCreationIntent } from "@pico/runtime/schedule-intent";

/** @deprecated 输入校验与结果投影已迁至 @pico/runtime。 */
export class ScheduleTaskTool extends RuntimeScheduleTaskTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(coordinator: ScheduleDraftCoordinator<ToolExecutionContext>) {
    super(coordinator);
  }
}
