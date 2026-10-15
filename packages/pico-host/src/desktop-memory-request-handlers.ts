import type { JsonValue, RuntimeRequest } from "@pico/protocol";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";

type Awaitable<T> = T | Promise<T>;

export interface DesktopMemoryRequestContext {
  readonly queryExperienceUses?: (params: RuntimeRequest<"memory.experience.query">["params"]) => Awaitable<JsonValue>;
  readonly detailExperienceUse?: (params: RuntimeRequest<"memory.experience.detail">["params"]) => Awaitable<JsonValue>;
  readonly feedbackExperienceUse?: (params: RuntimeRequest<"memory.experience.feedback">["params"]) => Awaitable<JsonValue>;
  readonly queryExperiences?: (
    params: RuntimeRequest<"memory.learning.query">["params"],
  ) => Awaitable<JsonValue>;
  readonly detailExperience?: (
    params: RuntimeRequest<"memory.learning.detail">["params"],
  ) => Awaitable<JsonValue>;
  readonly reviewExperience?: (
    params: RuntimeRequest<"memory.learning.review">["params"],
  ) => Awaitable<JsonValue>;
  readonly feedbackExperience?: (
    params: RuntimeRequest<"memory.learning.feedback">["params"],
  ) => Awaitable<JsonValue>;
  readonly listLearning?: (
    params: RuntimeRequest<"memory.learning.list">["params"],
  ) => Awaitable<JsonValue>;
  readonly inspectLearning?: (
    params: RuntimeRequest<"memory.learning.inspect">["params"],
  ) => Awaitable<JsonValue>;
  readonly discardLearning?: (
    params: RuntimeRequest<"memory.learning.discard">["params"],
  ) => Awaitable<JsonValue>;
  readonly list: (params: RuntimeRequest<"memory.list">["params"]) => Awaitable<JsonValue>;
  readonly get: (params: RuntimeRequest<"memory.get">["params"]) => Awaitable<JsonValue>;
  readonly create: (params: RuntimeRequest<"memory.create">["params"]) => Awaitable<JsonValue>;
  readonly update: (params: RuntimeRequest<"memory.update">["params"]) => Awaitable<JsonValue>;
  readonly delete: (params: RuntimeRequest<"memory.delete">["params"]) => Awaitable<JsonValue>;
  readonly getSettings: (
    params: RuntimeRequest<"memory.settings.get">["params"],
  ) => Awaitable<JsonValue>;
  readonly updateSettings: (
    params: RuntimeRequest<"memory.settings.update">["params"],
  ) => Awaitable<JsonValue>;
  readonly previewContext: (
    params: RuntimeRequest<"memory.context.preview">["params"],
  ) => Awaitable<JsonValue>;
  readonly getMetrics: (
    params: RuntimeRequest<"memory.metrics.get">["params"],
  ) => Awaitable<JsonValue>;
  readonly listConsolidationHistory: (
    params: RuntimeRequest<"memory.consolidation.history">["params"],
  ) => Awaitable<JsonValue>;
  readonly undoConsolidation: (
    params: RuntimeRequest<"memory.consolidation.undo">["params"],
  ) => Awaitable<JsonValue>;
}

export function createDesktopMemoryRequestHandlers(
  context: DesktopMemoryRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "memory.experience.query"
  | "memory.experience.detail"
  | "memory.experience.feedback"
  | "memory.learning.query"
  | "memory.learning.detail"
  | "memory.learning.review"
  | "memory.learning.feedback"
  | "memory.list"
  | "memory.learning.list"
  | "memory.learning.inspect"
  | "memory.learning.discard"
  | "memory.get"
  | "memory.create"
  | "memory.update"
  | "memory.delete"
  | "memory.settings.get"
  | "memory.settings.update"
  | "memory.context.preview"
  | "memory.metrics.get"
  | "memory.consolidation.history"
  | "memory.consolidation.undo"
> {
  return {
    "memory.experience.query": request => context.queryExperienceUses?.(request.params) ?? Promise.reject(new Error("Experience feedback unavailable")),
    "memory.experience.detail": request => context.detailExperienceUse?.(request.params) ?? Promise.reject(new Error("Experience feedback unavailable")),
    "memory.experience.feedback": request => context.feedbackExperienceUse?.(request.params) ?? Promise.reject(new Error("Experience feedback unavailable")),
    "memory.learning.query": (request) =>
      context.queryExperiences?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.learning.detail": (request) =>
      context.detailExperience?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.learning.review": (request) =>
      context.reviewExperience?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.learning.feedback": (request) =>
      context.feedbackExperience?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.learning.list": (request) =>
      context.listLearning?.(request.params) ?? Promise.reject(new Error("Learning unavailable")),
    "memory.learning.inspect": (request) =>
      context.inspectLearning?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.learning.discard": (request) =>
      context.discardLearning?.(request.params) ??
      Promise.reject(new Error("Learning unavailable")),
    "memory.list": (request) => context.list(request.params),
    "memory.get": (request) => context.get(request.params),
    "memory.create": (request) => context.create(request.params),
    "memory.update": (request) => context.update(request.params),
    "memory.delete": (request) => context.delete(request.params),
    "memory.settings.get": (request) => context.getSettings(request.params),
    "memory.settings.update": (request) => context.updateSettings(request.params),
    "memory.context.preview": (request) => context.previewContext(request.params),
    "memory.metrics.get": (request) => context.getMetrics(request.params),
    "memory.consolidation.history": (request) => context.listConsolidationHistory(request.params),
    "memory.consolidation.undo": (request) => context.undoConsolidation(request.params),
  };
}
