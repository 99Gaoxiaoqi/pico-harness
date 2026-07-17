import assert from "node:assert/strict";
import { test } from "node:test";
import { isHardlineCommand } from "../../../src/approval/manager.js";
import { resetShellCache, resolveShell, SHELL_PATH_ENV } from "../../../src/os/shell.js";
import { buildForegroundSafetyMiddleware } from "../../../src/runtime/agent-runtime.js";

test(
  "Windows 非 Bash override 在 YOLO 安全门与 resolver 双重 fail closed",
  { skip: process.platform !== "win32" },
  async () => {
    const previousOverride = process.env[SHELL_PATH_ENV];
    const commandShell = process.env.ComSpec;
    assert.ok(commandShell, "Windows 必须提供 ComSpec 以验证非 Bash override");

    try {
      process.env[SHELL_PATH_ENV] = commandShell;
      resetShellCache();

      const safety = buildForegroundSafetyMiddleware(process.cwd(), { mode: "yolo" });
      const dangerousCommands = [
        "del /f /s C:\\Windows\\System32\\config\\SAM",
        "format C:",
        "rd /s /q C:\\Windows\\System32",
        "Remove-Item -Recurse -Force C:\\Windows\\System32",
      ];
      for (const command of dangerousCommands) {
        const dangerousCall = toolCall(command);
        assert.equal(isHardlineCommand(dangerousCall.name, dangerousCall.arguments), true, command);
        assert.equal((await safety(dangerousCall)).allowed, false, command);
      }
      assert.throws(() => resolveShell(), new RegExp(`${SHELL_PATH_ENV} 必须指向 bash`, "u"));
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

function toolCall(command: string) {
  return {
    id: command,
    name: "bash",
    arguments: JSON.stringify({ command }),
  };
}
