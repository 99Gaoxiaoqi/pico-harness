import { isJsonObject, type EmptyParams, type JsonObject } from "./base.js";
import { invalidParams, invalidResult } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  exactParamShape,
  exactResultShape,
  noParams,
  oneOfParam,
  resultArray,
  resultBoolean,
  resultNonEmptyString,
  resultOneOf,
  resultString,
  stringParam,
  type RuntimeParamRule,
  type RuntimeParamValidator,
  type RuntimeResultRule,
} from "./validation.js";

/** Stable model presets; capability definitions and credentials remain Host-owned. */
export const SUBAGENT_PROFILES = ["local_read", "web_research", "implementation"] as const;
export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];
export const SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export const MAX_SUBAGENT_PRESETS = 64;
export const SUBAGENT_PRESET_ID_MAX_CHARS = 128;
export const SUBAGENT_PRESET_NAME_MAX_CHARS = 128;
export const SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1000;

export type RuntimeSubagentPreset = JsonObject & {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly profile: SubagentProfile;
  /** Pico Provider ID is the stable counterpart of Maka's connection slug. */
  readonly connectionSlug: string;
  readonly model: string;
  /** Absent means model default, not the parent's thinking level. */
  readonly thinkingLevel?: SubagentThinkingLevel;
  readonly enabled: boolean;
};

export type RuntimeSubagentAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: string };

export type RuntimeConfiguredSubagent = RuntimeSubagentPreset & {
  readonly availability: RuntimeSubagentAvailability;
};

export type RuntimeSubagentConnection = JsonObject & {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly retired?: boolean;
  readonly models: readonly {
    readonly id: string;
    readonly thinkingLevels: readonly SubagentThinkingLevel[];
    readonly offerable: boolean;
  }[];
};

export type RuntimeSubagentSettingsSnapshot = {
  readonly presets: readonly RuntimeConfiguredSubagent[];
  readonly connections: readonly RuntimeSubagentConnection[];
  readonly revision: string;
};

export function isSafeSubagentPresetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SUBAGENT_PRESET_ID_MAX_CHARS &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export type SubagentsMethodMap = {
  "subagents.get": {
    readonly params: EmptyParams;
    readonly result: RuntimeSubagentSettingsSnapshot;
  };
  "subagents.update": {
    readonly params: JsonObject & {
      readonly presets: readonly RuntimeSubagentPreset[];
      readonly expectedRevision: string;
    };
    readonly result: RuntimeSubagentSettingsSnapshot;
  };
};

const presetParam: RuntimeParamRule = (value, path) => {
  assertNestedShape(
    value,
    path,
    {
      id: stringParam,
      name: stringParam,
      description: stringParam,
      profile: oneOfParam(SUBAGENT_PROFILES),
      connectionSlug: stringParam,
      model: stringParam,
      enabled: booleanParam,
    },
    { thinkingLevel: oneOfParam(SUBAGENT_THINKING_LEVELS) },
  );
};

const presetsParam: RuntimeParamRule = (value, path) => {
  if (!Array.isArray(value)) throw invalidParams(`${path} 必须是预设数组`);
  value.forEach((preset, index) => presetParam(preset, `${path}[${index}]`));
};

const revisionParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidParams(`${path} 必须是配置版本令牌`);
  }
};

export const subagentsParamValidators = {
  "subagents.get": noParams,
  "subagents.update": exactParamShape({ presets: presetsParam, expectedRevision: revisionParam }),
} satisfies Readonly<Record<keyof SubagentsMethodMap, RuntimeParamValidator>>;

const availabilityResult: RuntimeResultRule = (value, path) => {
  if (isJsonObject(value) && value["status"] === "available") {
    exactResultShape({ status: resultOneOf(["available"]) })(value, path);
  } else {
    exactResultShape({ status: resultOneOf(["unavailable"]), reason: resultNonEmptyString })(
      value,
      path,
    );
  }
};

const presetResult = exactResultShape(
  {
    id: resultNonEmptyString,
    name: resultNonEmptyString,
    description: resultString,
    profile: resultOneOf(SUBAGENT_PROFILES),
    connectionSlug: resultNonEmptyString,
    model: resultNonEmptyString,
    enabled: resultBoolean,
    availability: availabilityResult,
  },
  { thinkingLevel: resultOneOf(SUBAGENT_THINKING_LEVELS) },
);

const connectionResult = exactResultShape(
  {
    id: resultNonEmptyString,
    name: resultString,
    enabled: resultBoolean,
    models: resultArray(
      exactResultShape({
        id: resultNonEmptyString,
        thinkingLevels: resultArray(resultOneOf(SUBAGENT_THINKING_LEVELS)),
        offerable: resultBoolean,
      }),
    ),
  },
  { retired: resultBoolean },
);

const snapshotResult = exactResultShape({
  presets: resultArray(presetResult),
  connections: resultArray(connectionResult),
  revision: resultNonEmptyString,
});

export const subagentsResultValidators = {
  "subagents.get": snapshotResult,
  "subagents.update": snapshotResult,
} satisfies Readonly<Record<keyof SubagentsMethodMap, RuntimeResultRule>>;

export const subagentPresetIdParam: RuntimeParamRule = (value, path) => {
  if (!isSafeSubagentPresetId(value)) throw invalidParams(`${path} 必须是有效的子代理预设 ID`);
};

export const subagentPresetIdResult: RuntimeResultRule = (value, path) => {
  if (!isSafeSubagentPresetId(value)) throw invalidResult(`${path} 必须是有效的子代理预设 ID`);
};
