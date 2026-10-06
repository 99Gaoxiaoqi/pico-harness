/** Desktop process entrypoint: keep CLI-only terminal renderers outside Electron bundles. */
export { startConfiguredRemoteGateway, requestGatewayControl } from "./server.js";
export { defaultGatewayHome } from "./state.js";
export { configureRelayGateway, readGatewayConfiguration } from "./relay-config.js";
export type { RemoteGatewayOptions, GatewayAuditEntry } from "./server.js";
export type { GatewayRuntimeClient } from "./policy.js";

export {
  readGatewayServiceState,
  setGatewayDesiredRunning,
  beginGatewayMaintenance,
  finishGatewayMaintenance,
  recordGatewayExit,
  readActiveGatewayRuntime,
  writeActiveGatewayRuntime,
  validateActiveGatewayRuntime,
  ensureGatewaySupervisionDirectory,
} from "./supervision-state.js";
export type {
  GatewayServiceState,
  ActiveGatewayRuntime,
  GatewayExit,
} from "./supervision-state.js";

export { gatewayAuthorizationMetrics } from "./access-metrics.js";
