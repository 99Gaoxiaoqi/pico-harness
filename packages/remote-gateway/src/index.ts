export {
  RemoteGateway,
  createRemoteGateway,
  configureRemoteGateway,
  startConfiguredRemoteGateway,
  requestGatewayControl,
  validateCertificate,
} from "./server.js";
export type { RemoteGatewayOptions, GatewayAuditEntry } from "./server.js";
export type { GatewayConfig, GatewayDevice, GatewayWorkspace } from "./state.js";
export { defaultGatewayHome } from "./state.js";
export { GatewayError } from "./errors.js";
export type { GatewayRuntimeClient } from "./policy.js";
export { RuntimeAccessSession } from "./runtime-access.js";
export type { RuntimeAccessSessionOptions } from "./runtime-access.js";
export type {
  RuntimeAccessConfig,
  RuntimeAccessPrincipal,
  RuntimeAccessEventSink,
  RuntimeAccessEvents,
} from "./access-types.js";
export { runRemoteCli } from "./cli.js";

export {
  configureRelayGateway,
  prepareRelayBinding,
  readGatewayConfiguration,
} from "./relay-config.js";
export type { ConfigureRelayGatewayInput, GatewayConfigurationSummary } from "./relay-config.js";
