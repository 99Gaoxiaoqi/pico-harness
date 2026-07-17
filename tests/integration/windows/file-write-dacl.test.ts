import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  captureAtomicFilePrecondition,
  writeAtomicWorkspaceFile,
} from "../../../src/tools/atomic-workspace-file.js";
import { EditFileTool, WriteFileTool } from "../../../src/tools/registry-impl.js";

const WINDOWS_ONLY = { skip: process.platform !== "win32" } as const;
const LOW_PRIVILEGE_WINDOWS_ONLY = {
  skip:
    process.platform === "win32" && process.env.PICO_WINDOWS_LOW_PRIVILEGE_TEST === "1"
      ? false
      : "requires PICO_WINDOWS_LOW_PRIVILEGE_TEST=1 on an ephemeral Windows runner",
} as const;
const TEMPORARY_PREFIXES = [".pico-write-", ".pico-metadata-probe-"] as const;
const LOW_PRIVILEGE_TIMEOUT_MS = 15_000;

interface AccessSnapshot {
  readonly protected: boolean;
  readonly accessKey: string;
  readonly rules: readonly {
    readonly sid: string;
    readonly type: string;
    readonly rights: number;
    readonly inherited: boolean;
  }[];
  readonly sddl: string;
  readonly currentSid: string;
  readonly ownerSid: string;
  readonly groupSid: string;
}

interface LowPrivilegeWatcherOptions {
  readonly userName: string;
  readonly password: string;
  readonly workspace: string;
  readonly readyPath: string;
  readonly earlyPath: string;
  readonly contentReadyPath: string;
  readonly finalPath: string;
  readonly stopPath: string;
}

interface WindowsProcessIdentity {
  readonly pid: number;
  readonly startedAtUtcTicks: string;
}

test(
  "Windows staging DACL is protected and grants access only to the current SID",
  WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("private-staging");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "private.txt");
    await writeFile(targetPath, "old-content\n");
    await restrictToCurrentSid(targetPath);
    const precondition = await captureAtomicFilePrecondition(targetPath);
    let revalidationCount = 0;
    let inspectedEmptyStage = false;
    let inspectedContentStage = false;

    await assert.rejects(
      writeAtomicWorkspaceFile({
        targetPath,
        content: "UNPUBLISHED-WINDOWS-SECRET\n",
        precondition,
        revalidateTarget: async () => {
          revalidationCount++;
          if (revalidationCount !== 2 && revalidationCount !== 3) return;
          const temporaryName = (await readdir(fixture.workspace)).find((entry) =>
            entry.startsWith(".pico-write-"),
          );
          assert.ok(temporaryName, "写入前后复核都必须观察到临时文件");
          const temporaryPath = join(fixture.workspace, temporaryName);
          const expectedBytes =
            revalidationCount === 2
              ? 0n
              : BigInt(Buffer.byteLength("UNPUBLISHED-WINDOWS-SECRET\n"));
          assert.equal((await stat(temporaryPath, { bigint: true })).size, expectedBytes);
          assertPrivateAccess(await readAccessSnapshot(temporaryPath));
          if (revalidationCount === 2) {
            inspectedEmptyStage = true;
            return;
          }
          inspectedContentStage = true;
          await writeFile(targetPath, "concurrent-change\n");
        },
      }),
      /目标文件已被替换或修改/u,
    );

    assert.equal(inspectedEmptyStage, true);
    assert.equal(inspectedContentStage, true);
    assert.equal(await readFile(targetPath, "utf8"), "concurrent-change\n");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "Windows write_file and edit_file preserve a protected DACL and alternate data stream",
  WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("preserve-dacl");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const relativePath = "quoted ' ; $() 中文.txt";
    const targetPath = join(fixture.workspace, relativePath);
    const streamPath = `${targetPath}:pico-preserve`;
    await writeFile(targetPath, "alpha\nbeta\n");
    await restrictToCurrentSid(targetPath);
    await writeFile(streamPath, "preserved-stream\n");
    const before = await readAccessSnapshot(targetPath);

    await new WriteFileTool(fixture.workspace).execute(
      JSON.stringify({ path: relativePath, content: "gamma\ndelta\n" }),
    );
    const afterWrite = await readAccessSnapshot(targetPath);
    assert.equal(afterWrite.protected, true);
    assert.equal(afterWrite.sddl, before.sddl);
    assert.equal(await readFile(streamPath, "utf8"), "preserved-stream\n");

    await new EditFileTool(fixture.workspace).execute(
      JSON.stringify({ path: relativePath, old_text: "delta", new_text: "epsilon" }),
    );
    const afterEdit = await readAccessSnapshot(targetPath);
    assert.equal(afterEdit.protected, true);
    assert.equal(afterEdit.sddl, before.sddl);
    assert.equal(await readFile(targetPath, "utf8"), "gamma\nepsilon\n");
    assert.equal(await readFile(streamPath, "utf8"), "preserved-stream\n");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "Windows low-privilege reader cannot hold or read a named staging file",
  LOW_PRIVILEGE_WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("low-privilege-staging");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const resultDirectory = join(fixture.root, "watcher-results");
    const targetPath = join(fixture.workspace, "private.txt");
    await mkdir(resultDirectory);
    await writeFile(targetPath, "old-content\n");
    const stopPath = join(resultDirectory, "stop");

    const userName = `pico_acl_${randomBytes(4).toString("hex")}`;
    const password = `Pico!${randomBytes(18).toString("base64url")}aA9`;
    let watcher: WindowsProcessIdentity | undefined;
    let primaryError: unknown;
    try {
      const watcherSid = await createTemporaryLocalUser(userName, password);
      await grantDirectoryAccess(fixture.root, watcherSid, "ReadAndExecute");
      await grantDirectoryAccess(fixture.workspace, watcherSid, "ReadAndExecute");
      await grantDirectoryAccess(resultDirectory, watcherSid, "Modify");
      await restrictToCurrentSid(targetPath);

      const readyPath = join(resultDirectory, "ready");
      const earlyPath = join(resultDirectory, "early");
      const contentReadyPath = join(resultDirectory, "content-ready");
      const finalPath = join(resultDirectory, "final");
      watcher = await startLowPrivilegeWatcher({
        userName,
        password,
        workspace: fixture.workspace,
        readyPath,
        earlyPath,
        contentReadyPath,
        finalPath,
        stopPath,
      });
      assert.equal(await waitForFileContent(readyPath), "READY");

      const precondition = await captureAtomicFilePrecondition(targetPath);
      let revalidationCount = 0;
      await assert.rejects(
        writeAtomicWorkspaceFile({
          targetPath,
          content: "UNPUBLISHED-LOW-PRIVILEGE-SECRET\n",
          precondition,
          revalidateTarget: async () => {
            revalidationCount++;
            if (revalidationCount === 2) {
              assert.equal(
                await waitForFileContent(earlyPath),
                "DENIED",
                "低权限主体不能在临时文件为空时持有读句柄",
              );
              return;
            }
            if (revalidationCount !== 3) return;
            await writeFile(contentReadyPath, "READY");
            assert.equal(
              await waitForFileContent(finalPath),
              "SAFE",
              "低权限主体不能读取已写入但未发布的内容",
            );
            await writeFile(targetPath, "concurrent-change\n");
          },
        }),
        /目标文件已被替换或修改/u,
      );

      assert.equal(await readFile(targetPath, "utf8"), "concurrent-change\n");
      await assertNoTemporaryFiles(fixture.workspace);
      await writeFile(stopPath, "STOP");
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await writeFile(stopPath, "STOP");
    } catch (error) {
      cleanupErrors.push(
        new Error(`写入 watcher 停止信号: ${formatError(error)}`, { cause: error }),
      );
    }
    if (watcher !== undefined) {
      try {
        await stopWindowsProcess(watcher);
      } catch (error) {
        cleanupErrors.push(new Error(`停止 watcher 进程: ${formatError(error)}`, { cause: error }));
      }
    }
    try {
      await removeTemporaryLocalUser(userName);
    } catch (error) {
      cleanupErrors.push(new Error(`删除临时本地用户: ${formatError(error)}`, { cause: error }));
    }

    if (primaryError !== undefined && cleanupErrors.length > 0) {
      context.diagnostic(
        `Windows 低权限 DACL 测试清理也失败: ${cleanupErrors.map(formatError).join("; ")}`,
      );
      throw primaryError;
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        cleanupErrors,
        `Windows 低权限 DACL 测试清理失败: ${cleanupErrors.map(formatError).join("; ")}`,
      );
  },
);

test(
  "Windows new files receive the same inherited access DACL as a normal sibling",
  WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("new-file-inheritance");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const baselinePath = join(fixture.workspace, "normal-sibling.txt");
    const targetPath = join(fixture.workspace, "tool-created.txt");
    await writeFile(baselinePath, "baseline\n");

    await new WriteFileTool(fixture.workspace).execute(
      JSON.stringify({ path: "tool-created.txt", content: "created\n" }),
    );

    const [baseline, target] = await Promise.all([
      readAccessSnapshot(baselinePath),
      readAccessSnapshot(targetPath),
    ]);
    assert.equal(target.accessKey, baseline.accessKey);
    assert.equal(target.protected, baseline.protected);
    assert.equal(await readFile(targetPath, "utf8"), "created\n");
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

test(
  "Windows creates and replaces files beyond the legacy MAX_PATH limit",
  WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("long-path");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const segments = Array.from(
      { length: 9 },
      (_, index) => `segment-${String(index)}-${"x".repeat(24)}`,
    );
    const relativeDirectory = segments.join("/");
    const directory = join(fixture.workspace, ...segments);
    const baselinePath = join(directory, "normal-sibling.txt");
    const targetPath = join(directory, "tool-created.txt");
    await mkdir(directory, { recursive: true });
    assert.ok(targetPath.length > 260, `test path must exceed MAX_PATH: ${targetPath.length}`);
    await writeFile(baselinePath, "baseline\n");

    const tool = new WriteFileTool(fixture.workspace);
    await tool.execute(
      JSON.stringify({ path: `${relativeDirectory}/tool-created.txt`, content: "created\n" }),
    );
    assert.equal(
      (await readAccessSnapshot(targetPath)).accessKey,
      (await readAccessSnapshot(baselinePath)).accessKey,
    );

    await restrictToCurrentSid(targetPath);
    const restricted = await readAccessSnapshot(targetPath);
    await tool.execute(
      JSON.stringify({ path: `${relativeDirectory}/tool-created.txt`, content: "replaced\n" }),
    );
    assert.equal(await readFile(targetPath, "utf8"), "replaced\n");
    assert.equal((await readAccessSnapshot(targetPath)).sddl, restricted.sddl);
    await assertNoTemporaryFiles(directory);
  },
);

test(
  "Windows replacement failure keeps the original content and DACL without residue",
  WINDOWS_ONLY,
  async (context) => {
    const fixture = await createFixture("locked-target");
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const targetPath = join(fixture.workspace, "locked.txt");
    await writeFile(targetPath, "old-content\n");
    await restrictToCurrentSid(targetPath);
    const before = await readAccessSnapshot(targetPath);
    const holder = spawnPowerShell(
      String.raw`
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($env:PICO_TEST_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  $stream.Dispose()
}
`,
      { PICO_TEST_PATH: targetPath },
    );
    let holderError = "";
    holder.stderr.setEncoding("utf8");
    holder.stderr.on("data", (chunk: string) => {
      holderError += chunk;
    });
    try {
      await waitForOutput(holder, "READY");
      const precondition = await captureAtomicFilePrecondition(targetPath);
      let revalidationCount = 0;
      let reachedPublicationBoundary = false;
      await assert.rejects(
        writeAtomicWorkspaceFile({
          targetPath,
          content: "replacement\n",
          precondition,
          revalidateTarget: async () => {
            revalidationCount++;
            if (revalidationCount !== 4) return;
            const temporaryName = (await readdir(fixture.workspace)).find((entry) =>
              entry.startsWith(".pico-write-"),
            );
            assert.ok(temporaryName, "最终复核必须仍有待发布临时文件");
            const temporaryPath = join(fixture.workspace, temporaryName);
            assert.equal((await stat(temporaryPath)).size, Buffer.byteLength("replacement\n"));
            assertPrivateAccess(await readAccessSnapshot(temporaryPath));
            reachedPublicationBoundary = true;
          },
        }),
      );
      assert.equal(reachedPublicationBoundary, true, "测试必须实际到达原子发布边界");
    } finally {
      await stopChild(holder);
    }
    assert.equal(holder.exitCode, 0, holderError);

    assert.equal(await readFile(targetPath, "utf8"), "old-content\n");
    assert.equal((await readAccessSnapshot(targetPath)).sddl, before.sddl);
    await assertNoTemporaryFiles(fixture.workspace);
  },
);

async function createTemporaryLocalUser(userName: string, password: string): Promise<string> {
  const sid = await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$password = ConvertTo-SecureString $env:PICO_TEST_PASSWORD -AsPlainText -Force
$user = New-LocalUser -Name $env:PICO_TEST_USER -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'pico-harness temporary ACL integration user'
$usersSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
Add-LocalGroupMember -SID $usersSid -Member $user
[Console]::Out.Write($user.SID.Value)
`,
    { PICO_TEST_USER: userName, PICO_TEST_PASSWORD: password },
  );
  assert.match(sid, /^S-\d+(?:-\d+)+$/u);
  return sid;
}

async function removeTemporaryLocalUser(userName: string): Promise<void> {
  await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ($true) {
  $user = Get-LocalUser -Name $env:PICO_TEST_USER -ErrorAction SilentlyContinue
  if ($null -eq $user) { break }
  try {
    Remove-LocalUser -SID $user.SID -Confirm:$false -ErrorAction Stop
    break
  } catch {
    if ([DateTime]::UtcNow -ge $deadline) { throw }
    Start-Sleep -Milliseconds 200
  }
}
`,
    { PICO_TEST_USER: userName },
    20_000,
  );
}

async function grantDirectoryAccess(
  path: string,
  sid: string,
  rights: "Modify" | "ReadAndExecute",
): Promise<void> {
  await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$sid = New-Object Security.Principal.SecurityIdentifier($env:PICO_TEST_SID)
$security = [IO.Directory]::GetAccessControl($env:PICO_TEST_PATH)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rights = [Enum]::Parse([Security.AccessControl.FileSystemRights], $env:PICO_TEST_RIGHTS)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $sid,
  $rights,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$security.SetAccessRule($rule)
[IO.Directory]::SetAccessControl($env:PICO_TEST_PATH, $security)
`,
    { PICO_TEST_PATH: path, PICO_TEST_SID: sid, PICO_TEST_RIGHTS: rights },
  );
}

async function startLowPrivilegeWatcher(
  options: LowPrivilegeWatcherOptions,
): Promise<WindowsProcessIdentity> {
  // CreateProcessWithLogonW limits its command line to 1,024 characters. Keep the watcher body
  // in a fixture script instead of passing the much larger EncodedCommand.
  const watcherScriptPath = join(
    dirname(options.workspace),
    `.pico-low-privilege-watcher-${randomBytes(8).toString("hex")}.ps1`,
  );
  await writeFile(watcherScriptPath, buildLowPrivilegeWatcherScript(options), { flag: "wx" });
  const output = await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class PicoLowPrivilegeProcessLauncher
{
    // The watcher uses only explicit file paths and never needs HKCU or a user profile.
    private const int LogonWithoutProfile = 0x00000000;
    private const int CreateNoWindow = 0x08000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessWithLogonW(
        string userName,
        string domain,
        string password,
        int logonFlags,
        string applicationName,
        StringBuilder commandLine,
        int creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FileTime creationTime,
        out FileTime exitTime,
        out FileTime kernelTime,
        out FileTime userTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string Start(
        string userName,
        string domain,
        string password,
        string applicationPath,
        string scriptPath,
        string currentDirectory)
    {
        var startupInfo = new StartupInfo();
        startupInfo.cb = Marshal.SizeOf(typeof(StartupInfo));
        var processInformation = new ProcessInformation();
        var commandLine = new StringBuilder(
            "\"" + applicationPath + "\" -NoLogo -NoProfile -NonInteractive " +
            "-ExecutionPolicy Bypass -File \"" + scriptPath + "\"");

        if (!CreateProcessWithLogonW(
            userName,
            domain,
            password,
            LogonWithoutProfile,
            applicationPath,
            commandLine,
            CreateNoWindow,
            IntPtr.Zero,
            currentDirectory,
            ref startupInfo,
            out processInformation))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        try
        {
            FileTime creationTime;
            FileTime exitTime;
            FileTime kernelTime;
            FileTime userTime;
            if (!GetProcessTimes(
                processInformation.hProcess,
                out creationTime,
                out exitTime,
                out kernelTime,
                out userTime))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var windowsTicks =
                ((long)creationTime.dwHighDateTime << 32) | creationTime.dwLowDateTime;
            var utcTicks = DateTime.FromFileTimeUtc(windowsTicks).Ticks;
            return processInformation.dwProcessId.ToString(CultureInfo.InvariantCulture) +
                "|" + utcTicks.ToString(CultureInfo.InvariantCulture);
        }
        catch
        {
            TerminateProcess(processInformation.hProcess, 1);
            throw;
        }
        finally
        {
            CloseHandle(processInformation.hThread);
            CloseHandle(processInformation.hProcess);
        }
    }
}
'@

$output = [PicoLowPrivilegeProcessLauncher]::Start(
  $env:PICO_TEST_USER,
  [Environment]::MachineName,
  $env:PICO_TEST_PASSWORD,
  (Join-Path $PSHOME 'powershell.exe'),
  $env:PICO_WATCHER_SCRIPT,
  $env:SystemRoot
)
[Console]::Out.Write($output)
`,
    {
      PICO_TEST_USER: options.userName,
      PICO_TEST_PASSWORD: options.password,
      PICO_WATCHER_SCRIPT: watcherScriptPath,
    },
  );
  const [pidText, startedAtUtcTicks] = output.split("|");
  const pid = Number(pidText);
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true, `invalid watcher pid: ${output}`);
  assert.match(startedAtUtcTicks ?? "", /^\d+$/u, `invalid watcher start time: ${output}`);
  return { pid, startedAtUtcTicks: startedAtUtcTicks ?? "" };
}

function buildLowPrivilegeWatcherScript(options: LowPrivilegeWatcherOptions): string {
  const encodedPath = (path: string): string => Buffer.from(path, "utf8").toString("base64");
  return String.raw`
$ErrorActionPreference = 'Stop'
function Decode-Path([string]$encoded) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
}
$workspace = Decode-Path '${encodedPath(options.workspace)}'
$readyPath = Decode-Path '${encodedPath(options.readyPath)}'
$earlyPath = Decode-Path '${encodedPath(options.earlyPath)}'
$contentReadyPath = Decode-Path '${encodedPath(options.contentReadyPath)}'
$finalPath = Decode-Path '${encodedPath(options.finalPath)}'
$stopPath = Decode-Path '${encodedPath(options.stopPath)}'
$deadline = [DateTime]::UtcNow.AddSeconds(12)
$temporaryPath = $null
$heldStream = $null
try {
  [IO.File]::WriteAllText($readyPath, 'READY')
  while ([DateTime]::UtcNow -lt $deadline -and -not [IO.File]::Exists($stopPath)) {
    if ($null -eq $temporaryPath) {
      $temporaryFiles = [IO.Directory]::GetFiles($workspace, '.pico-write-*')
      if ($temporaryFiles.Length -eq 0) {
        Start-Sleep -Milliseconds 2
        continue
      }
      $temporaryPath = $temporaryFiles[0]
    }

    if ($null -eq $heldStream) {
      try {
        $share = [IO.FileShare]([int][IO.FileShare]::ReadWrite -bor [int][IO.FileShare]::Delete)
        $heldStream = New-Object IO.FileStream(
          $temporaryPath,
          [IO.FileMode]::Open,
          [IO.FileAccess]::Read,
          $share
        )
        if (-not [IO.File]::Exists($earlyPath)) {
          [IO.File]::WriteAllText($earlyPath, 'HELD')
        }
      } catch [UnauthorizedAccessException] {
        if (-not [IO.File]::Exists($earlyPath)) {
          [IO.File]::WriteAllText($earlyPath, 'DENIED')
        }
        if ([IO.File]::Exists($contentReadyPath)) {
          [IO.File]::WriteAllText($finalPath, 'SAFE')
          exit 0
        }
      } catch [IO.IOException] {
        # Retry sharing and disappearance races while the writer remains paused.
      }
    }

    if ($null -ne $heldStream -and [IO.File]::Exists($contentReadyPath)) {
      $heldStream.Position = 0
      $buffer = [Array]::CreateInstance([byte], 4096)
      $bytesRead = $heldStream.Read($buffer, 0, $buffer.Length)
      if ($bytesRead -gt 0) {
        $leaked = [Convert]::ToBase64String($buffer, 0, $bytesRead)
        [IO.File]::WriteAllText($finalPath, 'LEAK:' + $leaked)
        exit 2
      }
    }
    Start-Sleep -Milliseconds 2
  }
  if (-not [IO.File]::Exists($finalPath)) {
    [IO.File]::WriteAllText($finalPath, 'TIMEOUT')
  }
  exit 3
} finally {
  if ($null -ne $heldStream) {
    $heldStream.Dispose()
  }
}
`;
}

async function stopWindowsProcess(processIdentity: WindowsProcessIdentity): Promise<void> {
  await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id ([int]$env:PICO_TEST_PID) -ErrorAction SilentlyContinue
if ($null -ne $process) {
  try {
    # 缓存原生进程句柄；即使随后 PID 被复用，Kill 仍绑定原进程对象。
    $processHandle = $process.Handle
    $actualStart = [string]$process.StartTime.ToUniversalTime().Ticks
  } catch [InvalidOperationException] {
    return
  } catch [ComponentModel.Win32Exception] {
    return
  }
  if ($actualStart -ne $env:PICO_TEST_PROCESS_START) { return }
  try {
    $process.Kill()
    if (-not $process.WaitForExit(5000)) {
      throw 'watcher process did not exit'
    }
  } catch [InvalidOperationException] {
    return
  } catch [ComponentModel.Win32Exception] {
    try {
      if ($process.HasExited) { return }
    } catch [InvalidOperationException] {
      return
    }
    throw
  } finally {
    [GC]::KeepAlive($processHandle)
    $process.Dispose()
  }
}
`,
    {
      PICO_TEST_PID: String(processIdentity.pid),
      PICO_TEST_PROCESS_START: processIdentity.startedAtUtcTicks,
    },
  );
}

async function waitForFileContent(
  path: string,
  timeoutMilliseconds = LOW_PRIVILEGE_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const content = (await readFile(path, "utf8")).trim();
      if (content.length > 0) return content;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EBUSY") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for low-privilege watcher result: ${path}`);
}

async function createFixture(label: string): Promise<{
  root: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-windows-dacl-${label}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

async function restrictToCurrentSid(path: string): Promise<void> {
  await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object Security.AccessControl.FileSecurity
$security.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
[IO.File]::SetAccessControl($env:PICO_TEST_PATH, $security)
`,
    { PICO_TEST_PATH: path },
  );
}

async function readAccessSnapshot(path: string): Promise<AccessSnapshot> {
  const output = await runPowerShell(
    String.raw`
$ErrorActionPreference = 'Stop'
$sections = [Security.AccessControl.AccessControlSections]::Access -bor
  [Security.AccessControl.AccessControlSections]::Owner -bor
  [Security.AccessControl.AccessControlSections]::Group
$security = [IO.File]::GetAccessControl($env:PICO_TEST_PATH, $sections)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$accessSddl = $security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$accessDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($accessSddl)
$autoInheritedFlag = [int] [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
$comparableFlags = ([int] $accessDescriptor.ControlFlags) -band (-bnot $autoInheritedFlag)
$accessAcl = $accessDescriptor.DiscretionaryAcl
if ($null -eq $accessAcl) {
  $accessAclKey = 'NULL'
} else {
  $accessAclBytes = [byte[]]::new($accessAcl.BinaryLength)
  $accessAcl.GetBinaryForm($accessAclBytes, 0)
  $accessAclKey = [Convert]::ToBase64String($accessAclBytes)
}
$accessKey = ([string] $comparableFlags) + '|' + $accessAclKey
$rules = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    rights = [int]$_.FileSystemRights
    inherited = $_.IsInherited
  }
})
[pscustomobject]@{
  protected = $security.AreAccessRulesProtected
  accessKey = $accessKey
  rules = $rules
  sddl = $security.GetSecurityDescriptorSddlForm($sections)
  currentSid = $currentSid
  ownerSid = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
  groupSid = $security.GetGroup([Security.Principal.SecurityIdentifier]).Value
} | ConvertTo-Json -Compress -Depth 4
`,
    { PICO_TEST_PATH: path },
  );
  return JSON.parse(output) as AccessSnapshot;
}

function assertPrivateAccess(snapshot: AccessSnapshot): void {
  assert.equal(snapshot.protected, true);
  assert.equal(snapshot.rules.length, 1);
  const [rule] = snapshot.rules;
  assert.ok(rule);
  assert.equal(rule.sid, snapshot.currentSid);
  assert.equal(rule.type, "Allow");
  assert.equal(rule.rights, 2_032_127);
  assert.equal(rule.inherited, false);
}

async function assertNoTemporaryFiles(directory: string): Promise<void> {
  const entries = await readdir(directory);
  assert.deepEqual(
    entries.filter((entry) => TEMPORARY_PREFIXES.some((prefix) => entry.startsWith(prefix))),
    [],
  );
}

async function runPowerShell(
  script: string,
  environment: Readonly<Record<string, string>>,
  timeoutMilliseconds = 15_000,
): Promise<string> {
  const child = spawnPowerShell(script, environment);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end();
  const exitCode = await waitForExit(child, timeoutMilliseconds);
  if (exitCode !== 0) {
    throw new Error(
      `PowerShell test helper failed (${String(exitCode)}): stdout=${stdout}; stderr=${stderr}`,
    );
  }
  return stdout.trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function spawnPowerShell(
  script: string,
  environment: Readonly<Record<string, string>>,
): ChildProcessWithoutNullStreams {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...environment };
  for (const name of Object.keys(childEnvironment)) {
    if (name.toLocaleLowerCase("en-US") === "psmodulepath") delete childEnvironment[name];
  }
  childEnvironment.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  return spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: join(systemRoot, "System32"),
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  let output = "";
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      child.stdin.end();
      child.kill("SIGKILL");
      reject(new Error(`PowerShell holder did not emit ${JSON.stringify(expected)}`));
    }, 10_000);
    const onData = (chunk: string): void => {
      output += chunk;
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`PowerShell holder exited before readiness (${String(code)})`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds = 15_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      child.stdin.end();
      child.kill("SIGKILL");
      reject(new Error(`PowerShell test helper exceeded ${timeoutMilliseconds}ms`));
    }, timeoutMilliseconds);
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      resolve(code);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end("\n");
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000).catch(() => undefined);
  }
}
