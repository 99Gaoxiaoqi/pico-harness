import type { JsonValue, RuntimeRequest } from "./protocol.js";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";

type Awaitable<T> = T | Promise<T>;

/**
 * Desktop workspace/session methods exposed to the protocol router.
 *
 * The service still owns all domain state and persistence. This context is only the
 * narrow control-plane boundary needed to register request handlers; it deliberately
 * does not expose stores, providers, or a generic service locator.
 */
export interface DesktopSessionRequestContext {
  readonly initializeWorkspace: (workspacePath: string) => Awaitable<JsonValue>;
  readonly listWorkspaces: () => Awaitable<JsonValue>;
  readonly trustStatus: (workspacePath: string) => Awaitable<JsonValue>;
  readonly setTrust: (workspacePath: string, trusted: boolean) => Awaitable<JsonValue>;
  readonly unregisterWorkspace: (workspacePath: string) => Promise<JsonValue>;
  readonly listSessions: (workspacePath: string, includeArchived?: boolean) => Awaitable<JsonValue>;
  readonly getSession: (workspacePath: string, sessionId: string) => Awaitable<JsonValue>;
  readonly createSession: (workspacePath: string, title?: string) => Awaitable<JsonValue>;
  readonly setSessionArchived: (
    workspacePath: string,
    sessionId: string,
    archived: boolean,
  ) => Awaitable<JsonValue>;
  readonly renameSession: (
    workspacePath: string,
    sessionId: string,
    title: string,
  ) => Awaitable<JsonValue>;
  readonly forkSession: (workspacePath: string, sessionId: string) => Awaitable<JsonValue>;
  readonly compactSession: (workspacePath: string, sessionId: string) => Awaitable<JsonValue>;
  readonly getRuntimeSessionSettings: (
    workspacePath: string,
    sessionId: string,
  ) => Awaitable<JsonValue>;
  readonly updateRuntimeSessionSettings: (
    params: RuntimeRequest<"session.settings.update">["params"],
  ) => Awaitable<JsonValue>;
  readonly getGoal: (workspacePath: string, sessionId: string) => Awaitable<JsonValue>;
  readonly sendSession: (params: RuntimeRequest<"session.send">["params"]) => Promise<JsonValue>;
  readonly getSessionTranscript: (
    params: RuntimeRequest<"session.transcript">["params"],
  ) => Awaitable<JsonValue>;
  readonly cancelRun: (
    workspacePath: string,
    runId: string,
    reason?: string,
  ) => Awaitable<JsonValue>;
  readonly withProviderDependencyLock: (operation: () => Promise<JsonValue>) => Promise<JsonValue>;
  readonly runStart: (request: RuntimeRequest<"run.start">) => Promise<JsonValue>;
}

/** Build the workspace/session portion of the Desktop request map. */
export function createDesktopSessionRequestHandlers(
  context: DesktopSessionRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "workspace.init"
  | "workspace.list"
  | "workspace.trustStatus"
  | "workspace.trust"
  | "workspace.unregister"
  | "session.list"
  | "session.get"
  | "session.create"
  | "session.archive"
  | "session.restore"
  | "session.rename"
  | "session.fork"
  | "session.compact"
  | "session.settings.get"
  | "session.settings.update"
  | "goal.get"
  | "session.send"
  | "session.transcript"
  | "run.cancel"
  | "run.start"
> {
  return {
    "workspace.init": (request) => context.initializeWorkspace(request.params.workspacePath),
    "workspace.list": () => context.listWorkspaces(),
    "workspace.trustStatus": (request) => context.trustStatus(request.params.workspacePath),
    "workspace.trust": (request) =>
      context.setTrust(request.params.workspacePath, request.params.trusted),
    "workspace.unregister": (request) =>
      context.withProviderDependencyLock(() =>
        context.unregisterWorkspace(request.params.workspacePath),
      ),
    "session.list": (request) =>
      context.listSessions(request.params.workspacePath, request.params.includeArchived),
    "session.get": (request) =>
      context.getSession(request.params.workspacePath, request.params.sessionId),
    "session.create": (request) =>
      context.createSession(request.params.workspacePath, request.params.title),
    "session.archive": (request) =>
      context.setSessionArchived(request.params.workspacePath, request.params.sessionId, true),
    "session.restore": (request) =>
      context.setSessionArchived(request.params.workspacePath, request.params.sessionId, false),
    "session.rename": (request) =>
      context.renameSession(
        request.params.workspacePath,
        request.params.sessionId,
        request.params.title,
      ),
    "session.fork": (request) =>
      context.forkSession(request.params.workspacePath, request.params.sessionId),
    "session.compact": (request) =>
      context.compactSession(request.params.workspacePath, request.params.sessionId),
    "session.settings.get": (request) =>
      context.getRuntimeSessionSettings(request.params.workspacePath, request.params.sessionId),
    "session.settings.update": (request) => context.updateRuntimeSessionSettings(request.params),
    "goal.get": (request) =>
      context.getGoal(request.params.workspacePath, request.params.sessionId),
    "session.send": (request) =>
      context.withProviderDependencyLock(() => context.sendSession(request.params)),
    "session.transcript": (request) => context.getSessionTranscript(request.params),
    "run.cancel": (request) =>
      context.cancelRun(request.params.workspacePath, request.params.runId, request.params.reason),
    "run.start": (request) => context.withProviderDependencyLock(() => context.runStart(request)),
  };
}
