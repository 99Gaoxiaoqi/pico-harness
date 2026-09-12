// Shared primitive and shape rules; method-specific contracts belong to their domains.
import { isJsonObject, isJsonValue } from "./base.js";
import { invalidParams, invalidResult } from "./errors.js";

export type RuntimeParamRule = (value: unknown, path: string) => void;

type RuntimeParamShape = Readonly<Record<string, RuntimeParamRule>>;

export type RuntimeParamValidator = (value: Record<string, unknown>) => void;

export const stringParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "string") throw invalidParams(`${path} 必须是字符串`);
};

export const booleanParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "boolean") throw invalidParams(`${path} 必须是布尔值`);
};

export const finiteNumberParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidParams(`${path} 必须是有限数字`);
  }
};

export const positiveIntegerParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`${path} 必须是正安全整数`);
  }
};

export const nonNegativeIntegerParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParams(`${path} 必须是非负安全整数`);
  }
};

export const confidenceParam: RuntimeParamRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidParams(`${path} 必须是 0 到 1 之间的有限数字`);
  }
};

export function boundedNonEmptyStringParam(maxLength: number): RuntimeParamRule {
  return (value, path) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw invalidParams(`${path} 必须是长度 1-${maxLength} 的非空字符串`);
    }
  };
}

export function nullableParam(rule: RuntimeParamRule): RuntimeParamRule {
  return (value, path) => {
    if (value !== null) rule(value, path);
  };
}

export function enumArrayParam<const Values extends readonly string[]>(
  values: Values,
): RuntimeParamRule {
  const allowed = new Set(values);
  return (value, path) => {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && allowed.has(item))
    ) {
      throw invalidParams(`${path} 必须是 ${values.join(" | ")} 组成的数组`);
    }
  };
}

export const jsonObjectParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw invalidParams(`${path} 必须是 JSON 对象`);
  }
};

export const jsonValueParam: RuntimeParamRule = (value, path) => {
  if (!isJsonValue(value)) throw invalidParams(`${path} 必须是 JSON 值`);
};

export const stringArrayParam: RuntimeParamRule = (value, path) => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidParams(`${path} 必须是字符串数组`);
  }
};

export const stringRecordParam: RuntimeParamRule = (value, path) => {
  if (
    !isJsonObject(value) ||
    !Object.entries(value).every(
      ([key, item]) => key.length > 0 && key.length <= 512 && typeof item === "string",
    )
  ) {
    throw invalidParams(`${path} 必须是字符串键值对象`);
  }
};

export function oneOfParam<const Values extends readonly string[]>(
  values: Values,
): RuntimeParamRule {
  const allowed = new Set<string>(values);
  return (value, path) => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw invalidParams(`${path} 必须是 ${values.join(" | ")} 之一`);
    }
  };
}

export function exactParamShape(
  required: RuntimeParamShape,
  optional: RuntimeParamShape = {},
): RuntimeParamValidator {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return (value) => {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw invalidParams(`params 不允许字段 ${key}`);
    }
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) throw invalidParams(`params.${key} 为必填字段`);
      rule(value[key], `params.${key}`);
    }
    for (const [key, rule] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) rule(value[key], `params.${key}`);
    }
  };
}

export function assertNestedShape(
  value: unknown,
  path: string,
  required: RuntimeParamShape,
  optional: RuntimeParamShape = {},
): void {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw invalidParams(`${path} 必须是 JSON 对象`);
  }
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidParams(`${path} 不允许字段 ${key}`);
  }
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) throw invalidParams(`${path}.${key} 为必填字段`);
    rule(value[key], `${path}.${key}`);
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.hasOwn(value, key)) rule(value[key], `${path}.${key}`);
  }
}

export const interactionModeParam = oneOfParam(["ask", "plan", "auto", "full-access"] as const);

export const collaborationModeParam = oneOfParam(["agent", "plan"] as const);

export const orchestrationModeParam = oneOfParam(["default", "graph", "swarm"] as const);

export const permissionModeParam = oneOfParam(["ask", "auto", "full-access"] as const);

export const providerProtocolParam = oneOfParam(["openai", "claude", "responses"] as const);

export const noParams = exactParamShape({});

export const workspaceParams = exactParamShape({ workspacePath: stringParam });

export const workspaceSessionParams = exactParamShape({
  workspacePath: stringParam,
  sessionId: stringParam,
});

export const workspaceRunParams = exactParamShape({
  workspacePath: stringParam,
  runId: stringParam,
});

export const workspaceJobParams = exactParamShape({
  workspacePath: stringParam,
  jobId: stringParam,
});

export type RuntimeResultRule = (value: unknown, path: string) => void;

type RuntimeResultShape = Readonly<Record<string, RuntimeResultRule>>;

export const resultString: RuntimeResultRule = (value, path) => {
  if (typeof value !== "string") throw invalidResult(`${path} 必须是字符串`);
};

export const resultNonEmptyString: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  if ((value as string).length === 0) throw invalidResult(`${path} 不能为空`);
};

export const resultBoundedString =
  (maxBytes: number): RuntimeResultRule =>
  (value, path) => {
    resultString(value, path);
    if (new TextEncoder().encode(value as string).byteLength > maxBytes) {
      throw invalidResult(`${path} 超过 ${maxBytes} UTF-8 字节上限`);
    }
  };

export const resultBoolean: RuntimeResultRule = (value, path) => {
  if (typeof value !== "boolean") throw invalidResult(`${path} 必须是布尔值`);
};

export const resultFiniteNumber: RuntimeResultRule = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidResult(`${path} 必须是有限数字`);
  }
};

export const resultNonNegativeNumber: RuntimeResultRule = (value, path) => {
  resultFiniteNumber(value, path);
  if ((value as number) < 0) throw invalidResult(`${path} 不能为负数`);
};

export const resultNonNegativeInteger: RuntimeResultRule = (value, path) => {
  resultNonNegativeNumber(value, path);
  if (!Number.isSafeInteger(value)) throw invalidResult(`${path} 必须是安全整数`);
};

export const resultPositiveInteger: RuntimeResultRule = (value, path) => {
  resultNonNegativeInteger(value, path);
  if ((value as number) < 1) throw invalidResult(`${path} 必须是正整数`);
};

export const resultJsonObject: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 JSON 对象`);
};

export const resultStringArray = resultArray(resultString);

export function resultOneOf<const Values extends readonly (boolean | number | string)[]>(
  values: Values,
): RuntimeResultRule {
  const allowed = new Set<boolean | number | string>(values);
  return (value, path) => {
    if (
      (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") ||
      !allowed.has(value)
    ) {
      throw invalidResult(`${path} 必须是 ${values.join(" | ")} 之一`);
    }
  };
}

export function resultArray(itemRule: RuntimeResultRule): RuntimeResultRule {
  return (value, path) => {
    if (!Array.isArray(value)) throw invalidResult(`${path} 必须是数组`);
    value.forEach((item, index) => itemRule(item, `${path}[${index}]`));
  };
}

export function resultShape(
  required: RuntimeResultShape,
  optional: RuntimeResultShape = {},
): RuntimeResultRule {
  return (value, path) => {
    if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 JSON 对象`);
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) throw invalidResult(`${path}.${key} 为必填字段`);
      rule(value[key], `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) rule(value[key], `${path}.${key}`);
    }
  };
}

export function exactResultShape(
  required: RuntimeResultShape,
  optional: RuntimeResultShape = {},
): RuntimeResultRule {
  const validate = resultShape(required, optional);
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  return (value, path) => {
    validate(value, path);
    if (!isJsonObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw invalidResult(`${path} 不允许字段 ${key}`);
    }
  };
}

export function resultNullable(rule: RuntimeResultRule): RuntimeResultRule {
  return (value, path) => {
    if (value !== null) rule(value, path);
  };
}
