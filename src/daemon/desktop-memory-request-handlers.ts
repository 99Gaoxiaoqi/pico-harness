import type { JsonValue, RuntimeRequest } from "./protocol.js";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";

type Awaitable<T> = T | Promise<T>;

export interface DesktopMemoryRequestContext {
  readonly list: (params: RuntimeRequest<"memory.list">["params"]) => Awaitable<JsonValue>;
  readonly get: (params: RuntimeRequest<"memory.get">["params"]) => Awaitable<JsonValue>;
  readonly update: (params: RuntimeRequest<"memory.update">["params"]) => Awaitable<JsonValue>;
  readonly forget: (params: RuntimeRequest<"memory.forget">["params"]) => Awaitable<JsonValue>;
  readonly listReviews: (
    params: RuntimeRequest<"memory.review.list">["params"],
  ) => Awaitable<JsonValue>;
  readonly resolveReview: (
    params: RuntimeRequest<"memory.review.resolve">["params"],
  ) => Awaitable<JsonValue>;
  readonly getSettings: (
    params: RuntimeRequest<"memory.settings.get">["params"],
  ) => Awaitable<JsonValue>;
  readonly updateSettings: (
    params: RuntimeRequest<"memory.settings.update">["params"],
  ) => Awaitable<JsonValue>;
  readonly previewContext: (
    params: RuntimeRequest<"memory.context.preview">["params"],
  ) => Awaitable<JsonValue>;
}

export function createDesktopMemoryRequestHandlers(
  context: DesktopMemoryRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "memory.list"
  | "memory.get"
  | "memory.update"
  | "memory.forget"
  | "memory.review.list"
  | "memory.review.resolve"
  | "memory.settings.get"
  | "memory.settings.update"
  | "memory.context.preview"
> {
  return {
    "memory.list": (request) => context.list(request.params),
    "memory.get": (request) => context.get(request.params),
    "memory.update": (request) => context.update(request.params),
    "memory.forget": (request) => context.forget(request.params),
    "memory.review.list": (request) => context.listReviews(request.params),
    "memory.review.resolve": (request) => context.resolveReview(request.params),
    "memory.settings.get": (request) => context.getSettings(request.params),
    "memory.settings.update": (request) => context.updateSettings(request.params),
    "memory.context.preview": (request) => context.previewContext(request.params),
  };
}
