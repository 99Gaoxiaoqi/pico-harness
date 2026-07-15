import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ProviderKind } from "./factory.js";
import type { ModelRoute } from "./model-router.js";

const MODEL_ROUTE_CREDENTIAL_REF_PREFIX = "pico-keychain://model-route/";
const MODEL_ROUTE_CREDENTIAL_REF_VERSION = "v1";
const PROVIDER_CREDENTIAL_REF_PREFIX = "pico-keychain://provider/";
const PROVIDER_CREDENTIAL_REF_VERSION = "v2";
const DEFAULT_PROVIDER_CREDENTIAL_SLOT = "api-key";
const KEYCHAIN_SERVICE = "dev.pico.runtime.provider";
const PROVIDER_KINDS = ["openai", "claude", "gemini"] as const satisfies readonly ProviderKind[];

declare const credentialRefBrand: unique symbol;

/** Opaque, non-secret identifier that may safely be persisted in runtime.sqlite. */
export type CredentialRef = string & { readonly [credentialRefBrand]: true };

export interface CredentialVaultCapability {
  available: boolean;
  backend: "macos-keychain" | "unavailable";
  diagnostic: string;
}

export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<string>;
}

export interface CredentialVault extends CredentialResolver {
  capability(): CredentialVaultCapability;
  put(ref: CredentialRef, secret: string): Promise<void>;
  has(ref: CredentialRef): Promise<boolean>;
  delete(ref: CredentialRef): Promise<void>;
}

export class CredentialVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultUnavailableError";
  }
}

export class CredentialNotFoundError extends Error {
  constructor(ref: CredentialRef) {
    super(`系统凭证库中不存在 ${ref}。请先在 TUI 执行 /cron credential import。`);
    this.name = "CredentialNotFoundError";
  }
}

export type CredentialRouteIdentity = Pick<
  ModelRoute,
  "id" | "provider" | "baseURL" | "model" | "apiKeyEnv"
>;

/**
 * Device-level Provider credential identity.
 *
 * Unlike the legacy model-route identity, this intentionally excludes workspace,
 * model and environment-variable names so Desktop and TUI can share one secret.
 */
export interface ProviderCredentialIdentity {
  readonly providerId: string;
  readonly protocol: ProviderKind;
  readonly baseURL: string;
  readonly credentialSlot?: string;
}

export interface ParsedModelRouteCredentialRef {
  readonly ref: CredentialRef;
  readonly modelRouteId: string;
  readonly workspaceFingerprint: string;
  readonly routeFingerprint: string;
}

export interface ParsedProviderCredentialRef {
  readonly ref: CredentialRef;
  readonly providerId: string;
  readonly protocol: ProviderKind;
  readonly credentialSlot: string;
  readonly endpointFingerprint: string;
  readonly identityFingerprint: string;
}

export type ParsedAnyCredentialRef =
  | ({ readonly version: "v1" } & ParsedModelRouteCredentialRef)
  | ({ readonly version: "v2" } & ParsedProviderCredentialRef);

export function credentialRefForModelRoute(
  route: CredentialRouteIdentity,
  workspacePath: string,
): CredentialRef {
  const normalized = route.id.trim();
  if (!/^[^/\s]+\/.+$/u.test(normalized)) {
    throw new Error("credentialRef 只接受 providerID/modelID 路由");
  }
  const workspaceFingerprint = fingerprint(realpathSync(workspacePath));
  const routeFingerprint = fingerprint(
    JSON.stringify([
      normalized,
      route.provider,
      route.baseURL.trim().replace(/\/+$/u, ""),
      route.model.trim(),
      route.apiKeyEnv.trim(),
    ]),
  );
  return `${MODEL_ROUTE_CREDENTIAL_REF_PREFIX}${MODEL_ROUTE_CREDENTIAL_REF_VERSION}/${workspaceFingerprint}/${routeFingerprint}/${encodeURIComponent(normalized)}` as CredentialRef;
}

/** Strict legacy v1 parser retained for Cron and persisted job compatibility. */
export function parseCredentialRef(ref: string): ParsedModelRouteCredentialRef {
  if (!ref.startsWith(MODEL_ROUTE_CREDENTIAL_REF_PREFIX)) {
    throw new Error("不支持的 v1 credentialRef");
  }
  const parts = ref.slice(MODEL_ROUTE_CREDENTIAL_REF_PREFIX.length).split("/");
  if (
    parts.length !== 4 ||
    parts[0] !== MODEL_ROUTE_CREDENTIAL_REF_VERSION ||
    !isFingerprint(parts[1]) ||
    !isFingerprint(parts[2]) ||
    !parts[3]
  ) {
    throw new Error("credentialRef 结构无效");
  }
  const [, workspaceFingerprint, routeFingerprint, encoded] = parts as [
    string,
    string,
    string,
    string,
  ];
  let modelRouteId: string;
  try {
    modelRouteId = decodeURIComponent(encoded);
  } catch {
    throw new Error("credentialRef 编码无效");
  }
  if (!/^[^/\s]+\/.+$/u.test(modelRouteId)) throw new Error("credentialRef 路由无效");
  return { ref: ref as CredentialRef, modelRouteId, workspaceFingerprint, routeFingerprint };
}

/** Create a device-level v2 reference shared by Desktop and TUI. */
export function credentialRefForProvider(identity: ProviderCredentialIdentity): CredentialRef {
  const normalized = normalizeProviderCredentialIdentity(identity);
  const endpointFingerprint = fingerprint(normalized.baseURL);
  const identityFingerprint = fingerprint(
    JSON.stringify([
      normalized.providerId,
      normalized.protocol,
      normalized.baseURL,
      normalized.credentialSlot,
    ]),
  );
  return `${PROVIDER_CREDENTIAL_REF_PREFIX}${PROVIDER_CREDENTIAL_REF_VERSION}/${identityFingerprint}/${endpointFingerprint}/${encodeURIComponent(normalized.providerId)}/${normalized.protocol}/${encodeURIComponent(normalized.credentialSlot)}` as CredentialRef;
}

/** Alias for callers that use create-style credential APIs. */
export const createProviderCredentialRef = credentialRefForProvider;

export function parseProviderCredentialRef(ref: string): ParsedProviderCredentialRef {
  if (!ref.startsWith(PROVIDER_CREDENTIAL_REF_PREFIX)) {
    throw new Error("不支持的 v2 credentialRef");
  }
  const parts = ref.slice(PROVIDER_CREDENTIAL_REF_PREFIX.length).split("/");
  if (
    parts.length !== 6 ||
    parts[0] !== PROVIDER_CREDENTIAL_REF_VERSION ||
    !isFingerprint(parts[1]) ||
    !isFingerprint(parts[2]) ||
    !parts[3] ||
    !isProviderKind(parts[4]) ||
    !parts[5]
  ) {
    throw new Error("Provider credentialRef 结构无效");
  }
  const [, identityFingerprint, endpointFingerprint, encodedProviderId, protocol, encodedSlot] =
    parts as [string, string, string, string, ProviderKind, string];
  const providerId = decodeCredentialComponent(encodedProviderId, "Provider ID");
  const credentialSlot = decodeCredentialComponent(encodedSlot, "credential slot");
  validateProviderId(providerId);
  validateCredentialSlot(credentialSlot);
  return {
    ref: ref as CredentialRef,
    providerId,
    protocol,
    credentialSlot,
    endpointFingerprint,
    identityFingerprint,
  };
}

export function parseAnyCredentialRef(ref: string): ParsedAnyCredentialRef {
  if (ref.startsWith(MODEL_ROUTE_CREDENTIAL_REF_PREFIX)) {
    return { version: "v1", ...parseCredentialRef(ref) };
  }
  if (ref.startsWith(PROVIDER_CREDENTIAL_REF_PREFIX)) {
    return { version: "v2", ...parseProviderCredentialRef(ref) };
  }
  throw new Error("不支持的 credentialRef");
}

export function assertCredentialRefMatchesModelRoute(
  ref: CredentialRef,
  route: CredentialRouteIdentity,
  workspacePath: string,
): void {
  const expected = credentialRefForModelRoute(route, workspacePath);
  if (ref !== expected) {
    throw new Error("credentialRef 与当前工作区或模型路由不匹配，后台执行已阻断");
  }
}

export function assertCredentialRefMatchesProvider(
  ref: CredentialRef,
  identity: ProviderCredentialIdentity,
): void {
  const expected = credentialRefForProvider(identity);
  if (ref !== expected) {
    throw new Error(
      "credentialRef 与当前 Provider ID、协议、Endpoint 或 credential slot 不匹配，凭证读取已阻断",
    );
  }
}

export async function importProviderCredential(input: {
  readonly provider: ProviderCredentialIdentity;
  readonly secret: string;
  readonly vault: CredentialVault;
}): Promise<CredentialRef> {
  validateSecret(input.secret);
  const ref = credentialRefForProvider(input.provider);
  await input.vault.put(ref, input.secret);
  return ref;
}

export async function importModelRouteCredential(input: {
  route: ModelRoute;
  workspacePath: string;
  vault: CredentialVault;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<CredentialRef> {
  if (input.route.source === "legacy") {
    throw new Error(
      "持久 Cron 不支持仅由 shell 环境提供的 legacy 路由；请先在 .pico/config.json 配置 provider。",
    );
  }
  const raw = (input.env ?? process.env)[input.route.apiKeyEnv]?.trim();
  const secret = raw
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (!secret) throw new Error(`缺少凭证环境变量 ${input.route.apiKeyEnv}，无法导入。`);
  const ref = credentialRefForModelRoute(input.route, input.workspacePath);
  await input.vault.put(ref, secret);
  return ref;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical form used by the v2 endpoint binding. */
export function normalizeProviderEndpoint(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) throw new Error("Provider Endpoint 不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Provider Endpoint 必须是有效 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Provider Endpoint 仅支持 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Provider Endpoint 不得包含用户名或密码");
  }
  parsed.hash = "";
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

function normalizeProviderCredentialIdentity(identity: ProviderCredentialIdentity): {
  providerId: string;
  protocol: ProviderKind;
  baseURL: string;
  credentialSlot: string;
} {
  const providerId = identity.providerId.trim();
  const credentialSlot = (identity.credentialSlot ?? DEFAULT_PROVIDER_CREDENTIAL_SLOT).trim();
  validateProviderId(providerId);
  if (!isProviderKind(identity.protocol)) throw new Error("Provider protocol 无效");
  validateCredentialSlot(credentialSlot);
  return {
    providerId,
    protocol: identity.protocol,
    baseURL: normalizeProviderEndpoint(identity.baseURL),
    credentialSlot,
  };
}

function validateProviderId(providerId: string): void {
  if (!/^[^/\s]+$/u.test(providerId)) {
    throw new Error("Provider ID 不能为空、包含空白或斜杠");
  }
}

function validateCredentialSlot(slot: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(slot)) {
    throw new Error("credential slot 只能包含字母、数字、点、下划线、冒号或连字符");
  }
}

function decodeCredentialComponent(encoded: string, label: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error(`${label} 编码无效`);
  }
}

function isProviderKind(value: string | undefined): value is ProviderKind {
  return PROVIDER_KINDS.some((candidate) => candidate === value);
}

function validateSecret(secret: string): void {
  if (!secret.trim() || /[\r\n]/u.test(secret)) {
    throw new Error("拒绝保存空白或包含换行的 Provider 凭证");
  }
}

function isFingerprint(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function createPlatformCredentialVault(
  platform: NodeJS.Platform = process.platform,
): CredentialVault {
  if (platform === "darwin") return new MacOsKeychainCredentialVault();
  return new UnavailableCredentialVault(
    `${platform} 尚未提供经过验证的系统凭证库适配；后台 Provider 凭证已按 fail-closed 禁用。`,
  );
}

interface SecurityCommandRunner {
  run(args: readonly string[], stdin?: string): Promise<string>;
}

export class MacOsKeychainCredentialVault implements CredentialVault {
  constructor(private readonly runner: SecurityCommandRunner = new MacSecurityCommandRunner()) {}

  capability(): CredentialVaultCapability {
    return {
      available: true,
      backend: "macos-keychain",
      diagnostic: "Provider 凭证由当前 macOS 用户的 Login Keychain 保存。",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    parseAnyCredentialRef(ref);
    validateSecret(secret);
    // `-w` intentionally remains last: security then reads the password from stdin,
    // keeping the secret out of argv, process listings, transcripts and shell history.
    await this.runner.run(
      ["add-generic-password", "-U", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w"],
      `${secret}\n${secret}\n`,
    );
  }

  async resolve(ref: CredentialRef): Promise<string> {
    parseAnyCredentialRef(ref);
    try {
      const secret = await this.runner.run([
        "find-generic-password",
        "-a",
        ref,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const normalized = secret.replace(/\r?\n$/u, "");
      if (!normalized) throw new CredentialNotFoundError(ref);
      return normalized;
    } catch (error) {
      if (error instanceof CredentialNotFoundError) throw error;
      if (isMacKeychainItemNotFound(error)) throw new CredentialNotFoundError(ref);
      throw error;
    }
  }

  async has(ref: CredentialRef): Promise<boolean> {
    parseAnyCredentialRef(ref);
    try {
      // Deliberately omit `-w`: status/list operations must not read plaintext credentials
      // into daemon memory merely to determine whether a Keychain item exists.
      await this.runner.run(["find-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
      return true;
    } catch (error) {
      if (isMacKeychainItemNotFound(error)) return false;
      throw error;
    }
  }

  async delete(ref: CredentialRef): Promise<void> {
    parseAnyCredentialRef(ref);
    await this.runner.run(["delete-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
  }
}

class UnavailableCredentialVault implements CredentialVault {
  constructor(private readonly diagnostic: string) {}

  capability(): CredentialVaultCapability {
    return { available: false, backend: "unavailable", diagnostic: this.diagnostic };
  }

  async put(): Promise<void> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async resolve(): Promise<string> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async has(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<void> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }
}

class MacSecurityCommandRunner implements SecurityCommandRunner {
  run(args: readonly string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/security", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error("无法连接 macOS Keychain 命令的标准流"));
        child.kill();
        return;
      }
      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      let stdout = "";
      let stderr = "";
      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => (stdout += chunk));
      childStderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new MacSecurityCommandError(code, stderr));
      });
      childStdin.end(stdin);
    });
  }
}

class MacSecurityCommandError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`macOS Keychain 命令失败（exit ${exitCode ?? "unknown"}）：${stderr.trim()}`);
    this.name = "MacSecurityCommandError";
  }
}

function isMacKeychainItemNotFound(error: unknown): boolean {
  if (error instanceof MacSecurityCommandError && error.exitCode === 44) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:-25300|could not be found|item[^\n]*not found)/iu.test(message);
}
