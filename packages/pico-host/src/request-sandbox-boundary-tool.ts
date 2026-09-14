import { RequestSandboxBoundaryTool as RuntimeRequestSandboxBoundaryTool } from "@pico/runtime/request-sandbox-boundary";
import type {
  RequestSandboxBoundaryHandler as RuntimeRequestSandboxBoundaryHandler,
  RequestSandboxBoundarySettlement as RuntimeRequestSandboxBoundarySettlement,
} from "@pico/runtime/request-sandbox-boundary";
import type { SandboxBoundaryExpansion } from "@pico/core/permission-profile";
import { NO_FILE_SIDE_EFFECTS, type ToolExecutionContext } from "./tool-registry-contract.js";

export { MAX_SANDBOX_BOUNDARY_JUSTIFICATION_CHARS } from "@pico/runtime/request-sandbox-boundary";
export type { RequestSandboxBoundaryStatus } from "@pico/runtime/request-sandbox-boundary";

export type RequestSandboxBoundaryHandler =
  RuntimeRequestSandboxBoundaryHandler<ToolExecutionContext>;
export type RequestSandboxBoundarySettlement = RuntimeRequestSandboxBoundarySettlement;

/** @deprecated 请求工具的校验与稳定投影已迁至 @pico/runtime。 */
export class RequestSandboxBoundaryTool extends RuntimeRequestSandboxBoundaryTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(handler?: RequestSandboxBoundaryHandler) {
    super(handler);
  }
}

export type { SandboxBoundaryExpansion };
