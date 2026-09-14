import {
  CreateGoalTool as RuntimeCreateGoalTool,
  GetGoalTool as RuntimeGetGoalTool,
  UpdateGoalTool as RuntimeUpdateGoalTool,
} from "@pico/runtime/goal-tools";
import { NO_FILE_SIDE_EFFECTS } from "@pico/pico-host/tool-registry-contract";

/** @deprecated Goal 工具的校验和展示投影已迁至 @pico/runtime。 */
export class CreateGoalTool extends RuntimeCreateGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** @deprecated Goal 工具的校验和展示投影已迁至 @pico/runtime。 */
export class GetGoalTool extends RuntimeGetGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** @deprecated Goal 工具的校验和展示投影已迁至 @pico/runtime。 */
export class UpdateGoalTool extends RuntimeUpdateGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}
