import type { JsonValue, RuntimeRequest } from "@pico/protocol";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";

export interface DesktopAutomationPort {
  list(workspacePath: string): readonly JsonValue[];
  create(
    workspacePath: string,
    params: RuntimeRequest<"jobs.create">["params"],
  ): Promise<JsonValue>;
  createTrusted(
    workspacePath: string,
    params: RuntimeRequest<"automation.create">["params"],
    foregroundOnlyTools: ReadonlySet<string>,
  ): Promise<JsonValue>;
  update(
    workspacePath: string,
    jobId: string,
    params: RuntimeRequest<"jobs.update">["params"],
  ): JsonValue;
  delete(workspacePath: string, jobId: string): boolean;
  setEnabled(workspacePath: string, jobId: string, enabled: boolean): Promise<JsonValue>;
  runNow(
    workspacePath: string,
    jobId: string,
  ): Promise<{ readonly job: JsonValue; readonly runId: string }>;
  history(workspacePath: string, jobId: string, limit?: number): readonly JsonValue[];
}

/** Dependencies retained by the Desktop composition root. */
export interface DesktopAutomationRequestContext {
  readonly automations?: DesktopAutomationPort;
  readonly foregroundOnlyTools: (
    workspacePath: string,
    allowedTools: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly requireTrustedWorkspace: (workspacePath: string) => Promise<string>;
  readonly publishJob: (job: JsonValue) => void;
  readonly withProviderDependencyLock: (operation: () => Promise<JsonValue>) => Promise<JsonValue>;
}

/** Build the Automation CRUD/import request boundary. */
export function createDesktopAutomationRequestHandlers(
  context: DesktopAutomationRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "jobs.list"
  | "jobs.create"
  | "jobs.update"
  | "jobs.delete"
  | "jobs.setEnabled"
  | "jobs.runNow"
  | "jobs.history"
  | "automation.create"
> {
  const requireAutomations = (): DesktopAutomationPort => {
    if (context.automations) return context.automations;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
      "Automations 尚未连接到 daemon Cron runtime",
    );
  };

  const listJobs = async (workspacePath: string): Promise<JsonValue> => {
    const [canonical, automations] = await Promise.all([
      context.requireTrustedWorkspace(workspacePath),
      Promise.resolve(requireAutomations()),
    ]);
    return { jobs: automations.list(canonical) };
  };

  const createTrustedAutomation = async (
    params: RuntimeRequest<"automation.create">["params"],
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const foregroundOnlyTools = await context.foregroundOnlyTools(canonical, params.allowedTools);
    const job = await requireAutomations().createTrusted(canonical, params, foregroundOnlyTools);
    context.publishJob(job);
    return { job };
  };

  const createJob = async (params: RuntimeRequest<"jobs.create">["params"]): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const job = await requireAutomations().create(canonical, params);
    context.publishJob(job);
    return { job };
  };

  const updateJob = async (params: RuntimeRequest<"jobs.update">["params"]): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(params.workspacePath);
    const job = requireAutomations().update(canonical, params.jobId, params);
    context.publishJob(job);
    return { job };
  };

  const deleteJob = async (workspacePath: string, jobId: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    return { deleted: requireAutomations().delete(canonical, jobId) };
  };

  const setJobEnabled = async (
    workspacePath: string,
    jobId: string,
    enabled: boolean,
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const job = await requireAutomations().setEnabled(canonical, jobId, enabled);
    context.publishJob(job);
    return { job };
  };

  const runJobNow = async (workspacePath: string, jobId: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const result = await requireAutomations().runNow(canonical, jobId);
    context.publishJob(result.job);
    return result;
  };

  const jobHistory = async (
    workspacePath: string,
    jobId: string,
    limit?: number,
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    return { runs: requireAutomations().history(canonical, jobId, limit) };
  };

  return {
    "jobs.list": (request) => listJobs(request.params.workspacePath),
    "jobs.create": (request) => context.withProviderDependencyLock(() => createJob(request.params)),
    "jobs.update": (request) => updateJob(request.params),
    "jobs.delete": (request) => deleteJob(request.params.workspacePath, request.params.jobId),
    "jobs.setEnabled": (request) =>
      context.withProviderDependencyLock(() =>
        setJobEnabled(request.params.workspacePath, request.params.jobId, request.params.enabled),
      ),
    "jobs.runNow": (request) =>
      context.withProviderDependencyLock(() =>
        runJobNow(request.params.workspacePath, request.params.jobId),
      ),
    "jobs.history": (request) =>
      jobHistory(request.params.workspacePath, request.params.jobId, request.params.limit),
    "automation.create": (request) =>
      context.withProviderDependencyLock(() => createTrustedAutomation(request.params)),
  };
}
