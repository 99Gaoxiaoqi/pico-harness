// Provider and user configuration contracts with their parameter/result rules.
import type {
  EmptyParams,
  JsonObject,
  RuntimeCollaborationMode,
  RuntimeConfigSource,
  RuntimeCredentialSource,
  RuntimeCredentialStatus,
  RuntimeOrchestrationMode,
  RuntimePermissionMode,
  RuntimeProviderKind,
  WorkspaceParams,
} from "./base.js";
import { invalidParams } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  collaborationModeParam,
  exactParamShape,
  exactResultShape,
  finiteNumberParam,
  jsonObjectParam,
  noParams,
  oneOfParam,
  orchestrationModeParam,
  permissionModeParam,
  providerProtocolParam,
  resultArray,
  resultBoolean,
  resultFiniteNumber,
  resultJsonObject,
  resultOneOf,
  resultShape,
  resultString,
  resultStringArray,
  stringArrayParam,
  stringParam,
  workspaceParams,
} from "./validation.js";
import type { RuntimeParamRule, RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeProviderInput = JsonObject & {
  readonly id: string;
  readonly protocol: RuntimeProviderKind;
  readonly modelProtocols?: Readonly<Record<string, RuntimeProviderKind>>;
  readonly baseURL: string;
  readonly apiKeyEnv: string;
  readonly auth?: "api-key" | "none";
  readonly models: readonly string[];
  readonly discoverModels: boolean;
  readonly modelCapabilities?: JsonObject;
};

export type RuntimeProviderProfile = RuntimeProviderInput & {
  readonly origin: Extract<RuntimeConfigSource, "user" | "environment">;
  readonly fingerprint: string;
  readonly credentialStatus: RuntimeCredentialStatus;
  readonly credentialSource: RuntimeCredentialSource;
  /** A durable config or provider-scoped system credential exists. */
  readonly storedCredentialPresent: boolean;
};

export type RuntimeUserDefaults = JsonObject & {
  readonly modelRouteId?: string;
  readonly collaborationMode?: RuntimeCollaborationMode;
  readonly orchestrationMode?: RuntimeOrchestrationMode;
  readonly permissionMode?: RuntimePermissionMode;
  readonly thinkingEffort?: string;
};

export type RuntimeUserConfig = JsonObject & {
  readonly version: 1;
  readonly defaults: RuntimeUserDefaults;
  readonly providers: readonly RuntimeProviderInput[];
};

export type RuntimeEffectiveConfig = JsonObject & {
  readonly defaultModelRouteId?: string;
  readonly defaults: RuntimeUserDefaults;
  readonly providers: readonly RuntimeProviderProfile[];
  readonly sources: JsonObject;
  readonly revisions: {
    readonly user: string;
    readonly project: string;
  };
};

const modelProtocolsParam: RuntimeParamRule = (value, path) => {
  jsonObjectParam(value, path);
  for (const [model, protocol] of Object.entries(value as JsonObject)) {
    if (
      !model.trim() ||
      model !== model.trim() ||
      ["__proto__", "constructor", "prototype"].includes(model)
    ) {
      throw invalidParams(`${path} contains an invalid model id`);
    }
    providerProtocolParam(protocol, `${path}.${model}`);
  }
};

const runtimeProviderParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(
    value,
    path,
    {
      id: stringParam,
      protocol: providerProtocolParam,
      baseURL: stringParam,
      apiKeyEnv: stringParam,
      models: stringArrayParam,
      discoverModels: booleanParam,
    },
    {
      modelCapabilities: jsonObjectParam,
      modelProtocols: modelProtocolsParam,
      auth: oneOfParam(["api-key", "none"]),
    },
  );
};

export const runtimeUserDefaultsParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(
    value,
    path,
    {},
    {
      modelRouteId: stringParam,
      collaborationMode: collaborationModeParam,
      orchestrationMode: orchestrationModeParam,
      permissionMode: permissionModeParam,
      thinkingEffort: stringParam,
    },
  );
};

const runtimeProviderInputResult = resultShape(
  {
    id: resultString,
    protocol: resultOneOf(["openai", "claude", "responses"]),
    baseURL: resultString,
    apiKeyEnv: resultString,
    models: resultStringArray,
    discoverModels: resultBoolean,
  },
  {
    modelCapabilities: resultJsonObject,
    modelProtocols: resultJsonObject,
    auth: resultOneOf(["api-key", "none"]),
  },
);

const runtimeProviderProfileResult = resultShape(
  {
    id: resultString,
    protocol: resultOneOf(["openai", "claude", "responses"]),
    baseURL: resultString,
    apiKeyEnv: resultString,
    models: resultStringArray,
    discoverModels: resultBoolean,
    origin: resultOneOf(["user", "environment"]),
    fingerprint: resultString,
    credentialStatus: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    credentialSource: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
  },
  {
    modelCapabilities: resultJsonObject,
    modelProtocols: resultJsonObject,
    auth: resultOneOf(["api-key", "none"]),
  },
);

const runtimeUserDefaultsResult = exactResultShape(
  {},
  {
    modelRouteId: resultString,
    collaborationMode: resultOneOf(["agent", "plan"]),
    orchestrationMode: resultOneOf(["default", "graph", "swarm"]),
    permissionMode: resultOneOf(["ask", "auto", "full-access"]),
    thinkingEffort: resultString,
  },
);

const runtimeUserConfigResult = resultShape({
  version: resultOneOf([1]),
  defaults: runtimeUserDefaultsResult,
  providers: resultArray(runtimeProviderInputResult),
});

const runtimeEffectiveConfigResult = resultShape(
  {
    defaults: runtimeUserDefaultsResult,
    providers: resultArray(runtimeProviderProfileResult),
    sources: resultJsonObject,
    revisions: exactResultShape({ user: resultString, project: resultString }),
  },
  { defaultModelRouteId: resultString },
);

export type ConfigMethodMap = {
  readonly "config.get": {
    readonly params: WorkspaceParams;
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.update": {
    readonly params: WorkspaceParams & {
      readonly patch: JsonObject;
      readonly expectedVersion: number;
    };
    readonly result: { readonly config: JsonObject; readonly version: number };
  };
  readonly "config.user.get": {
    readonly params: EmptyParams;
    readonly result: { readonly config: RuntimeUserConfig; readonly revision: string };
  };
  readonly "config.user.update": {
    readonly params: {
      readonly defaults: RuntimeUserDefaults;
      readonly expectedRevision: string;
    };
    readonly result: { readonly config: RuntimeUserConfig; readonly revision: string };
  };
  readonly "config.effective.get": {
    readonly params: WorkspaceParams;
    readonly result: { readonly config: RuntimeEffectiveConfig };
  };
  readonly "provider.list": {
    readonly params: EmptyParams;
    readonly result: {
      readonly providers: readonly RuntimeProviderProfile[];
      readonly revision: string;
    };
  };
  readonly "provider.upsert": {
    readonly params: {
      readonly provider: RuntimeProviderInput;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly provider: RuntimeProviderProfile;
      readonly revision: string;
    };
  };
  /**
   * Trusted local-host import used by TUI. The secret is write-only and never
   * appears in the result, events, or persisted user configuration.
   */
  readonly "provider.importEnvironment": {
    readonly params: {
      readonly provider: RuntimeProviderInput;
      readonly defaultModel: string;
      readonly secret: string;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly provider: RuntimeProviderProfile;
      readonly revision: string;
    };
  };
  readonly "provider.delete": {
    readonly params: { readonly providerId: string; readonly expectedRevision: string };
    readonly result: { readonly deleted: true; readonly revision: string };
  };
  readonly "provider.credential.status": {
    readonly params: { readonly providerId: string };
    readonly result: {
      readonly providerId: string;
      readonly status: RuntimeCredentialStatus;
      readonly source: RuntimeCredentialSource;
      readonly storedCredentialPresent: boolean;
      readonly providerFingerprint: string;
    };
  };
  readonly "provider.credential.set": {
    readonly params: {
      readonly providerId: string;
      readonly secret: string;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: "ready";
      readonly source: "config";
      readonly storedCredentialPresent: true;
      readonly providerFingerprint: string;
      readonly revision: string;
    };
  };
  readonly "provider.credential.delete": {
    readonly params: {
      readonly providerId: string;
      readonly expectedRevision: string;
    };
    readonly result: {
      readonly providerId: string;
      readonly status: RuntimeCredentialStatus;
      readonly source: RuntimeCredentialSource;
      readonly storedCredentialPresent: boolean;
      readonly providerFingerprint: string;
      readonly revision: string;
    };
  };
};

export const configParamValidators = {
  "config.get": workspaceParams,
  "config.update": exactParamShape({
    workspacePath: stringParam,
    patch: jsonObjectParam,
    expectedVersion: finiteNumberParam,
  }),
  "config.user.get": noParams,
  "config.user.update": exactParamShape({
    defaults: runtimeUserDefaultsParam,
    expectedRevision: stringParam,
  }),
  "config.effective.get": workspaceParams,
  "provider.list": noParams,
  "provider.upsert": exactParamShape({
    provider: runtimeProviderParam,
    expectedRevision: stringParam,
  }),
  "provider.importEnvironment": exactParamShape({
    provider: runtimeProviderParam,
    defaultModel: stringParam,
    secret: stringParam,
    expectedRevision: stringParam,
  }),
  "provider.delete": exactParamShape({ providerId: stringParam, expectedRevision: stringParam }),
  "provider.credential.status": exactParamShape({ providerId: stringParam }),
  "provider.credential.set": exactParamShape({
    providerId: stringParam,
    secret: stringParam,
    expectedRevision: stringParam,
  }),
  "provider.credential.delete": exactParamShape({
    providerId: stringParam,
    expectedRevision: stringParam,
  }),
} satisfies Readonly<Record<keyof ConfigMethodMap, RuntimeParamValidator>>;

export const configResultValidators = {
  "config.get": exactResultShape({ config: resultJsonObject, version: resultFiniteNumber }),
  "config.update": exactResultShape({ config: resultJsonObject, version: resultFiniteNumber }),
  "config.user.get": exactResultShape({
    config: runtimeUserConfigResult,
    revision: resultString,
  }),
  "config.user.update": exactResultShape({
    config: runtimeUserConfigResult,
    revision: resultString,
  }),
  "config.effective.get": exactResultShape({ config: runtimeEffectiveConfigResult }),
  "provider.list": exactResultShape({
    providers: resultArray(runtimeProviderProfileResult),
    revision: resultString,
  }),
  "provider.upsert": exactResultShape({
    provider: runtimeProviderProfileResult,
    revision: resultString,
  }),
  "provider.importEnvironment": exactResultShape({
    provider: runtimeProviderProfileResult,
    revision: resultString,
  }),
  "provider.delete": exactResultShape({
    deleted: resultOneOf([true]),
    revision: resultString,
  }),
  "provider.credential.status": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    source: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
    providerFingerprint: resultString,
  }),
  "provider.credential.set": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready"]),
    source: resultOneOf(["config"]),
    storedCredentialPresent: resultOneOf([true]),
    providerFingerprint: resultString,
    revision: resultString,
  }),
  "provider.credential.delete": exactResultShape({
    providerId: resultString,
    status: resultOneOf(["ready", "missing", "environment", "unsupported"]),
    source: resultOneOf(["config", "keychain", "environment", "none"]),
    storedCredentialPresent: resultBoolean,
    providerFingerprint: resultString,
    revision: resultString,
  }),
} satisfies Readonly<Record<keyof ConfigMethodMap, RuntimeResultRule>>;
