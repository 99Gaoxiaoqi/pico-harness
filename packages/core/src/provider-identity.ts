import { createHash } from "node:crypto";

/** Stable protocol family used to select a Provider adapter. */
export type ProviderKind = "openai" | "claude" | "responses";

declare const credentialRefBrand: unique symbol;

/**
 * Opaque, non-secret credential identifier. It is safe for durable Runtime
 * facts; only a Host credential-vault adapter may resolve its plaintext.
 */
export type CredentialRef = string & { readonly [credentialRefBrand]: true };

const PROVIDER_CREDENTIAL_REF_PREFIX = "pico-keychain://provider/";
const PROVIDER_CREDENTIAL_REF_VERSION = "v2";
const DEFAULT_PROVIDER_CREDENTIAL_SLOT = "api-key";
const PROVIDER_KINDS = ["openai", "claude", "responses"] as const satisfies readonly ProviderKind[];

/** Device-level identity; excludes workspace, model and environment-variable names. */
export interface ProviderCredentialIdentity {
  readonly providerId: string;
  readonly protocol: ProviderKind;
  readonly baseURL: string;
  readonly credentialSlot?: string;
}

export interface ParsedProviderCredentialRef {
  readonly ref: CredentialRef;
  readonly providerId: string;
  readonly protocol: ProviderKind;
  readonly credentialSlot: string;
  readonly endpointFingerprint: string;
  readonly identityFingerprint: string;
}

/** Create a non-secret device-level v2 reference shared by every Host entrypoint. */
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

export function assertCredentialRefMatchesProvider(
  ref: CredentialRef,
  identity: ProviderCredentialIdentity,
): void {
  if (ref !== credentialRefForProvider(identity)) {
    throw new Error(
      "credentialRef 与当前 Provider ID、协议、Endpoint 或 credential slot 不匹配，凭证读取已阻断",
    );
  }
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

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function isFingerprint(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
