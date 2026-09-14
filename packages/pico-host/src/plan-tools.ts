import {
  CancelPlanTool as RuntimeCancelPlanTool,
  SubmitPlanTool as RuntimeSubmitPlanTool,
  UpdatePlanTool as RuntimeUpdatePlanTool,
} from "@pico/runtime/plan-tools";
import type { ToolExecutionContext } from "@pico/pico-host/tool-registry-contract";
import { NO_FILE_SIDE_EFFECTS } from "@pico/pico-host/tool-registry-contract";

export type { PlanCoordinatorFactory } from "@pico/runtime/plan-tools";

/** @deprecated Plan 工具的输入校验、投影与 handoff 已迁至 @pico/runtime。 */
export class SubmitPlanTool extends RuntimeSubmitPlanTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** @deprecated Plan 工具的输入校验、投影与 handoff 已迁至 @pico/runtime。 */
export class UpdatePlanTool extends RuntimeUpdatePlanTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** @deprecated Plan 工具的输入校验、投影与 handoff 已迁至 @pico/runtime。 */
export class CancelPlanTool extends RuntimeCancelPlanTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}
