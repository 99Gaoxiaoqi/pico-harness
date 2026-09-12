// Protocol error identities and construction shared by transport and domain boundaries.

export const RUNTIME_ERROR_CODES = {
  INVALID_JSON: "INVALID_JSON",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  INVALID_KIND: "INVALID_KIND",
  INVALID_AUTH: "INVALID_AUTH",
  INVALID_REQUEST: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  CONFLICT: "CONFLICT",
  RESET_REQUIRED: "RESET_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

export class RuntimeProtocolError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string);
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeProtocolError";
    this.code = code;
  }
}

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return (
    typeof value === "string" &&
    (Object.values(RUNTIME_ERROR_CODES) as readonly string[]).includes(value)
  );
}

export function protocolError(code: RuntimeErrorCode, message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(code, message);
}

export function invalidParams(message: string): RuntimeProtocolError {
  return protocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}

export function invalidResult(message: string): RuntimeProtocolError {
  return protocolError(RUNTIME_ERROR_CODES.INVALID_REQUEST, `Runtime 响应不兼容: ${message}`);
}
