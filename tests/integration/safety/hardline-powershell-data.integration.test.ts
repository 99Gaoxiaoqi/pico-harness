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
    ["Remove-Item -Recurse -Force 'C:\\Windows'", "protected_destination"],
    ['Remove-Item "C:\\Program Files\\pico"', "protected_destination"],
    ["Remove-Item -Path 'C:\\Users\\*'", "protected_destination"],
    ["Remove-Item -LiteralPath:'C:\\Windows\\pico'", "protected_destination"],
    ["rm -rf /", "protected_destination"],
    ["git push '--force' origin main", "destructive_git"],
    ["git.exe push -f origin main", "destructive_git"],
    ["git push --force-with-lease=main:abc origin main", "destructive_git"],
    ["Write-Output 'Stop-Computer'; Stop-Computer", "destructive_system"],
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
