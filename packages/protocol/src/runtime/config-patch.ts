// Trusted Host public-patch contracts, shared by local and remote adapters.
import { isJsonObject } from "./base.js";
import type { JsonObject } from "./base.js";
import { invalidParams } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  boundedNonEmptyStringParam,
  oneOfParam,
  positiveIntegerParam,
  stringArrayParam,
  stringRecordParam,
} from "./validation.js";
import type { RuntimeParamRule } from "./validation.js";

export type RuntimeSecretEdit =
  | { readonly action: "keep" | "remove" }
  | { readonly action: "set"; readonly value: string };
export type RuntimeSecretEdits = {
  readonly env?: Readonly<Record<string, RuntimeSecretEdit>>;
  readonly headers?: Readonly<Record<string, RuntimeSecretEdit>>;
  readonly url?: RuntimeSecretEdit;
};
export type RuntimeMcpServerPublicPatch = JsonObject & {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
  readonly desktopExecution?: boolean;
} & (
    | {
        readonly transport: "stdio";
        readonly command?: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
      }
    | {
        readonly transport: "http" | "sse";
        readonly url?: string;
        readonly headers?: Readonly<Record<string, string>>;
      }
  );

const secretEditParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidParams(`${path} 必须是秘密编辑对象`);
  const set = value.action === "set";
  assertNestedShape(
    value,
    path,
    { action: oneOfParam(["keep", "remove", "set"]) },
    set
      ? {
          value: (input, label) => {
            if (typeof input !== "string" || input.length > 16384)
              throw invalidParams(`${label} 必须是长度不超过 16384 的字符串`);
          },
        }
      : {},
  );
  if (set && typeof value.value !== "string") throw invalidParams(`${path} 缺少秘密值`);
};
const secretRecordParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value) || Object.keys(value).length > 128)
    throw invalidParams(`${path} 秘密编辑格式无效`);
  for (const [key, edit] of Object.entries(value)) {
    if (!key || key.length > 512 || ["__proto__", "constructor", "prototype"].includes(key))
      throw invalidParams(`${path} 秘密字段名称无效`);
    secretEditParam(edit, `${path} 秘密字段`);
  }
};
export const runtimeSecretEditsParam: RuntimeParamRule = (value, path) =>
  assertNestedShape(
    value,
    path,
    {},
    { env: secretRecordParam, headers: secretRecordParam, url: secretEditParam },
  );

export const runtimeMcpServerPublicPatchParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidParams(`${path} 必须是 MCP server 对象`);
  const common = {
    startupTimeoutMs: positiveIntegerParam,
    toolTimeoutMs: positiveIntegerParam,
    enabled: booleanParam,
    desktopExecution: booleanParam,
  };
  if (value.transport === "stdio") {
    assertNestedShape(
      value,
      path,
      { name: boundedNonEmptyStringParam(256), transport: oneOfParam(["stdio"]) },
      {
        ...common,
        command: boundedNonEmptyStringParam(8192),
        args: stringArrayParam,
        env: stringRecordParam,
      },
    );
  } else {
    assertNestedShape(
      value,
      path,
      { name: boundedNonEmptyStringParam(256), transport: oneOfParam(["http", "sse"]) },
      { ...common, url: boundedNonEmptyStringParam(8192), headers: stringRecordParam },
    );
  }
};
