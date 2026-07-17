import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, toNamespacedPath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_HELPER_TIMEOUT_MS = 30_000;
const WINDOWS_HELPER_MAX_BYTES = 256 * 1024;
const WINDOWS_BACKUP_PREFIX = ".pico-write-backup-";
const WINDOWS_PROBE_PREFIX = ".pico-metadata-probe-";

export interface WindowsFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface WindowsAtomicPublishInput {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly temporaryIdentity: WindowsFileIdentity;
  readonly existingIdentity?: WindowsFileIdentity;
}

export interface WindowsAtomicPublishResult {
  readonly published: true;
}

export class WindowsAtomicPublicationError extends Error {
  readonly published: boolean;
  readonly preserveTemporary: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      readonly published: boolean;
      readonly preserveTemporary?: boolean;
    },
  ) {
    const causeMessage = options.cause instanceof Error ? options.cause.message.trim() : "";
    super(causeMessage.length > 0 ? `${message}; ${causeMessage}` : message, options);
    this.name = "WindowsAtomicPublicationError";
    this.published = options.published;
    this.preserveTemporary = options.preserveTemporary ?? false;
  }
}

interface TrustedWindowsPowerShell {
  readonly command: string;
  readonly system32: string;
  readonly systemRoot: string;
}

type WindowsHelperOperation =
  | "assert-private"
  | "compare-access"
  | "create-private"
  | "publish-existing"
  | "publish-new"
  | "restore-private";

const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Convert-PicoExtendedPath([string] $Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw [ArgumentException]::new('PICO_PATH_NOT_ABSOLUTE')
  }
  if ($Path.StartsWith('\\?\')) { return $Path }
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.StartsWith('\\')) { return '\\?\UNC\' + $full.Substring(2) }
  return '\\?\' + $full
}

function New-PicoPrivateSecurity {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $sid) { throw [Security.SecurityException]::new('PICO_CURRENT_SID_MISSING') }
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void] $security.AddAccessRule($rule)
  return $security
}

function Set-PicoPrivate([string] $Path) {
  [IO.File]::SetAccessControl($Path, (New-PicoPrivateSecurity))
}

function Set-PicoInheritedAccess([string] $Path) {
  $sections = [Security.AccessControl.AccessControlSections]::Access
  $security = [IO.File]::GetAccessControl($Path, $sections)
  $explicitRules = @(
    $security.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])
  )
  foreach ($rule in $explicitRules) {
    [void] $security.RemoveAccessRuleSpecific($rule)
  }
  $security.SetAccessRuleProtection($false, $false)
  [IO.File]::SetAccessControl($Path, $security)
}

function Assert-PicoPrivate([string] $Path) {
  $sections = [Security.AccessControl.AccessControlSections]::Access
  $security = [IO.File]::GetAccessControl($Path, $sections)
  if (-not $security.AreAccessRulesProtected) {
    throw [Security.SecurityException]::new('PICO_DACL_NOT_PROTECTED')
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) {
    throw [Security.SecurityException]::new('PICO_DACL_RULE_COUNT')
  }
  $rule = $rules[0]
  if (
    $rule.IsInherited -or
    $rule.IdentityReference.Value -ne $sid.Value -or
    $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    [int] $rule.FileSystemRights -ne [int] [Security.AccessControl.FileSystemRights]::FullControl
  ) {
    throw [Security.SecurityException]::new('PICO_DACL_NOT_PRIVATE')
  }
}

function Get-PicoAccessSddl([string] $Path) {
  $sections = [Security.AccessControl.AccessControlSections]::Access
  $security = [IO.File]::GetAccessControl($Path, $sections)
  return $security.GetSecurityDescriptorSddlForm($sections)
}

function Get-PicoOwnerGroupKey([string] $Path) {
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Group
  $security = [IO.File]::GetAccessControl($Path, $sections)
  $owner = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $group = $security.GetGroup([Security.Principal.SecurityIdentifier]).Value
  return $owner + '|' + $group
}

try {
  $stage = 'initialize'
  $operation = $env:PICO_WINDOWS_OPERATION
  $stage = $operation
  $temporary = if ($env:PICO_WINDOWS_TEMPORARY) {
    Convert-PicoExtendedPath $env:PICO_WINDOWS_TEMPORARY
  } else { $null }
  $target = if ($env:PICO_WINDOWS_TARGET) {
    Convert-PicoExtendedPath $env:PICO_WINDOWS_TARGET
  } else { $null }
  $backup = if ($env:PICO_WINDOWS_BACKUP) {
    Convert-PicoExtendedPath $env:PICO_WINDOWS_BACKUP
  } else { $null }
  $probe = if ($env:PICO_WINDOWS_PROBE) {
    Convert-PicoExtendedPath $env:PICO_WINDOWS_PROBE
  } else { $null }

  switch ($operation) {
    'create-private' {
      $security = New-PicoPrivateSecurity
      $stream = [IO.FileStream]::new(
        $temporary,
        [IO.FileMode]::CreateNew,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::None,
        $security
      )
      $stream.Dispose()
      Assert-PicoPrivate $temporary
      break
    }
    'assert-private' {
      $lock = [IO.FileStream]::new(
        $temporary,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite
      )
      try { Assert-PicoPrivate $temporary } finally { $lock.Dispose() }
      break
    }
    'restore-private' {
      $lock = [IO.FileStream]::new(
        $temporary,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite
      )
      try {
        Set-PicoPrivate $temporary
        Assert-PicoPrivate $temporary
      } finally { $lock.Dispose() }
      break
    }
    'compare-access' {
      $targetLock = [IO.FileStream]::new(
        $target,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::ReadWrite
      )
      try {
        $backupLock = [IO.FileStream]::new(
          $backup,
          [IO.FileMode]::Open,
          [IO.FileAccess]::Read,
          [IO.FileShare]::ReadWrite
        )
        try {
          if (
            (Get-PicoAccessSddl $target) -ne (Get-PicoAccessSddl $backup) -or
            (Get-PicoOwnerGroupKey $target) -ne (Get-PicoOwnerGroupKey $backup)
          ) {
            throw [Security.SecurityException]::new('PICO_SECURITY_DESCRIPTOR_MISMATCH')
          }
        } finally { $backupLock.Dispose() }
      } finally { $targetLock.Dispose() }
      break
    }
    'publish-existing' {
      $before = Get-PicoAccessSddl $target
      $beforeOwnerGroup = Get-PicoOwnerGroupKey $target
      if ((Get-PicoOwnerGroupKey $temporary) -ne $beforeOwnerGroup) {
        throw [Security.SecurityException]::new('PICO_OWNER_GROUP_MISMATCH')
      }
      [IO.File]::Replace($temporary, $target, $backup, $false)
      $after = Get-PicoAccessSddl $target
      if ($after -ne $before -or (Get-PicoOwnerGroupKey $target) -ne $beforeOwnerGroup) {
        throw [Security.SecurityException]::new('PICO_SECURITY_DESCRIPTOR_MISMATCH')
      }
      break
    }
    'publish-new' {
      $probeStream = $null
      try {
        $stage = 'publish-new/probe-create'
        $probeStream = [IO.FileStream]::new(
          $probe,
          [IO.FileMode]::CreateNew,
          [IO.FileAccess]::ReadWrite,
          [IO.FileShare]::Read,
          4096,
          [IO.FileOptions]::DeleteOnClose
        )
        # 保持拒绝 delete sharing 的句柄直到安全描述符捕获完成，阻止 probe 被换名。
        $stage = 'publish-new/probe-security'
        $normalOwnerGroup = Get-PicoOwnerGroupKey $probe
        $normalSddl = Get-PicoAccessSddl $probe
        $probeStream.Dispose()
        $probeStream = $null

        $stage = 'publish-new/move'
        [IO.File]::Move($temporary, $target)
        $targetLock = $null
        try {
          # DACL 应用与验证期间独占数据句柄，阻止 final path 被换名或新主体抢先读取。
          $stage = 'publish-new/target-open'
          $targetLock = [IO.FileStream]::new(
            $target,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::None
          )
          $stage = 'publish-new/dacl-apply'
          Set-PicoInheritedAccess $target
          $stage = 'publish-new/dacl-verify'
          if ((Get-PicoAccessSddl $target) -ne $normalSddl) {
            throw [Security.SecurityException]::new('PICO_NEW_DACL_MISMATCH')
          }
          $stage = 'publish-new/owner-group-verify'
          if ((Get-PicoOwnerGroupKey $target) -ne $normalOwnerGroup) {
            throw [Security.SecurityException]::new('PICO_NEW_OWNER_GROUP_MISMATCH')
          }
        } catch {
          try { Set-PicoPrivate $target } catch {}
          throw
        } finally {
          if ($null -ne $targetLock) { try { $targetLock.Dispose() } catch {} }
        }
      } finally {
        if ($null -ne $probeStream) { try { $probeStream.Dispose() } catch {} }
      }
      break
    }
    default {
      throw [ArgumentException]::new('PICO_UNKNOWN_OPERATION')
    }
  }
  [Console]::Out.Write('OK')
  exit 0
} catch {
  $exception = $_.Exception
  $message = $exception.Message -replace '[\r\n|]+', ' '
  [Console]::Error.Write(
    $exception.GetType().FullName +
    '|0x' + $exception.HResult.ToString('X8') +
    '|' + $stage +
    '|' + $message
  )
  exit 1
}
`;

let trustedPowerShellPromise: Promise<TrustedWindowsPowerShell> | undefined;

export async function createPrivateWindowsTemporary(
  temporaryPath: string,
): Promise<WindowsFileIdentity> {
  assertWindowsPlatform();
  await runWindowsHelper("create-private", { temporaryPath });
  const identity = await readWindowsFileIdentity(temporaryPath);
  if (!identity) {
    throw new Error(`Windows 私有临时文件创建后不可见: ${temporaryPath}`);
  }
  return identity;
}

export async function assertPrivateWindowsTemporary(
  temporaryPath: string,
  expectedIdentity: WindowsFileIdentity,
): Promise<void> {
  await assertWindowsIdentity(temporaryPath, expectedIdentity, "验证私有 DACL 前");
  await runWindowsHelper("assert-private", { temporaryPath });
  await assertWindowsIdentity(temporaryPath, expectedIdentity, "验证私有 DACL 后");
}

export async function restorePrivateWindowsTemporary(
  temporaryPath: string,
  expectedIdentity: WindowsFileIdentity,
): Promise<void> {
  await assertWindowsIdentity(temporaryPath, expectedIdentity, "恢复私有 DACL 前");
  await runWindowsHelper("restore-private", { temporaryPath });
  await assertWindowsIdentity(temporaryPath, expectedIdentity, "恢复私有 DACL 后");
}

export async function publishWindowsAtomicFile(
  input: WindowsAtomicPublishInput,
): Promise<WindowsAtomicPublishResult> {
  assertWindowsPlatform();
  const existingIdentity = input.existingIdentity;
  if (existingIdentity) {
    return await publishWindowsExistingFile({ ...input, existingIdentity });
  }
  return await publishWindowsNewFile(input);
}

async function publishWindowsExistingFile(
  input: WindowsAtomicPublishInput & { readonly existingIdentity: WindowsFileIdentity },
): Promise<WindowsAtomicPublishResult> {
  const backupPath = join(
    dirname(input.targetPath),
    `${WINDOWS_BACKUP_PREFIX}${randomBytes(16).toString("hex")}.tmp`,
  );
  let operationError: unknown;
  try {
    await runWindowsHelper("publish-existing", {
      temporaryPath: input.temporaryPath,
      targetPath: input.targetPath,
      backupPath,
    });
  } catch (error) {
    operationError = error;
  }

  const [targetIdentity, temporaryIdentity, backupIdentity] = await Promise.all([
    readWindowsFileIdentity(input.targetPath),
    readWindowsFileIdentity(input.temporaryPath),
    readWindowsFileIdentity(backupPath),
  ]);

  if (
    sameOptionalWindowsIdentity(targetIdentity, input.temporaryIdentity) &&
    temporaryIdentity === undefined &&
    sameOptionalWindowsIdentity(backupIdentity, input.existingIdentity)
  ) {
    if (operationError) {
      try {
        await runWindowsHelper("compare-access", {
          targetPath: input.targetPath,
          backupPath,
        });
      } catch (comparisonError) {
        const removedReplacement = await secureAndRemoveWindowsTemporary(
          input.targetPath,
          input.temporaryIdentity,
        );
        if (removedReplacement) {
          try {
            await rename(backupPath, input.targetPath);
            await assertWindowsIdentity(
              input.targetPath,
              input.existingIdentity,
              "回滚 DACL 异常后",
            );
          } catch (recoveryError) {
            throw new WindowsAtomicPublicationError(
              `Windows 原子替换的 DACL 无法确认，且原文件恢复失败: ${input.targetPath}`,
              {
                cause: new AggregateError([operationError, comparisonError, recoveryError]),
                published: false,
                preserveTemporary: true,
              },
            );
          }
          throw new WindowsAtomicPublicationError(
            `Windows 原子替换的 DACL 无法确认，已回滚原文件: ${input.targetPath}`,
            {
              cause: new AggregateError([operationError, comparisonError]),
              published: false,
            },
          );
        }
        throw new WindowsAtomicPublicationError(
          `Windows 原子替换已发生，但无法确认 DACL 保真: ${input.targetPath}`,
          {
            cause: new AggregateError([operationError, comparisonError]),
            published: true,
            preserveTemporary: true,
          },
        );
      }
    }
    try {
      await unlinkWindowsFileIfIdentity(backupPath, input.existingIdentity);
    } catch (cleanupError) {
      throw new WindowsAtomicPublicationError(
        `Windows 原子替换已发布，但旧文件备份清理失败: ${backupPath}`,
        { cause: cleanupError, published: true, preserveTemporary: true },
      );
    }
    return { published: true };
  }

  if (
    sameOptionalWindowsIdentity(targetIdentity, input.existingIdentity) &&
    sameOptionalWindowsIdentity(temporaryIdentity, input.temporaryIdentity) &&
    backupIdentity === undefined
  ) {
    const secured = await secureAndRemoveWindowsTemporary(
      input.temporaryPath,
      input.temporaryIdentity,
    );
    throw new WindowsAtomicPublicationError(
      `Windows 原子替换失败，原文件保持不变: ${input.targetPath}`,
      {
        cause: operationError,
        published: false,
        preserveTemporary: !secured,
      },
    );
  }

  if (
    targetIdentity === undefined &&
    sameOptionalWindowsIdentity(temporaryIdentity, input.temporaryIdentity) &&
    sameOptionalWindowsIdentity(backupIdentity, input.existingIdentity)
  ) {
    const secured = await secureAndRemoveWindowsTemporary(
      input.temporaryPath,
      input.temporaryIdentity,
    );
    try {
      await rename(backupPath, input.targetPath);
      await assertWindowsIdentity(input.targetPath, input.existingIdentity, "恢复原文件后");
      throw new WindowsAtomicPublicationError(
        `Windows 原子替换失败，已恢复原文件: ${input.targetPath}`,
        {
          cause: operationError,
          published: false,
          preserveTemporary: !secured,
        },
      );
    } catch (recoveryError) {
      if (recoveryError instanceof WindowsAtomicPublicationError) throw recoveryError;
      throw new WindowsAtomicPublicationError(
        `Windows 原子替换失败且无法恢复原文件: ${input.targetPath}`,
        {
          cause: new AggregateError([operationError, recoveryError]),
          published: false,
          preserveTemporary: !secured,
        },
      );
    }
  }

  if (sameOptionalWindowsIdentity(targetIdentity, input.temporaryIdentity)) {
    const removedReplacement = await secureAndRemoveWindowsTemporary(
      input.targetPath,
      input.temporaryIdentity,
    );
    if (removedReplacement && sameOptionalWindowsIdentity(backupIdentity, input.existingIdentity)) {
      try {
        await rename(backupPath, input.targetPath);
        await assertWindowsIdentity(input.targetPath, input.existingIdentity, "恢复并发替换目标后");
        throw new WindowsAtomicPublicationError(
          `Windows 原子替换命中并发目标，已移除待发布内容并恢复被替换文件: ${input.targetPath}`,
          { cause: operationError, published: false },
        );
      } catch (recoveryError) {
        if (recoveryError instanceof WindowsAtomicPublicationError) throw recoveryError;
        throw new WindowsAtomicPublicationError(
          `Windows 原子替换命中并发目标，待发布内容已移除但备份恢复失败: ${input.targetPath}`,
          {
            cause: new AggregateError([operationError, recoveryError]),
            published: false,
            preserveTemporary: true,
          },
        );
      }
    }
    throw new WindowsAtomicPublicationError(
      `Windows 原子替换命中并发目标，无法安全恢复: ${input.targetPath}`,
      {
        cause: operationError,
        published: !removedReplacement,
        preserveTemporary: !removedReplacement,
      },
    );
  }

  const securedUnknownTemporary = sameOptionalWindowsIdentity(
    temporaryIdentity,
    input.temporaryIdentity,
  )
    ? await secureAndRemoveWindowsTemporary(input.temporaryPath, input.temporaryIdentity)
    : true;
  throw new WindowsAtomicPublicationError(
    `Windows 原子替换状态无法确认，已保留现场: ${input.targetPath}`,
    {
      cause: operationError,
      published: false,
      preserveTemporary: !securedUnknownTemporary,
    },
  );
}

async function publishWindowsNewFile(
  input: WindowsAtomicPublishInput,
): Promise<WindowsAtomicPublishResult> {
  const probePath = join(
    dirname(input.targetPath),
    `${WINDOWS_PROBE_PREFIX}${randomBytes(16).toString("hex")}.tmp`,
  );
  let operationError: unknown;
  try {
    await runWindowsHelper("publish-new", {
      temporaryPath: input.temporaryPath,
      targetPath: input.targetPath,
      probePath,
    });
  } catch (error) {
    operationError = error;
  }

  const [targetIdentity, temporaryIdentity] = await Promise.all([
    readWindowsFileIdentity(input.targetPath),
    readWindowsFileIdentity(input.temporaryPath),
  ]);

  if (sameOptionalWindowsIdentity(targetIdentity, input.temporaryIdentity)) {
    if (!operationError && temporaryIdentity === undefined) return { published: true };

    await secureAndRemoveWindowsTemporary(input.targetPath, input.temporaryIdentity);
    if (sameOptionalWindowsIdentity(temporaryIdentity, input.temporaryIdentity)) {
      await secureAndRemoveWindowsTemporary(input.temporaryPath, input.temporaryIdentity);
    }
    const [targetAfterRollback, temporaryAfterRollback] = await Promise.all([
      readWindowsFileIdentity(input.targetPath),
      readWindowsFileIdentity(input.temporaryPath),
    ]);
    const stagedStillAtTarget = sameOptionalWindowsIdentity(
      targetAfterRollback,
      input.temporaryIdentity,
    );
    const stagedStillAtTemporary = sameOptionalWindowsIdentity(
      temporaryAfterRollback,
      input.temporaryIdentity,
    );
    throw new WindowsAtomicPublicationError(
      !stagedStillAtTarget && !stagedStillAtTemporary
        ? `Windows 新文件发布失败，已回滚所有已知暂存路径: ${input.targetPath}`
        : stagedStillAtTarget
          ? `Windows 新文件已发布，但最终 DACL 无法确认: ${input.targetPath}`
          : `Windows 新文件发布失败，目标已回滚但暂存路径无法清理: ${input.targetPath}`,
      {
        cause: operationError,
        published: stagedStillAtTarget,
        preserveTemporary: stagedStillAtTemporary,
      },
    );
  }

  if (
    targetIdentity === undefined &&
    sameOptionalWindowsIdentity(temporaryIdentity, input.temporaryIdentity)
  ) {
    const secured = await secureAndRemoveWindowsTemporary(
      input.temporaryPath,
      input.temporaryIdentity,
    );
    throw new WindowsAtomicPublicationError(
      `Windows 新文件发布失败，目标保持不存在: ${input.targetPath}`,
      {
        cause: operationError,
        published: false,
        preserveTemporary: !secured,
      },
    );
  }

  if (targetIdentity === undefined && temporaryIdentity === undefined && operationError) {
    throw new WindowsAtomicPublicationError(
      `Windows 新文件发布失败，目标保持不存在: ${input.targetPath}`,
      { cause: operationError, published: false },
    );
  }

  if (
    targetIdentity !== undefined &&
    !sameWindowsIdentity(targetIdentity, input.temporaryIdentity) &&
    sameOptionalWindowsIdentity(temporaryIdentity, input.temporaryIdentity)
  ) {
    const secured = await secureAndRemoveWindowsTemporary(
      input.temporaryPath,
      input.temporaryIdentity,
    );
    throw new WindowsAtomicPublicationError(
      `Windows 新文件发布时目标被并发创建: ${input.targetPath}`,
      {
        cause: operationError,
        published: false,
        preserveTemporary: !secured,
      },
    );
  }

  const securedUnknownTemporary = sameOptionalWindowsIdentity(
    temporaryIdentity,
    input.temporaryIdentity,
  )
    ? await secureAndRemoveWindowsTemporary(input.temporaryPath, input.temporaryIdentity)
    : true;
  throw new WindowsAtomicPublicationError(
    `Windows 新文件发布状态无法确认，已保留现场: ${input.targetPath}`,
    {
      cause: operationError,
      published: false,
      preserveTemporary: !securedUnknownTemporary,
    },
  );
}

async function secureAndRemoveWindowsTemporary(
  path: string,
  expectedIdentity: WindowsFileIdentity,
): Promise<boolean> {
  try {
    await restorePrivateWindowsTemporary(path, expectedIdentity);
  } catch {
    // 删除成功同样能消除内容泄露；只有恢复与删除都失败才保留现场。
  }
  try {
    await unlinkWindowsFileIfIdentity(path, expectedIdentity);
    return (await readWindowsFileIdentity(path)) === undefined;
  } catch {
    return false;
  }
}

async function runWindowsHelper(
  operation: WindowsHelperOperation,
  paths: {
    readonly backupPath?: string;
    readonly probePath?: string;
    readonly targetPath?: string;
    readonly temporaryPath?: string;
  },
): Promise<void> {
  const trusted = await resolveTrustedWindowsPowerShell();
  const environment: NodeJS.ProcessEnv = {
    ComSpec: join(trusted.system32, "cmd.exe"),
    PATH: trusted.system32,
    SystemRoot: trusted.systemRoot,
    WINDIR: trusted.systemRoot,
    PICO_WINDOWS_OPERATION: operation,
  };
  copyOptionalEnvironment(environment, "TEMP");
  copyOptionalEnvironment(environment, "TMP");
  if (paths.temporaryPath) {
    environment.PICO_WINDOWS_TEMPORARY = prepareWindowsHelperPath(paths.temporaryPath);
  }
  if (paths.targetPath)
    environment.PICO_WINDOWS_TARGET = prepareWindowsHelperPath(paths.targetPath);
  if (paths.backupPath)
    environment.PICO_WINDOWS_BACKUP = prepareWindowsHelperPath(paths.backupPath);
  if (paths.probePath) environment.PICO_WINDOWS_PROBE = prepareWindowsHelperPath(paths.probePath);

  try {
    const execution = execFileAsync(
      trusted.command,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(WINDOWS_HELPER_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        cwd: trusted.system32,
        encoding: "utf8",
        env: environment,
        maxBuffer: WINDOWS_HELPER_MAX_BYTES,
        timeout: WINDOWS_HELPER_TIMEOUT_MS,
        windowsHide: true,
      },
    ) as ReturnType<typeof execFileAsync> & { readonly child: ChildProcess };
    // Windows PowerShell may wait for stdin EOF even when all commands came from
    // -EncodedCommand. The promisified execFile promise exposes its child process.
    execution.child.stdin?.end();
    const { stdout } = (await execution) as { readonly stdout: string };
    if (stdout.trim() !== "OK") {
      throw new Error("Windows 文件安全 helper 返回了非预期输出");
    }
  } catch (error) {
    throw new Error(
      `Windows 文件安全 helper 执行失败: ${operation} (${windowsHelperFailureSummary(error)})`,
      { cause: error },
    );
  }
}

function windowsHelperFailureSummary(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const details: string[] = [];
  if ("code" in error && error.code !== undefined) details.push(`code=${String(error.code)}`);
  if ("signal" in error && error.signal !== undefined)
    details.push(`signal=${String(error.signal)}`);
  if ("killed" in error && error.killed === true) details.push("killed=true");
  if ("stderr" in error && typeof error.stderr === "string") {
    const diagnostic = error.stderr.trim().replace(/\s+/gu, " ");
    if (diagnostic.length > 0) details.push(`stderr=${diagnostic.slice(0, 256)}`);
  }
  return details.join(",") || "unknown";
}

async function resolveTrustedWindowsPowerShell(): Promise<TrustedWindowsPowerShell> {
  assertWindowsPlatform();
  trustedPowerShellPromise ??= resolveTrustedWindowsPowerShellUncached();
  return await trustedPowerShellPromise;
}

async function resolveTrustedWindowsPowerShellUncached(): Promise<TrustedWindowsPowerShell> {
  const configuredRoots = [process.env.SystemRoot, process.env.WINDIR].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (configuredRoots.length === 0 || configuredRoots.some((root) => !isAbsolute(root))) {
    throw new Error("Windows SystemRoot/WINDIR 缺失或不是绝对路径，已拒绝文件写入");
  }
  const canonicalRoots = await Promise.all(
    configuredRoots.map(async (root) => await realpath(root)),
  );
  if (
    canonicalRoots.some(
      (root) => normalizeWindowsPath(root) !== normalizeWindowsPath(canonicalRoots[0]!),
    )
  ) {
    throw new Error("Windows SystemRoot 与 WINDIR 不一致，已拒绝文件写入");
  }

  const systemRoot = canonicalRoots[0]!;
  const system32 = resolve(systemRoot, "System32");
  const command = resolve(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const [system32Info, commandInfo, canonicalCommand] = await Promise.all([
    lstat(system32),
    lstat(command),
    realpath(command),
  ]);
  if (
    system32Info.isSymbolicLink() ||
    !system32Info.isDirectory() ||
    commandInfo.isSymbolicLink() ||
    !commandInfo.isFile() ||
    normalizeWindowsPath(canonicalCommand) !== normalizeWindowsPath(command)
  ) {
    throw new Error("Windows PowerShell 系统路径验证失败，已拒绝文件写入");
  }
  return { command: canonicalCommand, system32, systemRoot };
}

async function assertWindowsIdentity(
  path: string,
  expected: WindowsFileIdentity,
  stage: string,
): Promise<void> {
  const current = await readWindowsFileIdentity(path);
  if (!current || !sameWindowsIdentity(current, expected)) {
    throw new Error(`${stage} Windows 文件已被替换: ${path}`);
  }
}

async function readWindowsFileIdentity(path: string): Promise<WindowsFileIdentity | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Windows 原子发布路径不是普通文件: ${path}`);
    }
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function unlinkWindowsFileIfIdentity(
  path: string,
  expectedIdentity: WindowsFileIdentity,
): Promise<void> {
  const current = await readWindowsFileIdentity(path);
  if (!current) return;
  if (!sameWindowsIdentity(current, expectedIdentity)) {
    throw new Error(`拒绝清理已被替换的 Windows 临时文件: ${path}`);
  }
  await unlink(path);
}

function copyOptionalEnvironment(environment: NodeJS.ProcessEnv, name: "TEMP" | "TMP"): void {
  const value = process.env[name];
  if (value) environment[name] = value;
}

function prepareWindowsHelperPath(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`Windows 文件安全 helper 路径不是绝对路径: ${path}`);
  }
  const namespaced = toNamespacedPath(resolve(path));
  if (!namespaced.startsWith("\\\\?\\")) {
    throw new Error(`Windows 文件安全 helper 无法建立长路径命名空间: ${path}`);
  }
  return namespaced;
}

function normalizeWindowsPath(path: string): string {
  return normalize(path).toLocaleLowerCase("en-US");
}

function sameOptionalWindowsIdentity(
  actual: WindowsFileIdentity | undefined,
  expected: WindowsFileIdentity,
): boolean {
  return actual !== undefined && sameWindowsIdentity(actual, expected);
}

function sameWindowsIdentity(left: WindowsFileIdentity, right: WindowsFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertWindowsPlatform(): void {
  if (process.platform !== "win32") {
    throw new Error("Windows 原子文件 helper 只能在 win32 平台调用");
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
