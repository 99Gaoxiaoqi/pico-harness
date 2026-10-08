import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolCall } from "@pico/core";
import { analyzeHardlineCommand } from "@pico/runtime/approval-policy";
import { initializeBashParser } from "@pico/runtime/bash-hardline";
import { hostShellDialect } from "@pico/runtime/host-shell";
import { analyzePowerShellHardlineCommand } from "@pico/runtime/powershell-safety";
import {
  buildForegroundSafetyMiddleware,
  buildPermissionMiddleware,
  type RuntimePolicyDenial,
} from "@pico/pico-host/agent-runtime";
import { BashTool } from "@pico/pico-host/bash-tool";
import { ApprovalManager, type ApprovalNotice } from "@pico/pico-host/global-approval-manager";
import { managedProcessLauncher } from "@pico/pico-host/process-sandbox";
import { globalSessionManager } from "@pico/pico-host/session";
import { globalSessionPermissionGrants } from "@pico/pico-host/session-permissions";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

const MODES = ["ask", "auto", "full-access"] as const;
type PermissionMode = (typeof MODES)[number];
const FAKE_LAUNCH = "ADVERSARIAL_REGRESSION_FAKE_LAUNCH";

const BASH_DENY_CASES = [
  ["heredoc 头部 && 右侧删除", "cat <<EOF && rm -rf /\ndata\nEOF"],
  ["heredoc 头部 || 右侧删除", "cat <<EOF || rm -rf /\ndata\nEOF"],
  ["heredoc 头部管道右侧关机", "cat <<EOF | shutdown now\ndata\nEOF"],
  ["heredoc 头部右侧保护路径重定向", "cat <<EOF && printf x > /etc/passwd\ndata\nEOF"],
  ["quoted heredoc 头部右侧的命令替换仍执行", "cat <<'EOF' && echo \"$(rm -rf /)\"\ndata\nEOF"],
  ["heredoc 管道左侧 shell 的 stdin 仍检查", "bash <<'EOF' | cat\nrm -rf /\nEOF"],
  [
    "heredoc 覆盖前置 stdin 重定向后仍检查",
    "bash < /dev/null <<'EOF' && printf safe\nrm -rf /\nEOF",
  ],
  ["非 stdin 重定向不能覆盖 heredoc", "bash <<'EOF' 2< /dev/null && printf safe\nrm -rf /\nEOF"],
  ["stdin 自复制不能覆盖 heredoc", "bash <<'EOF' <&0 && printf safe\nrm -rf /\nEOF"],
  [
    "stdin 被覆盖后未引用 heredoc 的命令替换仍执行",
    "bash <<EOF < /dev/null && printf safe\n$(rm -rf /)\nEOF",
  ],
  [
    "heredoc 管道后的 && 在父 shell 更新 cwd",
    "cat <<EOF | printf safe && cd /etc\ndata\nEOF\nprintf x > passwd",
  ],
  ["heredoc 续行前的危险命令", "rm -rf /; cat <<EOF\nhello\\\nworld\nEOF"],
  ["heredoc 续行后的危险命令", "cat <<EOF\nhello\\\nworld\nEOF\nrm -rf /"],
  ["heredoc 双反斜线数据不能清空前序危险命令", "rm -rf /; cat <<EOF\nhello\\\\\nworld\nEOF"],
  ["续行形成 delimiter 后的命令仍执行", "cat <<EOF\nE\\\nOF\nrm -rf /\nEOF"],
  ["后台赋值不能覆盖父 shell 保护目标", 'p=/etc; p=./safe & printf x > "$p/passwd"'],
  [
    "后台 AND/OR list 不能覆盖父 shell 保护目标",
    'p=/etc; true && p=./safe & printf x > "$p/passwd"',
  ],
] as const;

const BASH_UNKNOWN_CASES = [
  [
    "后置 stdin 重定向覆盖 quoted heredoc",
    "bash <<'EOF' < /dev/null && printf safe\nrm -rf /\nEOF",
  ],
  [
    "stdin 重定向按最后一次写入决定 heredoc 是否执行",
    "bash < /dev/null <<'EOF' 0< /dev/null && printf safe\nrm -rf /\nEOF",
  ],
] as const;

const BASH_SAFE_CASES = [
  ["quoted heredoc 的危险命令只是数据", "cat <<'EOF'\nrm -rf /\nshutdown now\nEOF"],
  ["quoted heredoc 的续行只是数据", "cat <<'EOF'\nhello\\\nworld\nEOF"],
  ["后台保护路径赋值不能覆盖父 shell 安全目标", 'p=./safe; p=/etc & printf x > "$p/passwd"'],
  ["后台 cd 不能改变父 shell 工作目录", "cd /etc & printf x > ./local"],
  ["heredoc 管道左侧 cd 不能改变右侧工作目录", "cd /etc <<EOF | printf x > ./local\ndata\nEOF"],
  [
    "heredoc 管道右侧 cd 不能改变之后 && 的工作目录",
    "cat <<EOF | cd /etc && printf x > ./local\ndata\nEOF",
  ],
] as const;

const POWERSHELL_DENY_CASES = [
  ["&& 右侧危险命令", "Write-Output safe && Stop-Computer"],
  ["|| 右侧危险命令", "Write-Output safe || Stop-Computer"],
  ["块注释之后的危险命令", "Write-Output safe; <# data #> Stop-Computer"],
  ["关键进程名称数组", "Stop-Process -Name lsass,csrss -Force"],
  ["数组逗号之前插入块注释", "Stop-Process -Name safe <# data #>,lsass -Force"],
  ["数组逗号之后插入块注释", "Stop-Process -Name safe, <# data #> lsass -Force"],
  ["引用数组元素之间插入块注释", "Stop-Process -Name 'safe' <# data #>, 'lsass' -Force"],
  ["保护目标路径数组", String.raw`Remove-Item -Path C:\safe,C:\Windows\pico -Recurse`],
] as const;

const POWERSHELL_SAFE_CASES = [
  ["quoted 危险命令只是字符串", "Write-Output 'Stop-Computer'"],
  ["quoted comma 是单个进程名字", "Stop-Process -Name 'lsass,csrss'"],
  [
    "quoted comma 是单个非保护路径",
    String.raw`Remove-Item -Path 'C:\safe,C:\Windows\pico' -Recurse`,
  ],
] as const;

function bashCall(command: string): ToolCall {
  return { id: "adversarial-bash", name: "bash", arguments: JSON.stringify({ command }) };
}

async function fixture(t: TestContext) {
  // macOS tmpdir() 位于 /var/folders，会让保护路径规则遮蔽后台赋值漏拦。
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = await mkdtemp(join(tempRoot, "pico-hardline-adversarial-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  const sessionId = basename(root);
  await mkdir(workDir);
  const workspaceRoots = await WorkspaceRoots.create(workDir);
  t.after(async () => {
    globalSessionPermissionGrants.clear(sessionId, workDir, picoHome);
    const session = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  });
  return { workDir, picoHome, sessionId, workspaceRoots };
}

async function dispatchFixture(t: TestContext, mode: PermissionMode) {
  const scene = await fixture(t);
  const notices: ApprovalNotice[] = [];
  const denials: RuntimePolicyDenial[] = [];
  const counts = { launches: 0, dispatches: 0 };
  const manager = new ApprovalManager(5_000);
  // 即使回归导致危险样例漏拦，也只到达这个替身，绝不启动真实 shell。
  t.mock.method(managedProcessLauncher, "launch", () => {
    counts.launches++;
    throw new Error(FAKE_LAUNCH);
  });
  const registry = new ToolRegistry();
  registry.register(new BashTool(scene.workDir));
  registry.useSafety(
    buildForegroundSafetyMiddleware(scene.workDir, undefined, scene.workspaceRoots, (event) =>
      denials.push(event),
    ),
  );
  registry.usePermission(
    buildPermissionMiddleware(
      (notice) => {
        notices.push(notice);
        manager.resolveApprovalForSession(notice.taskId, "fixture session approval");
      },
      scene.workDir,
      undefined,
      manager,
      { sessionId: scene.sessionId, permissionMode: mode, additionalDirectories: [] },
      scene.workspaceRoots,
      undefined,
      scene.picoHome,
      (event) => denials.push(event),
      undefined,
      { getToolPermissionCategory: (name) => registry.getPermissionCategory(name) },
    ),
  );
  return {
    ...scene,
    notices,
    denials,
    counts,
    manager,
    execute: (command: string) =>
      registry.execute(bashCall(command), {
        beforeDispatch: async () => {
          counts.dispatches++;
        },
      }),
  };
}

async function assertDeniedBeforeDispatch(t: TestContext, command: string, mode: PermissionMode) {
  const scene = await dispatchFixture(t, mode);
  const result = await scene.execute(command);
  assert.deepEqual(
    { ...scene.counts, approvals: scene.notices.length },
    { launches: 0, dispatches: 0, approvals: 0 },
    "明确 deny 必须在审批、beforeDispatch 与 managed launch 之前拒绝",
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /Hardline/u);
  assert.equal(
    analyzeHardlineCommand("bash", bashCall(command).arguments, scene.workDir).kind,
    "deny",
  );
  assert.equal(scene.denials.length, 1);
  assert.equal(scene.denials[0]?.source, "safety");
  assert.equal(scene.denials[0]?.code, "hardline");
  assert.equal(scene.manager.pendingCount, 0);
}

test(
  "Bash 对抗样例在实际 Registry 权限链三种模式均拒绝",
  { skip: process.platform === "win32" },
  async (t) => {
    await initializeBashParser();
    for (const mode of MODES) {
      await t.test(mode, async (t) => {
        for (const [name, command] of BASH_DENY_CASES) {
          await t.test(name, (t) => assertDeniedBeforeDispatch(t, command, mode));
        }
        for (const [cases, kind] of [
          [BASH_SAFE_CASES, "no_match"],
          [BASH_UNKNOWN_CASES, "unknown"],
        ] as const) {
          for (const [name, command] of cases) {
            await t.test(name, async (t) => {
              const scene = await dispatchFixture(t, mode);
              assert.equal(
                analyzeHardlineCommand("bash", bashCall(command).arguments, scene.workDir).kind,
                kind,
              );
              const result = await scene.execute(command);
              assert.equal(result.isError, false);
              assert.match(result.output, new RegExp(FAKE_LAUNCH));
              assert.deepEqual(scene.counts, { launches: 1, dispatches: 1 });
              assert.deepEqual(scene.denials, []);
              assert.equal(scene.manager.pendingCount, 0);
              if (mode === "full-access") assert.deepEqual(scene.notices, []);
            });
          }
        }
      });
    }
  },
);

test(
  "无害 Bash 替身确认 heredoc 与后台赋值的真实 shell 语义",
  { skip: process.platform === "win32" },
  async (t) => {
    const scene = await fixture(t);
    const run = (command: string) => {
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd: scene.workDir,
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    // 仅执行 printf/cat；危险命令在 quoted heredoc 内只作为数据打印。
    assert.equal(run("cat <<EOF && printf right\ndata\nEOF"), "data\nright");
    assert.equal(
      run("printf before; cat <<EOF\nhello\\\nworld\nEOF\nprintf after"),
      "beforehelloworld\nafter",
    );
    assert.equal(run(BASH_SAFE_CASES[0][1]), "rm -rf /\nshutdown now\n");
    assert.equal(run("bash <<'EOF' < /dev/null && printf safe\nprintf BODY_EXECUTED\nEOF"), "safe");
    assert.equal(
      run("bash < /dev/null <<'EOF' && printf safe\nprintf BODY_EXECUTED\nEOF"),
      "BODY_EXECUTEDsafe",
    );
    // 用输出变量代替路径写入，确认后台赋值从不改父 shell。
    assert.equal(run('p=protected; p=safe & printf "%s" "$p"; wait'), "protected");
    assert.equal(run('p=safe; p=protected & printf "%s" "$p"; wait'), "safe");
  },
);

test("PowerShell 边界恢复与数组红线在所有平台静态验证", async (t) => {
  for (const [name, command] of POWERSHELL_DENY_CASES) {
    await t.test(name, () => {
      assert.equal(analyzePowerShellHardlineCommand(command).kind, "deny");
    });
  }
  for (const [name, command] of POWERSHELL_SAFE_CASES) {
    await t.test(name, () => {
      assert.notEqual(analyzePowerShellHardlineCommand(command).kind, "deny");
    });
  }
});

test(
  "原生 Windows PowerShell Registry 三种模式均在派发前拒绝",
  { skip: process.platform !== "win32" },
  async (t) => {
    assert.equal(hostShellDialect(), "powershell", "仅原生 Windows 宿主验证 PowerShell dispatcher");
    for (const mode of MODES) {
      await t.test(mode, async (t) => {
        for (const [name, command] of POWERSHELL_DENY_CASES) {
          await t.test(name, (t) => assertDeniedBeforeDispatch(t, command, mode));
        }
      });
    }
  },
);
