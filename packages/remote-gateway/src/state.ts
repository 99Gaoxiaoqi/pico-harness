import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRelayEndpoint } from "@pico/protocol/relay";
import type { RemotePermission } from "@pico/protocol/remote";

export interface GatewayWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface GatewayConfig {
  readonly relay?: import("@pico/protocol/relay").RemoteRelayEndpoint;
  readonly version: 1;
  readonly publicUrl: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly listenHosts: readonly string[];
  readonly workspaces: readonly GatewayWorkspace[];
  readonly runtimeHostRootPath?: string;
}
export interface GatewayDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly permissions: readonly RemotePermission[];
  readonly workspaceIds: readonly string[];
  readonly createdAt: number;
  pairedAt?: number;
  lastConnectedAt?: number;
  revokedAt?: number;
}
export interface GatewayState {
  readonly version: 1;
  readonly gatewayId: string;
  readonly devices: GatewayDevice[];
}
export const defaultGatewayHome = (): string => join(homedir(), ".pico-remote");
export const newSecret = (): string => randomBytes(32).toString("base64url");
export const hashSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");
export const secretMatches = (secret: string, hash: string): boolean => {
  const candidate = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};
export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Windows ACL is explicit, protected and verified. chmod alone does not establish privacy. */
async function protectWindowsPath(path: string, directory: boolean): Promise<void> {
  const script = `param([string]$Target,[string]$Kind)
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$item=Get-Item -LiteralPath $Target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REMOTE_REPARSE_POINT' }
if ($Kind -eq 'directory') { $acl=[Security.AccessControl.DirectorySecurity]::new() } else { $acl=[Security.AccessControl.FileSecurity]::new() }
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]::None
if ($Kind -eq 'directory') { $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Target -AclObject $acl
$actual=Get-Acl -LiteralPath $Target
$rules=$actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'REMOTE_DACL_NOT_PRIVATE' }`;
  // No shell interpolation of paths: PowerShell receives named arguments via a temporary script.
  const temporary = join(dirname(path), `.acl-${randomUUID()}.ps1`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(script, "utf8");
    await handle.close();
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        temporary,
        "-Target",
        path,
        "-Kind",
        directory ? "directory" : "file",
      ],
      { windowsHide: true, timeout: 15_000 },
    );
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
export async function assertSafePath(path: string, directory = false): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (!directory && stat.nlink !== 1) ||
      !(directory ? stat.isDirectory() : stat.isFile())
    )
      throw new Error("远程网关拒绝符号链接或无效文件类型");
    if (process.platform !== "win32" && stat.uid !== process.getuid?.())
      throw new Error("远程网关状态目录不属于当前用户");
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
export async function ensureGatewayHome(home: string): Promise<string> {
  const absolute = resolve(home);
  if (!(await assertSafePath(absolute, true)))
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  await assertSafePath(absolute, true);
  if (process.platform === "win32") await protectWindowsPath(absolute, true);
  else await chmod(absolute, 0o700);
  return realpath(absolute);
}
export async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  if (!(await assertSafePath(path))) return undefined;
  if (process.platform === "win32") await protectWindowsPath(path, false);
  else await chmod(path, 0o600);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("远程网关状态文件无效或过大");
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally {
    await handle.close();
  }
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await assertSafePath(path);
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (process.platform === "win32") await protectWindowsPath(temporary, false);
    await assertSafePath(path);
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}
export function validateGatewayConfig(value: GatewayConfig): GatewayConfig {
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
    throw new Error("网关配置版本或端口无效");
  const url = new URL(value.publicUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("公网地址必须是无凭据的 HTTPS origin");
  if (
    (!value.relay && !value.listenHosts.length) ||
    !value.workspaces.length ||
    new Set(value.workspaces.map((w) => w.id)).size !== value.workspaces.length
  )
    throw new Error("必须设置监听与唯一授权工作区");
  for (const workspace of value.workspaces)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspace.id) || !workspace.name || !workspace.path)
      throw new Error("授权工作区无效");
  if (value.relay) {
    const relay = parseRelayEndpoint(value.relay);
    if (relay.relayUrl !== url.origin) throw new Error("中继地址与公开地址不一致");
  } else if (!value.certificatePath || !value.privateKeyPath) throw new Error("需要可信 TLS 证书与私钥");
  return value;
}
export async function loadGatewayState(home: string): Promise<GatewayState> {
  const state = await readPrivateJson<GatewayState>(join(home, "devices.json"));
  if (state) {
    if (state.version !== 1 || typeof state.gatewayId !== "string" || !Array.isArray(state.devices))
      throw new Error("网关设备状态格式无效");
    for (const device of state.devices)
      if (
        !device.id ||
        typeof device.name !== "string" ||
        !/^[a-f0-9]{64}$/.test(device.tokenHash) ||
        !Array.isArray(device.permissions) ||
        !Array.isArray(device.workspaceIds)
      )
        throw new Error("网关设备状态格式无效");
    for (const device of state.devices)
      if (device.pairedAt === undefined && !device.revokedAt) device.revokedAt = Date.now();
    return state;
  }
  const fresh: GatewayState = { version: 1, gatewayId: randomUUID(), devices: [] };
  await writePrivateJson(join(home, "devices.json"), fresh);
  return fresh;
}
export async function loadGatewayConfig(home: string): Promise<GatewayConfig> {
  const config = await readPrivateJson<GatewayConfig>(join(home, "config.json"));
  if (!config) throw new Error("请先运行 pico remote configure");
  return validateGatewayConfig(config);
}
export async function readTlsFile(path: string): Promise<Buffer> {
  if (!(await assertSafePath(path))) throw new Error("TLS 文件不存在");
  return readFile(path);
}
