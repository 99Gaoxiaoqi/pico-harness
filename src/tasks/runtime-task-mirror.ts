import {
  RuntimeTaskMirror as RuntimeTaskMirrorBase,
  type RuntimeTaskMirrorOptions as RuntimeTaskMirrorBaseOptions,
} from "@pico/runtime/runtime-task-mirror";
import { logger } from "../observability/logger.js";

export {
  materializeRuntimeTaskSnapshot,
  materializeRuntimeTaskSnapshots,
  type RuntimeTaskMirrorLogger,
} from "@pico/runtime/runtime-task-mirror";
export type RuntimeTaskMirrorOptions = Omit<RuntimeTaskMirrorBaseOptions, "logger">;

/** @deprecated Runtime task mirroring has moved to @pico/runtime; this adapter injects logging. */
export class RuntimeTaskMirror extends RuntimeTaskMirrorBase {
  constructor(
    registry: ConstructorParameters<typeof RuntimeTaskMirrorBase>[0],
    jobs: ConstructorParameters<typeof RuntimeTaskMirrorBase>[1],
    options: RuntimeTaskMirrorOptions = {},
  ) {
    super(registry, jobs, { ...options, logger });
  }
}
