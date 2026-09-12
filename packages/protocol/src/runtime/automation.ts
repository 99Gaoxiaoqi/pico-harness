// Scheduled jobs and automation credential contracts with their parameter/result rules.
import type { JobId, JsonObject, RunId, RuntimeJobStatus, WorkspaceParams } from "./base.js";
import { runtimeRunResult } from "./session.js";
import type { RuntimeRun } from "./session.js";
import {
  booleanParam,
  exactParamShape,
  exactResultShape,
  finiteNumberParam,
  oneOfParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultNonEmptyString,
  resultOneOf,
  resultString,
  stringArrayParam,
  stringParam,
  workspaceJobParams,
  workspaceParams,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeJob = JsonObject & {
  readonly jobId: JobId;
  readonly workspacePath: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly status: RuntimeJobStatus;
  readonly updatedAt: number;
};

export const runtimeJobResult = exactResultShape({
  jobId: resultNonEmptyString,
  workspacePath: resultNonEmptyString,
  name: resultNonEmptyString,
  prompt: resultNonEmptyString,
  schedule: resultNonEmptyString,
  enabled: resultBoolean,
  status: resultOneOf(["idle", "running", "failed", "succeeded"]),
  updatedAt: resultFiniteNumber,
});

export type AutomationMethodMap = {
  readonly "jobs.list": {
    readonly params: WorkspaceParams;
    readonly result: { readonly jobs: readonly RuntimeJob[] };
  };
  readonly "jobs.create": {
    readonly params: WorkspaceParams & {
      readonly name: string;
      readonly prompt: string;
      readonly schedule: string;
      readonly enabled?: boolean;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.update": {
    readonly params: WorkspaceParams & {
      readonly jobId: JobId;
      readonly name?: string;
      readonly prompt?: string;
      readonly schedule?: string;
    };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.delete": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly deleted: boolean };
  };
  readonly "jobs.setEnabled": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly enabled: boolean };
    readonly result: { readonly job: RuntimeJob };
  };
  readonly "jobs.runNow": {
    readonly params: WorkspaceParams & { readonly jobId: JobId };
    readonly result: { readonly job: RuntimeJob; readonly runId: RunId };
  };
  readonly "jobs.history": {
    readonly params: WorkspaceParams & { readonly jobId: JobId; readonly limit?: number };
    readonly result: { readonly runs: readonly RuntimeRun[] };
  };
  /**
   * Trusted TUI-to-daemon boundary. These methods are intentionally absent from
   * the Desktop preload allowlist: the daemon re-resolves Provider authority and
   * background policy before mutating the durable Cron ledger or credential vault.
   */
  readonly "automation.credential.import": {
    readonly params: WorkspaceParams & {
      readonly modelRouteId: string;
      readonly expectedCredentialRef: string;
      readonly secret: string;
    };
    readonly result: {
      readonly imported: true;
      readonly credentialRef: string;
    };
  };
  readonly "automation.create": {
    readonly params: WorkspaceParams & {
      readonly name?: string;
      readonly prompt: string;
      readonly schedule: string;
      readonly timeZone?: string;
      readonly modelRouteId: string;
      readonly expectedCredentialRef: string;
      readonly allowedTools: readonly string[];
      readonly toolNetworkPolicy: "allow" | "disabled" | "allowlist";
      readonly allowedToolNetworkHosts?: readonly string[];
      readonly enabled?: boolean;
    };
    readonly result: { readonly job: RuntimeJob };
  };
};

export const automationParamValidators = {
  "jobs.list": workspaceParams,
  "jobs.create": exactParamShape(
    {
      workspacePath: stringParam,
      name: stringParam,
      prompt: stringParam,
      schedule: stringParam,
    },
    { enabled: booleanParam },
  ),
  "jobs.update": exactParamShape(
    { workspacePath: stringParam, jobId: stringParam },
    { name: stringParam, prompt: stringParam, schedule: stringParam },
  ),
  "jobs.delete": workspaceJobParams,
  "jobs.setEnabled": exactParamShape({
    workspacePath: stringParam,
    jobId: stringParam,
    enabled: booleanParam,
  }),
  "jobs.runNow": workspaceJobParams,
  "jobs.history": exactParamShape(
    { workspacePath: stringParam, jobId: stringParam },
    { limit: finiteNumberParam },
  ),
  "automation.credential.import": exactParamShape({
    workspacePath: stringParam,
    modelRouteId: stringParam,
    expectedCredentialRef: stringParam,
    secret: stringParam,
  }),
  "automation.create": exactParamShape(
    {
      workspacePath: stringParam,
      prompt: stringParam,
      schedule: stringParam,
      modelRouteId: stringParam,
      expectedCredentialRef: stringParam,
      allowedTools: stringArrayParam,
      toolNetworkPolicy: oneOfParam(["allow", "disabled", "allowlist"]),
    },
    {
      name: stringParam,
      timeZone: stringParam,
      allowedToolNetworkHosts: stringArrayParam,
      enabled: booleanParam,
    },
  ),
} satisfies Readonly<Record<keyof AutomationMethodMap, RuntimeParamValidator>>;

export const automationResultValidators = {
  "jobs.list": exactResultShape({ jobs: resultArray(runtimeJobResult) }),
  "jobs.create": exactResultShape({ job: runtimeJobResult }),
  "jobs.update": exactResultShape({ job: runtimeJobResult }),
  "jobs.delete": exactResultShape({ deleted: resultBoolean }),
  "jobs.setEnabled": exactResultShape({ job: runtimeJobResult }),
  "jobs.runNow": exactResultShape({ job: runtimeJobResult, runId: resultString }),
  "jobs.history": exactResultShape({ runs: resultArray(runtimeRunResult) }),
  "automation.credential.import": exactResultShape({
    imported: resultOneOf([true]),
    credentialRef: resultString,
  }),
  "automation.create": exactResultShape({ job: runtimeJobResult }),
} satisfies Readonly<Record<keyof AutomationMethodMap, RuntimeResultRule>>;
