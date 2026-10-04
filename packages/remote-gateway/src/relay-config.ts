import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { createRelayIdentity } from "@pico/protocol/relay-crypto";
import { parseRelayEndpoint, type RemoteRelayEndpoint } from "@pico/protocol/relay";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolveCanonicalPicoHome } from "@pico/pico-host/pico-paths";
import { acquireGatewayLock } from "./control.js";
import {
  defaultGatewayHome,
  ensureGatewayHome,
  hashSecret,
  loadGatewayState,
  newSecret,
  readPrivateJson,
  validateGatewayConfig,
  writePrivateJson,
  type GatewayConfig,
  type GatewayWorkspace,
} from "./state.js";

export interface ConfigureRelayGatewayInput {
  readonly relayUrl: string;
  readonly invitation?: string;
  readonly workspaces: readonly { readonly path: string; readonly name?: string }[];
  readonly runtimeHostRootPath?: string;
}
export interface GatewayConfigurationSummary {
  readonly configured: boolean;
  readonly connectionMode?: "direct" | "relay";
  readonly relayUrl?: string;
  readonly workspaces: readonly GatewayWorkspace[];
  readonly gatewayId?: string;
  readonly runtimeHostRootPath?: string;
}
interface RelayIdentityFile {
  readonly version: 1;
  readonly gatewayId: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly registrations: Record<
    string,
    {
      readonly token: string;
      readonly enrolled: boolean;
      readonly invitationHash?: string;
      readonly pending?: { readonly token: string; readonly invitationHash: string };
    }
  >;
}
type RelayGatewayConfig = GatewayConfig & { readonly relay: RemoteRelayEndpoint };
const identityPath = (home: string): string => join(home, "relay-identity.json");
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const KEY = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-zA-Z0-9_-]{32,256}$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function relayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Relay 地址无效");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Relay 地址必须是无凭据的 HTTPS origin");
  return url.origin;
}
function validateIdentity(value: unknown): RelayIdentityFile {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.gatewayId !== "string" ||
    !ID.test(value.gatewayId) ||
    typeof value.publicKey !== "string" ||
    !KEY.test(value.publicKey) ||
    typeof value.secretKey !== "string" ||
    !KEY.test(value.secretKey) ||
    !object(value.registrations)
  )
    throw new Error("Relay 本机身份文件无效");
  if (
    createRelayIdentity(() => Buffer.from(value.secretKey as string, "hex")).publicKey !==
    value.publicKey
  )
    throw new Error("Relay 本机身份密钥不匹配");
  for (const [origin, registration] of Object.entries(value.registrations)) {
    if (
      relayOrigin(origin) !== origin ||
      !object(registration) ||
      typeof registration.token !== "string" ||
      !TOKEN.test(registration.token) ||
      typeof registration.enrolled !== "boolean" ||
      (registration.invitationHash !== undefined &&
        (typeof registration.invitationHash !== "string" || !KEY.test(registration.invitationHash)))
    )
      throw new Error("Relay 本机注册信息无效");
    if (
      registration.pending !== undefined &&
      (!object(registration.pending) ||
        typeof registration.pending.token !== "string" ||
        !TOKEN.test(registration.pending.token) ||
        typeof registration.pending.invitationHash !== "string" ||
        !KEY.test(registration.pending.invitationHash))
    )
      throw new Error("Relay 待确认注册信息无效");
  }
  return value as unknown as RelayIdentityFile;
}
function configRelay(config: GatewayConfig): RemoteRelayEndpoint | undefined {
  const value = (config as GatewayConfig & { relay?: unknown }).relay;
  return value === undefined ? undefined : parseRelayEndpoint(value);
}

/** Local-only read: project only public configuration fields; never return enrollment credentials. */
export async function readGatewayConfiguration(
  home = defaultGatewayHome(),
): Promise<GatewayConfigurationSummary> {
  const config = await readPrivateJson<GatewayConfig>(join(home, "config.json"));
  if (!config) return { configured: false, workspaces: [] };
  validateGatewayConfig(config);
  const relay = configRelay(config);
  return {
    configured: true,
    connectionMode: relay ? "relay" : "direct",
    ...(relay ? { relayUrl: relay.relayUrl, gatewayId: relay.gatewayId } : {}),
    workspaces: config.workspaces.map(({ id, name, path }) => ({ id, name, path })),
    ...(config.runtimeHostRootPath ? { runtimeHostRootPath: config.runtimeHostRootPath } : {}),
  };
}

/** This function is reachable only from the private local management surface. */
export async function configureRelayGateway(
  input: ConfigureRelayGatewayInput,
  home = defaultGatewayHome(),
): Promise<GatewayConfig> {
  const origin = relayOrigin(input.relayUrl);
  if (
    input.invitation !== undefined &&
    (typeof input.invitation !== "string" ||
      input.invitation.length === 0 ||
      input.invitation.length > 4096 ||
      /[\0\r\n]/u.test(input.invitation))
  )
    throw new Error("内测邀请无效");
  if (
    !Array.isArray(input.workspaces) ||
    input.workspaces.length === 0 ||
    input.workspaces.length > 100
  )
    throw new Error("请选择至少一个已注册且信任的项目");
  const directory = await ensureGatewayHome(home);
  const release = await acquireGatewayLock(directory);
  try {
    const runtimeHome = await realpath(input.runtimeHostRootPath ?? resolveCanonicalPicoHome());
    const registered = await new WorkspaceRegistrationStore(
      join(runtimeHome, "daemon-workspaces.json"),
    ).list();
    const trusted = new WorkspaceTrustStore({ userStateDirectory: runtimeHome });
    const previous = await readPrivateJson<GatewayConfig>(join(directory, "config.json"));
    if (previous) validateGatewayConfig(previous);
    const workspaces: GatewayWorkspace[] = [];
    for (const workspace of input.workspaces) {
      if (
        !workspace ||
        typeof workspace.path !== "string" ||
        !workspace.path ||
        workspace.path.length > 4096 ||
        (workspace.name !== undefined &&
          (typeof workspace.name !== "string" ||
            !workspace.name.trim() ||
            workspace.name.length > 512))
      )
        throw new Error("授权项目格式无效");
      const path = await realpath(workspace.path);
      if (!registered.includes(path) || !(await trusted.isTrusted(path)))
        throw new Error("只能授权已在此电脑注册且信任的项目");
      if (workspaces.some((entry) => entry.path === path)) continue;
      const prior = previous?.workspaces.find((entry) => entry.path === path);
      workspaces.push({
        id: prior?.id ?? randomUUID(),
        name: workspace.name?.trim() ?? prior?.name ?? basename(path),
        path,
      });
    }
    const state = await loadGatewayState(directory);
    if (!ID.test(state.gatewayId)) throw new Error("网关身份无效");
    const savedIdentity = await readPrivateJson<unknown>(identityPath(directory));
    const identity: RelayIdentityFile = savedIdentity
      ? validateIdentity(savedIdentity)
      : {
          version: 1,
          gatewayId: state.gatewayId,
          ...createRelayIdentity(randomBytes),
          registrations: {},
        };
    if (identity.gatewayId !== state.gatewayId) throw new Error("Relay 身份与设备授权目录不匹配");
    let registration = identity.registrations[origin];
    const invitationHash = input.invitation ? hashSecret(input.invitation) : undefined;
    if (!registration) registration = { token: newSecret(), enrolled: false };
    const changing = Boolean(
      registration.enrolled && invitationHash && registration.invitationHash !== invitationHash,
    );
    if (!registration.enrolled || changing) {
      if (!input.invitation || !invitationHash)
        throw new Error("此 Relay 首次注册需要一次性内测邀请");
      const candidate = changing
        ? registration.pending?.invitationHash === invitationHash
          ? registration.pending
          : { token: newSecret(), invitationHash }
        : { token: registration.token, invitationHash };
      // Keep an active registration until the server acknowledges the replacement. A pending
      // candidate survives a lost response so retrying never invents a second host token.
      identity.registrations[origin] = changing
        ? { ...registration, pending: candidate }
        : { ...registration, invitationHash };
      await writePrivateJson(identityPath(directory), identity);
      let response: Response;
      try {
        response = await fetch(`${origin}/v1/enroll`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            invitation: input.invitation,
            gatewayId: state.gatewayId,
            tokenHash: hashSecret(candidate.token),
          }),
        });
      } catch {
        throw new Error("Relay 注册连接失败，请核对地址与网络后使用原邀请重试");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Relay 拒绝注册，请核对内测邀请后重试");
      }
      await requireEnrollmentAcknowledgement(response);
      identity.registrations[origin] = { token: candidate.token, invitationHash, enrolled: true };
      await writePrivateJson(identityPath(directory), identity);
    }
    const relay = parseRelayEndpoint({
      mode: "relay",
      relayUrl: origin,
      gatewayId: state.gatewayId,
      hostPublicKey: identity.publicKey,
    });
    const config: RelayGatewayConfig = {
      version: 1,
      publicUrl: origin,
      port: 8443,
      listenHosts: [],
      certificatePath: "",
      privateKeyPath: "",
      workspaces,
      runtimeHostRootPath: runtimeHome,
      relay,
    };
    await writePrivateJson(join(directory, "config.json"), config);
    return config;
  } finally {
    await release();
  }
}

/** Connector-only read. Both gateway identity and the pinned host key must match the selected endpoint. */
export async function loadRelayIdentity(
  home: string,
  endpoint: RemoteRelayEndpoint,
): Promise<{ secretKey: string; token: string }> {
  const relay = parseRelayEndpoint(endpoint);
  const identity = validateIdentity(await readPrivateJson<unknown>(identityPath(home)));
  const registration = identity.registrations[relay.relayUrl];
  if (
    identity.gatewayId !== relay.gatewayId ||
    identity.publicKey !== relay.hostPublicKey ||
    !registration?.enrolled
  )
    throw new Error("Relay 本机身份未注册或与端点不匹配");
  return { secretKey: identity.secretKey, token: registration.token };
}

async function requireEnrollmentAcknowledgement(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Relay 注册确认无效");
  try {
    let bytes = Buffer.alloc(0);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (bytes.length + chunk.value.byteLength > 4096) throw new Error("Relay 注册确认超限");
      bytes = Buffer.concat([bytes, chunk.value]);
    }
    const result: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !object(result) ||
      result.version !== 1 ||
      result.enrolled !== true ||
      Object.keys(result).some((key) => key !== "version" && key !== "enrolled")
    )
      throw new Error("Relay 注册确认无效");
  } catch {
    throw new Error("Relay 注册确认无效，请使用原邀请重试");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
