/** Desktop process entrypoint: keep CLI-only terminal renderers outside Electron bundles. */
export { startConfiguredRemoteGateway, requestGatewayControl } from "./server.js";
export { defaultGatewayHome } from "./state.js";
export { configureRelayGateway, readGatewayConfiguration } from "./relay-config.js";
export type { RemoteGatewayOptions, GatewayAuditEntry } from "./server.js";
export type { GatewayRuntimeClient } from "./policy.js";
