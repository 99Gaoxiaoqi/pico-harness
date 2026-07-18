import type { JsonValue, RuntimeMethod, RuntimeRequest } from "./protocol.js";

type Awaitable<T> = T | Promise<T>;

/**
 * The control-plane router deliberately knows nothing about desktop domains.
 * It only owns method registration, fallback, and the protocol error for a
 * method that is not implemented by the desktop adapter.
 */
export type DesktopRequestHandler<Method extends RuntimeMethod = RuntimeMethod> = (
  request: RuntimeRequest<Method>,
) => Awaitable<JsonValue>;

export type DesktopRequestHandlers = Partial<{
  [Method in RuntimeMethod]: DesktopRequestHandler<Method>;
}>;

export interface DesktopRequestRouterOptions {
  readonly handlers?: DesktopRequestHandlers;
  readonly unsupportedMethods?: ReadonlySet<string>;
  readonly fallback?: DesktopRequestHandler;
  readonly methodNotFound: (method: string) => Error;
}

export class DesktopRequestRouter {
  private readonly handlers = new Map<RuntimeMethod, DesktopRequestHandler>();
  private readonly unsupportedMethods: ReadonlySet<string>;
  private readonly fallback?: DesktopRequestHandler;
  private readonly methodNotFound: (method: string) => Error;

  constructor(options: DesktopRequestRouterOptions) {
    this.unsupportedMethods = options.unsupportedMethods ?? new Set<string>();
    this.fallback = options.fallback;
    this.methodNotFound = options.methodNotFound;
    for (const [method, handler] of Object.entries(options.handlers ?? {})) {
      if (handler) {
        this.handlers.set(method as RuntimeMethod, handler as DesktopRequestHandler);
      }
    }
  }

  dispatch(request: RuntimeRequest): Promise<JsonValue> {
    const handler = this.handlers.get(request.method);
    if (handler) {
      return Promise.resolve().then(() => handler(request));
    }
    const fallback = this.fallback;
    if (fallback && !this.unsupportedMethods.has(request.method)) {
      return Promise.resolve().then(() => fallback(request));
    }
    return Promise.reject(this.methodNotFound(request.method));
  }
}
