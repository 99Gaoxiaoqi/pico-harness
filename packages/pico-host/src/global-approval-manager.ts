import {
  ApprovalManager as HostApprovalManager,
  type ApprovalNotice as HostApprovalNotice,
  type ApprovalNotifier as HostApprovalNotifier,
  type ApprovalPreview,
  type ApprovalResult,
} from "./approval-manager.js";
import { logger } from "./logger.js";
import type { PermissionSessionScope } from "@pico/runtime/session-permission-policy";

export type { ApprovalPreview, ApprovalResult };
export type ApprovalNotice = HostApprovalNotice<PermissionSessionScope>;
export type ApprovalNotifier = HostApprovalNotifier<PermissionSessionScope>;

/** @deprecated Human approval state now lives in @pico/pico-host. */
export class ApprovalManager extends HostApprovalManager<PermissionSessionScope> {
  constructor(timeoutMs?: number) {
    super(timeoutMs, logger);
  }
}

export const globalApprovalManager = new ApprovalManager();

/** @deprecated Runtime approval policy now lives in @pico/runtime. */
export {
  classifyHardlineCommand,
  isDangerousCommand,
  isHardlineCommand,
  type HardlineReasonKind,
} from "@pico/runtime/approval-policy";
