import {
  CredentialRotationCoordinator as RuntimeCredentialRotationCoordinator,
  type CredentialRouteProviderFactory as RuntimeCredentialRouteProviderFactory,
} from "@pico/runtime/credential-rotation";
import type { CredentialPool } from "@pico/runtime/credential-pool";
import type { ProviderConfig } from "./config.js";

export type CredentialRouteProviderFactory = RuntimeCredentialRouteProviderFactory<ProviderConfig>;

/** @deprecated 凭据轮换执行策略已迁入 @pico/runtime。 */
export class CredentialRotationCoordinator extends RuntimeCredentialRotationCoordinator<ProviderConfig> {
  constructor(
    pool: CredentialPool,
    initialConfig: ProviderConfig,
    providerFactory: CredentialRouteProviderFactory,
  ) {
    super(pool, initialConfig, providerFactory);
  }
}
