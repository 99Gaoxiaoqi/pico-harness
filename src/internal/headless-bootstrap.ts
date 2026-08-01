import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigStore,
  type PicoUserConfig,
} from "../input/user-config-store.js";
import { parseModelProviderConfigs, parseModelRouteId } from "../input/pico-config.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";

const SCHEMA_VERSION = 1 as const;
const BENCHMARK_OUTPUT_TOKENS_BY_ROUTE = new Map<string, number>([
  ["codex-oauth/gpt-5.4", 8_192],
  ["codex-oauth/gpt-5.6-terra", 8_192],
]);
const MAX_INPUT_BYTES = 64 * 1024;
const REQUEST_FIELDS = new Set(["schemaVersion", "workspacePath", "picoHome", "route"]);
const ROUTE_FIELDS = new Set(["id", "protocol", "baseURL", "apiKeyEnv", "output"]);
const FORBIDDEN_SECRET_FIELDS =
  /^(?:apiKey|token|accessToken|refreshToken|secret|password|authorization|credentials?)$/iu;
const BENCHMARK_API_KEY_ENV = "PICO_TB_GATEWAY_TOKEN";

export interface HeadlessBootstrapRequestV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly workspacePath: string;
  readonly picoHome: string;
  readonly route: {
    readonly id: string;
    readonly protocol: "openai" | "claude";
    readonly baseURL: string;
    readonly apiKeyEnv: string;
    readonly output?: number;
  };
}

export interface HeadlessBootstrapResultV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly status: "configured" | "invalid_request" | "failed";
  readonly workspacePath: string | null;
  readonly picoHome: string | null;
  readonly modelRouteId: string | null;
  readonly configRevision: string | null;
  readonly error: { readonly code: string; readonly summary: string } | null;
}

export interface HeadlessBootstrapOutcome {
  readonly result: HeadlessBootstrapResultV1;
  readonly exitCode: 0 | 2 | 3;
}

class BootstrapRequestError extends Error {
  constructor(
    readonly code: string,
    readonly summary: string,
  ) {
    super(summary);
    this.name = "BootstrapRequestError";
  }
}

/**
 * Seed one isolated Headless case through the same durable stores used by Pico hosts.
 *
 * The request deliberately cannot carry a credential value. The later Headless process resolves
 * exactly the configured apiKeyEnv from its scoped process environment.
 */
export async function bootstrapHeadlessCaseJson(
  rawInput: string,
): Promise<HeadlessBootstrapOutcome> {
  let request: HeadlessBootstrapRequestV1;
  try {
    if (Buffer.byteLength(rawInput, "utf8") > MAX_INPUT_BYTES) {
      throw new BootstrapRequestError(
        "INPUT_TOO_LARGE",
        "The bootstrap request exceeds the supported size limit.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawInput) as unknown;
    } catch {
      throw new BootstrapRequestError("INVALID_JSON", "The bootstrap request is not valid JSON.");
    }
    assertNoSecretFields(parsed);
    request = parseRequest(parsed);
  } catch (error) {
    return invalidOutcome(asRequestError(error));
  }

  try {
    const { workspacePath, picoHome } = await canonicalizeCasePaths(request);
    await assertEmptyPicoHome(picoHome);
    const store = new UserConfigStore({ picoHome });
    const current = await store.read();
    if (
      current.revision !== EMPTY_USER_CONFIG_REVISION ||
      current.config.defaults !== undefined ||
      Object.keys(current.config.providers).length !== 0
    ) {
      throw new BootstrapRequestError(
        "PICO_HOME_NOT_EMPTY",
        "The bootstrap PICO_HOME must not contain existing user configuration.",
      );
    }

    const { providerId, modelId } = splitRoute(request.route.id);
    const config = buildUserConfig(request, providerId, modelId);
    const written = await store.write(config, { expectedRevision: current.revision });
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(workspacePath);
    if (!(await trustStore.isTrusted(workspacePath))) {
      throw new Error("workspace trust verification failed");
    }

    return {
      result: {
        schemaVersion: SCHEMA_VERSION,
        status: "configured",
        workspacePath,
        picoHome,
        modelRouteId: request.route.id,
        configRevision: written.revision,
        error: null,
      },
      exitCode: 0,
    };
  } catch (error) {
    if (error instanceof BootstrapRequestError) return invalidOutcome(error);
    return {
      result: {
        schemaVersion: SCHEMA_VERSION,
        status: "failed",
        workspacePath: null,
        picoHome: null,
        modelRouteId: null,
        configRevision: null,
        error: {
          code: "BOOTSTRAP_FAILED",
          summary: "The isolated Headless case could not be configured.",
        },
      },
      exitCode: 3,
    };
  }
}

function parseRequest(value: unknown): HeadlessBootstrapRequestV1 {
  if (!isRecord(value)) {
    throw new BootstrapRequestError("INVALID_REQUEST", "The bootstrap request must be an object.");
  }
  assertExactFields(value, REQUEST_FIELDS);
  if (value["schemaVersion"] !== SCHEMA_VERSION) {
    throw new BootstrapRequestError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Only bootstrap schemaVersion 1 is supported.",
    );
  }
  const route = value["route"];
  if (!isRecord(route)) {
    throw new BootstrapRequestError("INVALID_ROUTE", "route must be an object.");
  }
  assertExactFields(route, ROUTE_FIELDS);
  const routeId = requiredString(route["id"], "route.id", 512);
  try {
    parseModelRouteId(routeId, "bootstrap request", "route.id");
  } catch {
    throw new BootstrapRequestError(
      "INVALID_MODEL_ROUTE",
      "route.id must identify one provider/model route.",
    );
  }
  const protocol = route["protocol"];
  if (protocol !== "openai" && protocol !== "claude") {
    throw new BootstrapRequestError("INVALID_PROTOCOL", "route.protocol is unsupported.");
  }
  const baseURL = validateProviderEndpoint(requiredString(route["baseURL"], "route.baseURL", 4096));
  const apiKeyEnv = requiredString(route["apiKeyEnv"], "route.apiKeyEnv", 128);
  if (apiKeyEnv !== BENCHMARK_API_KEY_ENV) {
    throw new BootstrapRequestError(
      "INVALID_CREDENTIAL_ENV",
      `route.apiKeyEnv must equal ${BENCHMARK_API_KEY_ENV}.`,
    );
  }
  const output = parseRouteOutput(routeId, route["output"]);
  return {
    schemaVersion: SCHEMA_VERSION,
    workspacePath: requiredString(value["workspacePath"], "workspacePath", 4096),
    picoHome: requiredString(value["picoHome"], "picoHome", 4096),
    route: {
      id: routeId,
      protocol,
      baseURL,
      apiKeyEnv,
      ...(output === undefined ? {} : { output }),
    },
  };
}

function buildUserConfig(
  request: HeadlessBootstrapRequestV1,
  providerId: string,
  modelId: string,
): PicoUserConfig {
  const benchmarkOutputTokens = BENCHMARK_OUTPUT_TOKENS_BY_ROUTE.get(request.route.id);
  const providers = parseModelProviderConfigs(
    {
      [providerId]: {
        protocol: request.route.protocol,
        baseURL: request.route.baseURL,
        apiKeyEnv: request.route.apiKeyEnv,
        models: [modelId],
        discoverModels: false,
        ...(request.route.output === undefined
          ? {}
          : {
              modelCapabilities: {
                [modelId]: {
                  output: request.route.output,
                  ...(benchmarkOutputTokens !== undefined
                    ? { outputTokenField: "max_completion_tokens" }
                    : {}),
                },
              },
            }),
      },
    },
    "bootstrap request",
  );
  return {
    version: 1,
    defaults: { modelRouteId: request.route.id, mode: "yolo" },
    providers,
  };
}

function parseRouteOutput(routeId: string, value: unknown): number | undefined {
  const benchmarkOutputTokens = BENCHMARK_OUTPUT_TOKENS_BY_ROUTE.get(routeId);
  if (benchmarkOutputTokens !== undefined) {
    if (value !== benchmarkOutputTokens) {
      throw new BootstrapRequestError(
        "INVALID_ROUTE_OUTPUT",
        `route.output must equal ${benchmarkOutputTokens} for ${routeId}.`,
      );
    }
    return benchmarkOutputTokens;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BootstrapRequestError(
      "INVALID_ROUTE_OUTPUT",
      "route.output must be a positive safe integer when provided.",
    );
  }
  return value;
}

async function canonicalizeCasePaths(
  request: HeadlessBootstrapRequestV1,
): Promise<{ workspacePath: string; picoHome: string }> {
  if (!isAbsolute(request.workspacePath) || !isAbsolute(request.picoHome)) {
    throw new BootstrapRequestError(
      "PATH_NOT_ABSOLUTE",
      "workspacePath and picoHome must both be absolute.",
    );
  }
  let workspacePath: string;
  let picoHome: string;
  try {
    [workspacePath, picoHome] = await Promise.all([
      canonicalDirectory(request.workspacePath),
      canonicalDirectory(request.picoHome),
    ]);
  } catch {
    throw new BootstrapRequestError(
      "PATH_INVALID",
      "workspacePath and picoHome must identify physical directories.",
    );
  }
  if (resolve(picoHome) === resolve(resolvePicoHome({ homeDir: homedir(), env: {} }))) {
    throw new BootstrapRequestError(
      "PICO_HOME_NOT_ISOLATED",
      "The default user PICO_HOME is not accepted.",
    );
  }
  if (pathsOverlap(workspacePath, picoHome)) {
    throw new BootstrapRequestError(
      "CASE_PATH_OVERLAP",
      "workspacePath and picoHome must be independent directory trees.",
    );
  }
  return { workspacePath, picoHome };
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a physical directory");
  return canonical;
}

async function assertEmptyPicoHome(picoHome: string): Promise<void> {
  if ((await readdir(picoHome)).length !== 0) {
    throw new BootstrapRequestError(
      "PICO_HOME_NOT_EMPTY",
      "The bootstrap PICO_HOME must be an empty trial directory.",
    );
  }
}

function splitRoute(routeId: string): { providerId: string; modelId: string } {
  const separator = routeId.indexOf("/");
  if (separator <= 0 || separator === routeId.length - 1) {
    throw new BootstrapRequestError(
      "INVALID_MODEL_ROUTE",
      "route.id must identify one provider/model route.",
    );
  }
  return { providerId: routeId.slice(0, separator), modelId: routeId.slice(separator + 1) };
}

function validateProviderEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new BootstrapRequestError("INVALID_BASE_URL", "route.baseURL must be an absolute URL.");
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new BootstrapRequestError(
      "INVALID_BASE_URL",
      "route.baseURL must be a credential-free HTTP(S) endpoint without query or fragment.",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function assertNoSecretFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_FIELDS.test(key) && key !== "apiKeyEnv") {
      throw new BootstrapRequestError(
        "SECRET_FIELD_FORBIDDEN",
        "Credential values are forbidden in bootstrap input.",
      );
    }
    assertNoSecretFields(item);
  }
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new BootstrapRequestError(
      "UNKNOWN_FIELD",
      "The bootstrap request contains unsupported fields.",
    );
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new BootstrapRequestError("INVALID_FIELD", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(relative(left, right)) || isWithin(relative(right, left));
}

function isWithin(relativePath: string): boolean {
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function invalidOutcome(error: BootstrapRequestError): HeadlessBootstrapOutcome {
  return {
    result: {
      schemaVersion: SCHEMA_VERSION,
      status: "invalid_request",
      workspacePath: null,
      picoHome: null,
      modelRouteId: null,
      configRevision: null,
      error: { code: error.code, summary: error.summary },
    },
    exitCode: 2,
  };
}

function asRequestError(error: unknown): BootstrapRequestError {
  return error instanceof BootstrapRequestError
    ? error
    : new BootstrapRequestError("INVALID_REQUEST", "The bootstrap request is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
