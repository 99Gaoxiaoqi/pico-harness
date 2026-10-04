import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export class RelayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RelayError";
  }
}
export const secret = (): string => randomBytes(32).toString("base64url");
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const validGatewayId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const validTokenHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const validSecret = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{32,256}$/.test(value);
export const matches = (value: string, hash: string): boolean =>
  validTokenHash(hash) &&
  timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"));
export const isMissing = (error: unknown): boolean =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

async function protectWindowsPath(path: string, directory: boolean): Promise<void> {
  const script = `param([string]$Target,[string]$Kind)
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$item=Get-Item -LiteralPath $Target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RELAY_REPARSE_POINT' }
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
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'RELAY_DACL_NOT_PRIVATE' }`;
  const temporary = `${path}.${randomUUID()}.ps1`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(script);
    await file.close();
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
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function privateHome(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    await safePath(absolute, true);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  await safePath(absolute, true);
  if (process.platform === "win32") await protectWindowsPath(absolute, true);
  else await chmod(absolute, 0o700);
  return realpath(absolute);
}
async function safePath(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new RelayError("UNSAFE_STATE_PATH");
  if (process.platform !== "win32" && stat.uid !== process.getuid?.())
    throw new RelayError("UNSAFE_STATE_OWNER");
}
export async function readPrivate<T>(path: string): Promise<T | undefined> {
  try {
    await safePath(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (process.platform === "win32") await protectWindowsPath(path, false);
  else await chmod(path, 0o600);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new RelayError("INVALID_STATE");
    return JSON.parse(await file.readFile("utf8")) as T;
  } finally {
    await file.close();
  }
}
export async function writePrivate(path: string, value: unknown): Promise<void> {
  try {
    await safePath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (process.platform === "win32") await protectWindowsPath(temporary, false);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
interface Invitation {
  hash: string;
  expiresAt: number;
  gatewayId?: string;
  tokenHash?: string;
}
interface Host {
  gatewayId: string;
  tokenHash: string;
  revokedAt?: number;
}
interface RelayState {
  version: 1;
  invitations: Invitation[];
  hosts: Host[];
}

export class RelayStore {
  private tail = Promise.resolve();
  private constructor(
    readonly home: string,
    private state: RelayState,
  ) {}
  static async create(home: string): Promise<RelayStore> {
    const directory = await privateHome(home);
    const state = (await readPrivate<RelayState>(join(directory, "state.json"))) ?? {
      version: 1,
      invitations: [],
      hosts: [],
    };
    if (
      state.version !== 1 ||
      !Array.isArray(state.invitations) ||
      !Array.isArray(state.hosts) ||
      state.invitations.length > 10_000 ||
      state.hosts.length > 10_000 ||
      state.invitations.some(
        (i) =>
          !validTokenHash(i.hash) ||
          !Number.isSafeInteger(i.expiresAt) ||
          (i.gatewayId === undefined) !== (i.tokenHash === undefined) ||
          (i.gatewayId !== undefined &&
            (!validGatewayId(i.gatewayId) || !validTokenHash(i.tokenHash))),
      ) ||
      state.hosts.some(
        (h) =>
          !validGatewayId(h.gatewayId) ||
          !validTokenHash(h.tokenHash) ||
          (h.revokedAt !== undefined && !Number.isSafeInteger(h.revokedAt)),
      ) ||
      new Set(state.hosts.map((h) => h.gatewayId)).size !== state.hosts.length
    )
      throw new RelayError("INVALID_STATE");
    return new RelayStore(directory, state);
  }
  authenticate(gatewayId: string, token: string): boolean {
    const host = this.state.hosts.find((h) => h.gatewayId === gatewayId);
    return !!host && host.revokedAt === undefined && matches(token, host.tokenHash);
  }
  private mutate<T>(operation: (state: RelayState) => T): Promise<T> {
    const result = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const value = operation(next);
      await writePrivate(join(this.home, "state.json"), next);
      this.state = next;
      return value;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  invite(ttlMs = 10 * 60_000): Promise<{ version: 1; invitation: string; expiresAt: number }> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24 * 60 * 60_000)
      return Promise.reject(new RelayError("INVALID_PARAMS"));
    return this.mutate((state) => {
      const now = Date.now();
      state.invitations = state.invitations.filter(
        (i) => i.gatewayId !== undefined || i.expiresAt > now,
      );
      if (state.invitations.length >= 10_000) throw new RelayError("INVITATION_LIMIT");
      const invitation = secret(),
        expiresAt = now + ttlMs;
      state.invitations.push({ hash: digest(invitation), expiresAt });
      return { version: 1, invitation, expiresAt };
    });
  }
  enroll(
    invitation: string,
    gatewayId: string,
    tokenHash: string,
  ): Promise<{ version: 1; enrolled: true }> {
    return this.mutate((state) => {
      const entry = state.invitations.find((i) => matches(invitation, i.hash));
      if (!entry) throw new RelayError("INVALID_INVITATION");
      const prior = state.hosts.find((h) => h.gatewayId === gatewayId);
      if (entry.gatewayId !== undefined) {
        if (
          entry.gatewayId !== gatewayId ||
          entry.tokenHash !== tokenHash ||
          !prior ||
          prior.tokenHash !== tokenHash ||
          prior.revokedAt !== undefined
        )
          throw new RelayError("INVALID_INVITATION");
        return { version: 1, enrolled: true };
      }
      if (entry.expiresAt <= Date.now() || (prior && prior.revokedAt === undefined))
        throw new RelayError("INVALID_INVITATION");
      if (!prior && state.hosts.length >= 10_000) throw new RelayError("HOST_LIMIT");
      entry.gatewayId = gatewayId;
      entry.tokenHash = tokenHash;
      if (prior) {
        prior.tokenHash = tokenHash;
        delete prior.revokedAt;
      } else state.hosts.push({ gatewayId, tokenHash });
      return { version: 1, enrolled: true };
    });
  }
  async revoke(gatewayId: string): Promise<{ version: 1; revoked: true }> {
    return this.mutate((state) => {
      const host = state.hosts.find((h) => h.gatewayId === gatewayId);
      if (!host) throw new RelayError("HOST_NOT_FOUND");
      host.revokedAt ??= Date.now();
      return { version: 1, revoked: true };
    });
  }
}
