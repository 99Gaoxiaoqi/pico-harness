import type { JsonValue, RuntimeRequest } from "./protocol.js";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";

type WorkbarMethod =
  | "session.tasks.query"
  | "session.tasks.command"
  | "session.artifacts.query"
  | "session.artifacts.command"
  | "session.trace.query";

export type DesktopWorkbarRequestContext = {
  readonly [Method in WorkbarMethod]: (
    params: RuntimeRequest<Method>["params"],
  ) => Promise<JsonValue> | JsonValue;
};

export function createDesktopWorkbarRequestHandlers(
  context: DesktopWorkbarRequestContext,
): Pick<DesktopRequestHandlers, WorkbarMethod> {
  return {
    "session.tasks.query": (request) => context["session.tasks.query"](request.params),
    "session.tasks.command": (request) => context["session.tasks.command"](request.params),
    "session.artifacts.query": (request) => context["session.artifacts.query"](request.params),
    "session.artifacts.command": (request) => context["session.artifacts.command"](request.params),
    "session.trace.query": (request) => context["session.trace.query"](request.params),
  };
}
