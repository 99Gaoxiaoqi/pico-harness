import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryManager } from "@pico/runtime/recovery";

test("RecoveryManager 为文件不存在注入与宿主方言一致的指导", () => {
  const posix = new RecoveryManager();
  const powershell = new RecoveryManager({ shellDialect: () => "powershell" });

  assert.match(
    posix.analyzeAndInject("read_file", "ENOENT: no such file or directory"),
    /find \. -name/u,
  );
  assert.match(
    powershell.analyzeAndInject("read_file", "ENOENT: no such file or directory"),
    /Get-ChildItem/u,
  );
});

test("RecoveryManager 保留未知错误原文，并为 bash 超时提供恢复路线", () => {
  const manager = new RecoveryManager();
  assert.equal(manager.analyzeAndInject("read_file", "custom failure"), "custom failure");
  assert.match(manager.analyzeAndInject("bash", "command timed out"), /background 参数/u);
});
