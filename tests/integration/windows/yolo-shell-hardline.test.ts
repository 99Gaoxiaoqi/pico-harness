import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { classifyHardlineCommand } from "../../../src/approval/manager.js";
import { classifyPowerShellCommand } from "../../../src/approval/powershell-safety.js";
import {
  hasSupportedHostShell,
  hostShellDialect,
  resetShellCache,
  resolveShell,
  SHELL_PATH_ENV,
  shellCommandArgs,
} from "../../../src/os/shell.js";

// Windows 宿主方言为 PowerShell:本文件锁定 PowerShell 宿主的
// 解析、argv、确定性静态红线与只读分类契约。bash hardline 语义回归在 POSIX
// 侧由 tests/integration/yolo-safety.integration.test.ts 覆盖。

test(
  "Windows 宿主解析为 PowerShell 且 argv 按方言生成",
  { skip: process.platform !== "win32" },
  () => {
    resetShellCache();
    const shell = resolveShell();
    assert.match(shell.toLowerCase(), /(?:pwsh|powershell)\.exe$/u);
    assert.equal(hostShellDialect(), "powershell");
    assert.equal(hasSupportedHostShell(), true);
    assert.deepEqual(shellCommandArgs(shell, "Get-ChildItem"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-ChildItem",
    ]);

    // 真跑一次验证 argv 形状在真实 PowerShell 下可执行
    const execution = spawnSync(shell, shellCommandArgs(shell, "Write-Output pico-ok"), {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /pico-ok/u);
  },
);

test(
  "PowerShell 宿主在 YOLO 下仍拒绝确定性系统破坏",
  { skip: process.platform !== "win32" },
  () => {
    resetShellCache();
    const dangerous = [
      "Remove-Item -Recurse -Force C:\\Windows\\System32",
      "Format-Volume -DriveLetter C",
      "Stop-Process -Name wininit -Force",
      "rm -rf /",
    ];
    for (const command of dangerous) {
      assert.equal(
        classifyHardlineCommand("bash", JSON.stringify({ command }), process.cwd()),
        command.startsWith("Remove-Item") || command === "rm -rf /"
          ? "protected_destination"
          : "destructive_system",
        command,
      );
    }
  },
);

test("PowerShell 只读分类:白名单 cmdlet 放行,写操作与动态语法需审批", () => {
  const readOnly = [
    "Get-ChildItem",
    "Get-ChildItem | Measure-Object",
    "ls; cat package.json",
    "Get-Content README.md -Tail 20",
    "Test-Path C:\\work",
    "Get-Process | Sort-Object CPU | Select-Object -First 5",
    "git rev-parse HEAD",
    "git ls-files",
    "Write-Output done",
    "pwd",
  ];
  for (const command of readOnly) {
    assert.equal(classifyPowerShellCommand(command).kind, "read-only", command);
  }

  const requiresApproval = [
    "Remove-Item -Recurse -Force .\\dist",
    "Set-Content notes.txt 'x'",
    "New-Item -ItemType File log.txt",
    "npm install",
    "$x = Get-Date",
    "Get-Content (Get-ChildItem)",
    "Get-ChildItem > out.txt",
    "Invoke-Expression 'Remove-Item C:\\'",
    "echo `typo",
    "git push --force origin main",
    "& 'C:\\tools\\payload.exe'",
    "Get-Content {$a}",
  ];
  for (const command of requiresApproval) {
    assert.equal(classifyPowerShellCommand(command).kind, "requires-approval", command);
  }
});

test(
  "PICO_SHELL_PATH 指向不支持的 shell 时 fail closed",
  { skip: process.platform !== "win32" },
  () => {
    const previousOverride = process.env[SHELL_PATH_ENV];
    const commandShell = process.env.ComSpec;
    assert.ok(commandShell, "Windows 必须提供 ComSpec 以验证不支持的 override");

    try {
      process.env[SHELL_PATH_ENV] = commandShell;
      resetShellCache();
      assert.throws(() => resolveShell(), /必须指向 bash\/sh 或 pwsh\/powershell/u);
    } finally {
      if (previousOverride === undefined) {
        delete process.env[SHELL_PATH_ENV];
      } else {
        process.env[SHELL_PATH_ENV] = previousOverride;
      }
      resetShellCache();
    }
  },
);
