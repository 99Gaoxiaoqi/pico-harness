import {
  CreateGoalTool as RuntimeCreateGoalTool,
  GetGoalTool as RuntimeGetGoalTool,
  PauseGoalTool as RuntimePauseGoalTool,
  ResumeGoalTool as RuntimeResumeGoalTool,
  ClearGoalTool as RuntimeClearGoalTool,
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

export class PauseGoalTool extends RuntimePauseGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}
export class ResumeGoalTool extends RuntimeResumeGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}
export class ClearGoalTool extends RuntimeClearGoalTool {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}
