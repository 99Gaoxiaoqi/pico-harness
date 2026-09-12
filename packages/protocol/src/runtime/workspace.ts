// Workspace lifecycle, diagnostics, and runtime capability negotiation contracts.
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  isJsonObject,
} from "./base.js";
import type {
  EmptyParams,
  JsonObject,
  SessionId,
  WorkspaceParams,
  WorkspaceRegistrationParams,
} from "./base.js";
import { runtimePluginDiagnosticResult } from "./capabilities.js";
import type { RuntimePluginDiagnostic } from "./capabilities.js";
import { RUNTIME_ERROR_CODES, protocolError } from "./errors.js";
import {
  booleanParam,
  boundedNonEmptyStringParam,
  exactParamShape,
  exactResultShape,
  finiteNumberParam,
  noParams,
  oneOfParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultJsonObject,
  resultNonNegativeInteger,
  resultNullable,
  resultOneOf,
  resultShape,
  resultString,
  resultStringArray,
  stringParam,
  workspaceParams,
} from "./validation.js";
import type { RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeWorkspaceInitResult = {
  readonly workspacePath: string;
  readonly files: readonly {
    readonly path: "AGENTS.md" | ".pico/config.json";
    readonly status: "created" | "existing";
  }[];
  readonly message: string;
};

export type RuntimeDiagnosticCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: "ok" | "warning" | "error" | "unavailable";
  readonly summary: string;
  readonly recommendation?: string;
};

export type RuntimeDiagnosticsReport = {
  readonly workspacePath: string;
  readonly healthy: boolean;
  readonly checks: readonly RuntimeDiagnosticCheck[];
  readonly output: string;
};

export type RuntimeResourceDiagnosticEntry = {
  readonly kind: string;
  readonly origin: "claude-compat" | "pico-native" | "runtime-state";
  readonly path: string;
  readonly status: "missing" | "present" | "unsafe";
  readonly authority: boolean;
  readonly reason?: string;
};

export type RuntimeResourceDiagnosticsReport = {
  readonly workDir: string;
  readonly picoHome: string;
  readonly workspaceStateRoot: string;
  readonly entries: readonly RuntimeResourceDiagnosticEntry[];
  readonly findings: readonly string[];
  /** Plugin snapshot diagnostics are surfaced by the host; they are not resource entries. */
  readonly pluginDiagnostics?: readonly RuntimePluginDiagnostic[];
  readonly output: string;
};

export interface EventLogStorageStatusResult extends JsonObject {
  readonly logicalBytes: number;
  readonly hardLimitBytes: number;
  readonly lowWatermarkBytes: number;
  readonly status: "within_limit" | "retention_required" | "quota_blocked";
  readonly canStartNewWork: boolean;
  readonly canWriteClosure: boolean;
  readonly plannedSessionCount: number;
  readonly estimatedLogicalBytesReclaimed: number;
}

export type WorkspaceStatusResult = JsonObject & {
  workspacePath: string;
  registered: boolean;
  readonly temporary?: true;
  schedulerStatus: "unknown";
  mode: "folder" | "git";
  branch: string;
  capabilities: {
    readonly foregroundRuns: boolean;
    readonly fileHistory: boolean;
    readonly isolatedWorktrees: boolean;
    readonly branchMerge: boolean;
  };
  eventLog: EventLogStorageStatusResult | null;
};

export const runtimeWorkspaceInitResult = exactResultShape({
  workspacePath: resultString,
  files: resultArray(
    exactResultShape({
      path: resultOneOf(["AGENTS.md", ".pico/config.json"]),
      status: resultOneOf(["created", "existing"]),
    }),
  ),
  message: resultString,
});

const runtimeDiagnosticCheckResult = exactResultShape(
  {
    id: resultString,
    label: resultString,
    status: resultOneOf(["ok", "warning", "error", "unavailable"]),
    summary: resultString,
  },
  { recommendation: resultString },
);

const runtimeDiagnosticsResult = exactResultShape({
  workspacePath: resultString,
  healthy: resultBoolean,
  checks: resultArray(runtimeDiagnosticCheckResult),
  output: resultString,
});

const runtimeResourceDiagnosticsResult = exactResultShape(
  {
    workDir: resultString,
    picoHome: resultString,
    workspaceStateRoot: resultString,
    entries: resultArray(
      exactResultShape(
        {
          kind: resultString,
          origin: resultOneOf(["claude-compat", "pico-native", "runtime-state"]),
          path: resultString,
          status: resultOneOf(["missing", "present", "unsafe"]),
          authority: resultBoolean,
        },
        { reason: resultString },
      ),
    ),
    findings: resultStringArray,
    output: resultString,
  },
  { pluginDiagnostics: resultArray(runtimePluginDiagnosticResult) },
);

const workspaceStatusResultRule = exactResultShape(
  {
    workspacePath: resultString,
    registered: resultBoolean,
    schedulerStatus: resultOneOf(["unknown"]),
    mode: resultOneOf(["folder", "git"]),
    branch: resultString,
    capabilities: exactResultShape({
      foregroundRuns: resultBoolean,
      fileHistory: resultBoolean,
      isolatedWorktrees: resultBoolean,
      branchMerge: resultBoolean,
    }),
  },
  {
    temporary: resultOneOf([true]),
    eventLog: resultNullable(
      exactResultShape({
        logicalBytes: resultNonNegativeInteger,
        hardLimitBytes: resultNonNegativeInteger,
        lowWatermarkBytes: resultNonNegativeInteger,
        status: resultOneOf(["within_limit", "retention_required", "quota_blocked"]),
        canStartNewWork: resultBoolean,
        canWriteClosure: resultBoolean,
        plannedSessionCount: resultNonNegativeInteger,
        estimatedLogicalBytesReclaimed: resultNonNegativeInteger,
      }),
    ),
  },
);

const temporaryWorkspaceStatusResultRule: RuntimeResultRule = (value, path) => {
  workspaceStatusResultRule(value, path);
  if (!isJsonObject(value)) return;
  resultOneOf([true])(value["temporary"], `${path}.temporary`);
  resultOneOf([true])(value["registered"], `${path}.registered`);
};

const runtimePingResult: RuntimeResultRule = (value, path) => {
  resultShape({
    pong: resultOneOf([true]),
    protocolVersion: resultOneOf([LOCAL_RUNTIME_PROTOCOL_VERSION]),
    desktopSchemaRevision: resultFiniteNumber,
    capabilities: resultStringArray,
    picoHome: resultString,
  })(value, path);
  if (!isJsonObject(value)) return;
  const capabilities = value["capabilities"];
  if (
    value["desktopSchemaRevision"] !== DESKTOP_RUNTIME_SCHEMA_REVISION ||
    !Array.isArray(capabilities) ||
    !capabilities.includes(DESKTOP_RUNTIME_SCHEMA_CAPABILITY) ||
    !capabilities.includes(CAPABILITY_SCOPE_RUNTIME_CAPABILITY) ||
    !capabilities.includes(TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY)
  ) {
    throw protocolError(
      RUNTIME_ERROR_CODES.VERSION_MISMATCH,
      `Desktop 需要 Runtime schema v${DESKTOP_RUNTIME_SCHEMA_REVISION}，请完全退出并重新启动 Pico`,
    );
  }
};

export type WorkspaceMethodMap = {
  readonly "runtime.ping": {
    readonly params: JsonObject;
    readonly result: {
      readonly pong: true;
      readonly protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
      readonly desktopSchemaRevision: typeof DESKTOP_RUNTIME_SCHEMA_REVISION;
      readonly capabilities: readonly string[];
      /** Canonical state root used by this daemon. */
      readonly picoHome: string;
    };
  };
  readonly "workspace.init": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeWorkspaceInitResult;
  };
  readonly "diagnostics.run": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeDiagnosticsReport;
  };
  readonly "diagnostics.resources": {
    readonly params: WorkspaceParams;
    readonly result: RuntimeResourceDiagnosticsReport;
  };
  readonly "usage.get": {
    readonly params: {
      readonly workspacePath?: string;
      readonly sessionId?: SessionId;
      readonly from?: number;
      readonly to?: number;
    };
    readonly result: { readonly usage: JsonObject };
  };
  readonly "workspace.register": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: true };
  };
  readonly "workspace.unregister": {
    readonly params: WorkspaceRegistrationParams;
    readonly result: { readonly workspacePath: string; readonly registered: false };
  };
  readonly "workspace.status": {
    readonly params: WorkspaceParams;
    readonly result: WorkspaceStatusResult;
  };
  readonly "workspace.storageRepair.prepare": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly candidate: { readonly token: string; readonly storagePath: string } | null;
    };
  };
  readonly "workspace.storageRepair.respond": {
    readonly params: WorkspaceParams & {
      readonly token: string;
      readonly action: "repair" | "cancel";
    };
    readonly result: { readonly repaired: boolean };
  };
  readonly "workspace.list": {
    readonly params: EmptyParams;
    readonly result: { readonly workspaces: readonly WorkspaceStatusResult[] };
  };
  readonly "workspace.temporary.ensure": {
    readonly params: EmptyParams;
    readonly result: WorkspaceStatusResult & { readonly temporary: true };
  };
  readonly "workspace.trust": {
    readonly params: WorkspaceParams & { readonly trusted: boolean };
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
  readonly "workspace.trustStatus": {
    readonly params: WorkspaceParams;
    readonly result: { readonly workspacePath: string; readonly trusted: boolean };
  };
};

export const workspaceParamValidators = {
  "runtime.ping": noParams,
  "workspace.init": workspaceParams,
  "diagnostics.run": workspaceParams,
  "diagnostics.resources": workspaceParams,
  "usage.get": exactParamShape(
    {},
    {
      workspacePath: stringParam,
      sessionId: stringParam,
      from: finiteNumberParam,
      to: finiteNumberParam,
    },
  ),
  "workspace.register": workspaceParams,
  "workspace.unregister": workspaceParams,
  "workspace.status": workspaceParams,
  "workspace.storageRepair.prepare": workspaceParams,
  "workspace.storageRepair.respond": exactParamShape({
    workspacePath: stringParam,
    token: boundedNonEmptyStringParam(128),
    action: oneOfParam(["repair", "cancel"]),
  }),
  "workspace.list": noParams,
  "workspace.temporary.ensure": noParams,
  "workspace.trust": exactParamShape({
    workspacePath: stringParam,
    trusted: booleanParam,
  }),
  "workspace.trustStatus": workspaceParams,
} satisfies Readonly<Record<keyof WorkspaceMethodMap, RuntimeParamValidator>>;

export const workspaceResultValidators = {
  "runtime.ping": runtimePingResult,
  "workspace.init": runtimeWorkspaceInitResult,
  "diagnostics.run": runtimeDiagnosticsResult,
  "diagnostics.resources": runtimeResourceDiagnosticsResult,
  "workspace.list": exactResultShape({ workspaces: resultArray(workspaceStatusResultRule) }),
  "workspace.status": workspaceStatusResultRule,
  "workspace.storageRepair.prepare": exactResultShape({
    candidate: resultNullable(exactResultShape({ token: resultString, storagePath: resultString })),
  }),
  "workspace.storageRepair.respond": exactResultShape({ repaired: resultBoolean }),
  "workspace.temporary.ensure": temporaryWorkspaceStatusResultRule,
  "workspace.register": resultShape({
    workspacePath: resultString,
    registered: resultOneOf([true]),
  }),
  "workspace.trustStatus": resultShape({ workspacePath: resultString, trusted: resultBoolean }),
  "usage.get": exactResultShape({ usage: resultJsonObject }),
  "workspace.unregister": exactResultShape({
    workspacePath: resultString,
    registered: resultOneOf([false]),
  }),
  "workspace.trust": exactResultShape({
    workspacePath: resultString,
    trusted: resultBoolean,
  }),
} satisfies Readonly<Record<keyof WorkspaceMethodMap, RuntimeResultRule>>;
