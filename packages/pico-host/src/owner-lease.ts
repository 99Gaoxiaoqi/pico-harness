import { configureOwnerLeaseDiagnostics } from "@pico/storage";
import { logger } from "./logger.js";

// 保持旧入口的宿主日志行为；Storage 本身只持有可选的诊断端口。
configureOwnerLeaseDiagnostics({
  onTransientHeartbeatError(error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[OwnerLease] heartbeat encountered transient filesystem error; skipping this cycle",
    );
  },
});

export {
  LeaseConflictError,
  OwnerLease,
  resolveOwnerLeaseTombstonePath,
  retireOwnerLeaseForTerminatedProcess,
} from "@pico/storage";
export type {
  OwnerLeaseOptions,
  OwnerLeaseRecord,
  RetireTerminatedOwnerLeaseOptions,
} from "@pico/storage";
