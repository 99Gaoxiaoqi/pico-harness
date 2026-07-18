import type { DesktopRequestHandlers } from "./desktop-request-router.js";
import type { JsonValue, RuntimeRequest } from "./protocol.js";

type Awaitable<T> = T | Promise<T>;

/**
 * Provider/config protocol mapping owned by the Desktop composition root.
 *
 * The controller keeps provider stores, credential vaults and recovery state;
 * this module only maps typed protocol requests to that already-owned domain.
 */
export interface DesktopProviderRequestContext {
  readonly getUserConfig: (
    params: RuntimeRequest<"config.user.get">["params"],
  ) => Awaitable<JsonValue>;
  readonly updateUserConfig: (
    params: RuntimeRequest<"config.user.update">["params"],
  ) => Awaitable<JsonValue>;
  readonly listUserProviders: (
    params: RuntimeRequest<"provider.list">["params"],
  ) => Awaitable<JsonValue>;
  readonly upsertUserProvider: (
    params: RuntimeRequest<"provider.upsert">["params"],
  ) => Awaitable<JsonValue>;
  readonly importEnvironmentProvider: (
    params: RuntimeRequest<"provider.importEnvironment">["params"],
  ) => Awaitable<JsonValue>;
  readonly deleteUserProvider: (
    params: RuntimeRequest<"provider.delete">["params"],
  ) => Awaitable<JsonValue>;
  readonly getProviderCredentialStatus: (
    params: RuntimeRequest<"provider.credential.status">["params"],
  ) => Awaitable<JsonValue>;
  readonly setProviderCredential: (
    params: RuntimeRequest<"provider.credential.set">["params"],
  ) => Awaitable<JsonValue>;
  readonly deleteProviderCredential: (
    params: RuntimeRequest<"provider.credential.delete">["params"],
  ) => Awaitable<JsonValue>;
  readonly withProviderDependencyLock: (operation: () => Promise<JsonValue>) => Promise<JsonValue>;
}

/** Build only the provider/config portion of the Desktop request map. */
export function createDesktopProviderRequestHandlers(
  context: DesktopProviderRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "config.user.get"
  | "config.user.update"
  | "provider.list"
  | "provider.upsert"
  | "provider.importEnvironment"
  | "provider.delete"
  | "provider.credential.status"
  | "provider.credential.set"
  | "provider.credential.delete"
> {
  return {
    "config.user.get": (request) => context.getUserConfig(request.params),
    "config.user.update": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.updateUserConfig(request.params)),
      ),
    "provider.list": (request) => context.listUserProviders(request.params),
    "provider.upsert": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.upsertUserProvider(request.params)),
      ),
    "provider.importEnvironment": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.importEnvironmentProvider(request.params)),
      ),
    "provider.delete": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.deleteUserProvider(request.params)),
      ),
    "provider.credential.status": (request) => context.getProviderCredentialStatus(request.params),
    "provider.credential.set": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.setProviderCredential(request.params)),
      ),
    "provider.credential.delete": (request) =>
      context.withProviderDependencyLock(() =>
        Promise.resolve(context.deleteProviderCredential(request.params)),
      ),
  };
}
