import assert from "node:assert/strict";
import { test } from "node:test";
import { isHardlineCommand } from "../../src/approval/manager.js";
import { buildForegroundSafetyMiddleware } from "../../src/runtime/agent-runtime.js";
import { evaluateYoloToolCall } from "../../src/safety/yolo-sandbox.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";

test("YOLO hardline 覆盖 rm 等价参数、系统目标与 shell 组合", async () => {
  const workDir = process.cwd();
  const dangerous = [
    "rm -rf -- /",
    "rm --force --recursive /",
    "rm --recursive --force -- '/etc/ssh'",
    'rm "--force" "--recursive" "$HOME"',
    "rm -R -f '~'",
    'printf ok && "rm" "-fr" "/usr"',
    "echo ok; /bin/rm --recursive --force /boot",
    "bash -c 'rm --force --recursive -- /'",
    "echo $(rm -rf /)",
    "rm $FLAGS /",
    "rm $(printf %s -rf) /",
    "exec rm -rf /",
    "busybox rm --force --recursive /etc",
    "sudo bash -lc 'rm --force --recursive /'",
    "{ rm -rf /; }",
    "(rm -rf /)",
    "if true; then rm -rf /; fi",
    "! rm -rf /",
    "while true; do rm -rf /; done",
    "until false; do rm -rf /; done",
    "if false; then :; elif true; then rm -rf /; fi",
    "if false; then :; else rm -rf /; fi",
    "case x in x) rm -rf /;; esac",
    "coproc rm -rf /",
    "rm -rf /Users/alice/*",
    "rm -rf /home/alice/{*,.*}",
    "rm -rf C:/Users/Alice/*",
    "rm -rf /c/Users/Alice/{*,.*}",
    'rm -rf "$UNKNOWN_TARGET"',
    "rm -rf '/etc",
  ];

  for (const command of dangerous) {
    assert.equal(isHardlineCommand("bash", bashArgs(command)), true, command);
  }

  const ordinaryWorkspaceDeletes = [
    "rm -rf ./dist",
    "rm --recursive --force -- './tmp/cache'",
    "rm -R -f packages/generated",
    "rm -rf /tmp/pico-cache",
    "rm -rf /Users/alice/project/dist",
    "rm -rf /home/alice/project/dist",
    "rm -rf C:/Users/Alice/project/dist",
    `rm --recursive --force -- ${JSON.stringify(`${workDir}/tmp/generated`)}`,
    "printf '%s\\n' 'rm -rf /'",
    '"then" rm -rf /',
    'echo "(rm -rf /)"',
  ];
  for (const command of ordinaryWorkspaceDeletes) {
    assert.equal(isHardlineCommand("bash", bashArgs(command)), false, command);
  }

  assert.equal(isHardlineCommand("write_file", bashArgs("rm -rf /")), false);

  const roots = WorkspaceRoots.createSync(workDir);
  const hardlineCall = toolCall("rm --recursive --force -- /");
  const ordinaryCall = toolCall("rm --recursive --force -- ./dist");
  const sandboxDecision = evaluateYoloToolCall(hardlineCall, workDir, roots);
  assert.equal(sandboxDecision.allowed, false);
  assert.match(sandboxDecision.reason ?? "", /Hardline/u);
  assert.equal(evaluateYoloToolCall(ordinaryCall, workDir, roots).allowed, true);

  const foregroundSafety = buildForegroundSafetyMiddleware(workDir, { mode: "yolo" }, roots);
  assert.equal((await foregroundSafety(hardlineCall)).allowed, false);
  assert.equal((await foregroundSafety(ordinaryCall)).allowed, true);
});

function bashArgs(command: string): string {
  return JSON.stringify({ command });
}

function toolCall(command: string) {
  return { id: command, name: "bash", arguments: bashArgs(command) };
}
