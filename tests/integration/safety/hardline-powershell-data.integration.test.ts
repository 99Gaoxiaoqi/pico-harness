import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  analyzePowerShellHardlineCommand,
  classifyPowerShellCommand,
  classifyPowerShellHardlineCommand,
} from "../../../packages/runtime/src/powershell-safety.ts";
import { resolveShell, shellCommandArgs } from "../../../packages/runtime/src/host-shell.ts";

test("PowerShell Hardline 区分命令执行与字符串、注释中的危险关键词", () => {
  const dataCommands = [
    "Write-Output Stop-Computer",
    "Write-Output 'Stop-Computer'",
    'Write-Output "Stop-Computer"',
    "Write-Output 'git push --force'",
    "Write-Output 'Remove-Item -Recurse C:\\Windows'",
    "Write-Output 'don''t; Stop-Computer'",
    "Write-Output 'Invoke-Expression'",
    "Write-Output 'Stop-Computer' | Measure-Object",
    "Write-Output 'git push --force'; Get-Date",
    "Write-Output 'safe && Stop-Computer || Stop-Computer'",
    "Write-Output '<# data #> Stop-Computer'",
  ];
  for (const command of dataCommands) {
    assert.deepEqual(analyzePowerShellHardlineCommand(command), { kind: "no_match" }, command);
    assert.equal(classifyPowerShellHardlineCommand(command), undefined, command);
    assert.equal(classifyPowerShellCommand(command).kind, "read-only", command);
  }

  const unsupportedData = [
    "Get-Content ./log # Stop-Computer; git push --force",
    "Get-Content ./log <# Stop-Computer; git push --force; #>",
    "Get-Content ./log <# <# Stop-Computer; #> git push --force; #>",
    "'Stop-Computer'",
    "'Stop-Computer' -Force",
    "& 'Stop-Computer'",
    "$cmd Stop-Computer",
    'Write-Output "$cmd; Stop-Computer"',
    'Write-Output "safe`"; Stop-Computer"',
    "Write-Output `; Stop-Computer",
    "$block = { Write-Output safe; Stop-Computer; }; Get-Date",
    "Write-Output @('safe'; 'Stop-Computer'); Get-Date",
    "Write-Output @'\nit's data\nStop-Computer\n'@",
    'Write-Output "$(Write-Output "safe; Stop-Computer")"',
    "Remove-Item C:\\Windows$Suffix",
    "Stop-Computer$Suffix",
    "Write-Output safe && Get-Date",
    "Write-Output safe || Get-Date",
    "Write-Output safe && 'Stop-Computer'",
    "Write-Output safe; <# Stop-Computer; #> Get-Date",
    "Write-Output <# Stop-Computer; #> Stop-Computer",
    "Write-Output $x <# data #> Stop-Computer",
    "Stop-Process -Name safe <# data #> 'lsass' -Force",
    "Stop-Process -Name safe <# data #>, 'safe,lsass' -Force",
    "Stop-Process -Name safe <# lsass #>,other -Force",
    "git push --force, <# data #> origin main",
  ];
  for (const command of unsupportedData) {
    assert.deepEqual(
      analyzePowerShellHardlineCommand(command),
      { kind: "unknown", reasonKind: "unknown_hardline" },
      command,
    );
    assert.equal(classifyPowerShellHardlineCommand(command), undefined, command);
  }
  for (const command of ["Invoke-Expression 'Stop-Computer'", "pwsh -EncodedCommand YWJj"]) {
    assert.deepEqual(
      analyzePowerShellHardlineCommand(command),
      { kind: "unknown", reasonKind: "opaque_shell" },
      command,
    );
    assert.equal(classifyPowerShellHardlineCommand(command), undefined, command);
  }
});

test("PowerShell Hardline 保留 quoted target、命令边界和 unknown 后明确 deny", () => {
  const dangerous = [
    ["Stop-Computer", "destructive_system"],
    ["Format-Volume -DriveLetter C", "destructive_system"],
    ["Stop-Process -Name 'lsass' -Force", "destructive_system"],
    ["Stop-Process -Name:wininit -Force", "destructive_system"],
    ["Stop-Process -Name lsass,csrss -Force", "destructive_system"],
    ["Stop-Process -Name safe,csrss -Force", "destructive_system"],
    ["Stop-Process -Name:safe,lsass -Force", "destructive_system"],
    ["Stop-Process -Name 'safe', 'lsass' -Force", "destructive_system"],
    ["Stop-Process -Name safe <# data #>,lsass -Force", "destructive_system"],
    ["Stop-Process -Name safe, <# data #> lsass -Force", "destructive_system"],
    ["Stop-Process -Name 'safe' <# data #>, 'lsass' -Force", "destructive_system"],
    ["Microsoft.PowerShell.Management\\Stop-Process -Name safe,lsass -Force", "destructive_system"],
    ["Remove-Item -Recurse -Force 'C:\\Windows'", "protected_destination"],
    ['Remove-Item "C:\\Program Files\\pico"', "protected_destination"],
    ["Remove-Item -Path 'C:\\Users\\*'", "protected_destination"],
    ["Remove-Item -LiteralPath:'C:\\Windows\\pico'", "protected_destination"],
    ["Remove-Item -Path C:\\safe,C:\\Windows\\pico -Recurse", "protected_destination"],
    ["Remove-Item -Path 'C:\\safe' , 'C:\\Windows\\pico'", "protected_destination"],
    ["Remove-Item -LiteralPath:C:\\safe,C:\\Windows\\pico", "protected_destination"],
    [
      "Microsoft.PowerShell.Management\\Remove-Item -Path C:\\safe,C:\\Windows\\pico -Recurse",
      "protected_destination",
    ],
    ["rm -rf /", "protected_destination"],
    ["git push '--force' origin main", "destructive_git"],
    ["git.exe push -f origin main", "destructive_git"],
    ["git push --force-with-lease=main:abc origin main", "destructive_git"],
    ["Write-Output 'Stop-Computer'; Stop-Computer", "destructive_system"],
    ["Write-Output safe && Stop-Computer", "destructive_system"],
    ["Write-Output safe || Stop-Computer", "destructive_system"],
    ["Write-Output safe; <# data #> Stop-Computer", "destructive_system"],
    ["Write-Output $x && Stop-Computer", "destructive_system"],
    ["Write-Output $x || Stop-Computer", "destructive_system"],
    ["Write-Output $x; <# data #> Stop-Computer", "destructive_system"],
    ["Get-Date | Stop-Computer", "destructive_system"],
    ["Write-Output $x; Remove-Item 'C:\\Windows'", "protected_destination"],
    ['Write-Output "$x; Stop-Computer"; git push --force', "destructive_git"],
    ["Get-Content ./log # Stop-Computer\nStop-Computer", "destructive_system"],
    ["Get-Content ./log <# Stop-Computer; #>; Stop-Computer", "destructive_system"],
    ["Write-Output { 'safe'; 'Stop-Computer'; }; Stop-Computer", "destructive_system"],
    ["Write-Output @('safe'; 'Stop-Computer'); git push --force", "destructive_git"],
    ["& 'unsupported'; Stop-Computer", "destructive_system"],
    ["Invoke-Expression 'Write-Output safe'; Stop-Computer", "destructive_system"],
    ["Write-Output $x | Stop-Computer", "destructive_system"],
    ["Stop-Computer $arguments", "destructive_system"],
    ["Remove-Item 'C:\\Windows' $arguments", "protected_destination"],
  ] as const;
  for (const [command, reasonKind] of dangerous) {
    // 危险语句只做静态分类，绝不交给真实 shell 执行。
    assert.deepEqual(
      analyzePowerShellHardlineCommand(command),
      { kind: "deny", reasonKind },
      command,
    );
    assert.equal(classifyPowerShellHardlineCommand(command), reasonKind, command);
    assert.equal(classifyPowerShellCommand(command).kind, "requires-approval", command);
  }
});

test("PowerShell Hardline 不把引用逗号数据或 native argv 拆成 cmdlet 数组", () => {
  for (const command of [
    "Stop-Process -Name 'lsass,csrss' -Force",
    'Stop-Process -Name "safe,lsass" -Force',
    "Stop-Process -Name safe,other -Force",
    "Remove-Item -Path 'C:\\safe,C:\\Windows\\pico' -Recurse",
    'Remove-Item -Path "C:\\safe,C:\\Windows\\pico" -Recurse',
    "Remove-Item -Path C:\\safe,C:\\other -Recurse",
    "git push --force,origin main",
    "git push '--force,origin' main",
    "C:\\tools\\git.exe push --force,origin main",
  ]) {
    // 包含危险文字的参数也只做静态分类，不执行进程或文件操作。
    assert.deepEqual(analyzePowerShellHardlineCommand(command), { kind: "no_match" }, command);
    assert.equal(classifyPowerShellHardlineCommand(command), undefined, command);
  }
});

test(
  "Windows PowerShell 真执行危险关键词字符串时只打印数据",
  { skip: process.platform !== "win32" },
  () => {
    const shell = resolveShell();
    const command = "Write-Output 'Stop-Computer'; Write-Output 'git push --force'";
    assert.deepEqual(analyzePowerShellHardlineCommand(command), { kind: "no_match" });
    const result = spawnSync(shell, shellCommandArgs(shell, command), {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Stop-Computer/u);
    assert.match(result.stdout, /git push --force/u);
  },
);
