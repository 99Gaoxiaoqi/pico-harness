import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { LLMProvider, ToolCall } from "@pico/core";
import { analyzeHardlineCommand } from "@pico/runtime/approval-policy";
import { initializeBashParser } from "@pico/runtime/bash-hardline";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import {
  buildForegroundSafetyMiddleware,
  buildPermissionMiddleware,
  executeAgentRuntime,
  type RuntimePolicyDenial,
} from "@pico/pico-host/agent-runtime";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  buildBackgroundAutonomousMiddleware,
  prepareBackgroundAutonomousPolicy,
  type BackgroundAutonomousPolicySnapshot,
  type PreparedBackgroundAutonomousPolicy,
} from "@pico/pico-host/background-autonomous-policy";
import { BashTool } from "@pico/pico-host/bash-tool";
import { buildChildAgentSafetyMiddleware } from "@pico/pico-host/child-agent-policy";
import { ApprovalManager, type ApprovalNotice } from "@pico/pico-host/global-approval-manager";
import { HookService } from "@pico/pico-host/hooks/service";
import {
  managedProcessLauncher,
  type ManagedLaunchOptions,
  type ManagedSpawnRequest,
} from "@pico/pico-host/process-sandbox";
import { globalSessionManager } from "@pico/pico-host/session";
import { globalSessionPermissionGrants } from "@pico/pico-host/session-permissions";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { evaluateWorkspaceToolCall } from "@pico/pico-host/workspace-sandbox";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

const UNKNOWN_COMMAND = "$PICO_HARDLINE_EXECUTABLE --version";
const DENY_COMMAND = "cp ./artifact /etc/PICO_HARDLINE_PRIVATE_CANARY";
const UNKNOWN_THEN_DENY_COMMAND = `${UNKNOWN_COMMAND}; ${DENY_COMMAND}`;
const ADVERSARIAL_DENY_COMMANDS = [
  String.raw`$'rm\0foo' -rf /etc`,
  "cat <<EOF\n\\\\$(rm -rf /)\nEOF",
  "unset X; cat <<EOF\n${X:-`rm -rf /`}\nEOF",
  "for i in 1 2; do rm -f passwd; cd /etc; done",
  "/usr/bin/time -o /etc/passwd /usr/bin/printf ok",
];
const FAKE_LAUNCH = "HARDLINE_FAKE_LAUNCH";

function bashCall(command: string, id = "bash-call"): ToolCall {
  return { id, name: "bash", arguments: JSON.stringify({ command }) };
}

async function fixture(t: TestContext, suffix: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-hardline-${suffix}-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  const sessionId = `hardline-${suffix}`;
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

function backgroundSnapshot(): BackgroundAutonomousPolicySnapshot {
  return {
    mode: "full-access",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy: "allow",
    allowedTools: ["bash"],
    hardlineVersion: BACKGROUND_HARDLINE_VERSION,
    hookVersion: BACKGROUND_HOOK_VERSION,
    createdAt: 1,
  };
}

test(
  "Host Hardline 三态沿既有权限链执行并保留拒绝边界",
  { skip: process.platform === "win32" },
  async (t) => {
    await initializeBashParser();

    await t.test(
      "unknown 在 ask/auto 请求审批、保留 session scope，full-access 无审批",
      async (t) => {
        for (const mode of ["ask", "auto", "full-access"] as const) {
          await t.test(mode, async (t) => {
            const scene = await fixture(t, mode);
            const call = bashCall(UNKNOWN_COMMAND);
            assert.equal(
              analyzeHardlineCommand("bash", call.arguments, scene.workDir).kind,
              "unknown",
            );
            const notices: ApprovalNotice[] = [];
            const denials: RuntimePolicyDenial[] = [];
            const manager = new ApprovalManager(5_000);
            let launches = 0;
            let dispatches = 0;
            t.mock.method(managedProcessLauncher, "launch", () => {
              launches++;
              throw new Error(FAKE_LAUNCH);
            });
            const registry = new ToolRegistry();
            registry.register(new BashTool(scene.workDir));
            registry.useSafety(
              buildForegroundSafetyMiddleware(
                scene.workDir,
                undefined,
                scene.workspaceRoots,
                (event) => denials.push(event),
              ),
            );
            const permission = buildPermissionMiddleware(
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
            );
            registry.usePermission(async (call, context) => {
              assert.equal(context?.forceApproval, false, "unknown 不得强制覆盖 session grant");
              return permission(call, context);
            });
            for (const id of ["first", "same-session"]) {
              const result = await registry.execute(
                { ...call, id },
                {
                  beforeDispatch: async () => {
                    dispatches++;
                  },
                },
              );
              assert.equal(result.isError, false);
              assert.match(result.output, new RegExp(FAKE_LAUNCH));
            }
            assert.equal(launches, 2, "BashTool 最后 guard 必须与前台三态分类一致");
            assert.equal(dispatches, 2);
            assert.equal(notices.length, mode === "full-access" ? 0 : 1);
            if (mode !== "full-access") {
              assert.deepEqual(notices[0]?.sessionScope, {
                type: "bash-command",
                command: UNKNOWN_COMMAND,
                match: "exact",
              });
            }
            assert.deepEqual(denials, [], "unknown 不产生 Hardline 拒绝审计");
            const mixed = await registry.execute(bashCall(UNKNOWN_THEN_DENY_COMMAND, "mixed"), {
              beforeDispatch: async () => {
                dispatches++;
              },
            });
            assert.equal(mixed.isError, true, "unknown 后的明确 deny 不得被已批准会话绕过");
            assert.match(mixed.output, /Hardline/u);
            assert.doesNotMatch(mixed.output, /PICO_HARDLINE_PRIVATE_CANARY/u);
            assert.equal(launches, 2);
            assert.equal(dispatches, 2);
            assert.equal(notices.length, mode === "full-access" ? 0 : 1);
            assert.deepEqual(denials, [
              {
                source: "safety",
                code: "hardline",
                reasonKind: "protected_destination",
                toolName: "bash",
              },
            ]);
            assert.equal(manager.pendingCount, 0);
          });
        }
      },
    );

    await t.test("缺省无交互 Host 将 unknown 交给权限链并安全拒绝", async (t) => {
      const scene = await fixture(t, "headless");
      const denials: RuntimePolicyDenial[] = [];
      const manager = new ApprovalManager(5_000);
      let bashLaunches = 0;
      let providerCalls = 0;
      const launch = managedProcessLauncher.launch.bind(managedProcessLauncher);
      t.mock.method(
        managedProcessLauncher,
        "launch",
        (request: ManagedSpawnRequest, options?: ManagedLaunchOptions) => {
          if (
            request.origin === "bash" ||
            request.origin === "background-bash" ||
            request.origin === "subagent"
          ) {
            bashLaunches++;
            throw new Error("无交互拒绝不得启动 Bash 进程");
          }
          // Runtime 初始化会启动代码索引 file-worker；它不属于模型 Bash 派发。
          return launch(request, options);
        },
      );
      const provider: LLMProvider = {
        async generate(messages) {
          providerCalls++;
          if (providerCalls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [bashCall(UNKNOWN_COMMAND, "headless-unknown")],
            };
          }
          const result = messages.findLast((message) => message.toolCallId === "headless-unknown");
          assert.match(result?.content ?? "", /未提供审批交互/u);
          return { role: "assistant", content: "approval refused" };
        },
      };
      const result = await executeAgentRuntime(
        {
          prompt: "Request the fixture Bash command.",
          dir: scene.workDir,
          sessionSelection: { mode: "new", sessionId: scene.sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          collaborationMode: "agent",
          permissionMode: "ask",
          allowedTools: ["bash"],
        },
        {
          picoHome: scene.picoHome,
          provider,
          reporter: new SilentReporter(),
          approvalManager: manager,
          onPolicyDenied: (event) => denials.push(event),
        },
      );
      assert.equal(result.finalMessage, "approval refused");
      assert.equal(providerCalls, 2);
      assert.equal(bashLaunches, 0, "无交互拒绝不得派发任何 Bash 进程");
      assert.equal(manager.pendingCount, 0);
      assert.deepEqual(denials, [
        { source: "permission", code: "approval", reasonKind: "approval_denied", toolName: "bash" },
      ]);
    });

    await t.test("明确 deny 先于 Hook，Hook 改写后复检均不派发且审计脱敏", async (t) => {
      const scene = await fixture(t, "deny");
      const denials: RuntimePolicyDenial[] = [];
      let hooks = 0;
      let launches = 0;
      let dispatches = 0;
      t.mock.method(managedProcessLauncher, "launch", () => {
        launches++;
        throw new Error("明确 deny 不得启动进程");
      });
      const registry = new ToolRegistry();
      registry.register(new BashTool(scene.workDir));
      registry.useSafety(
        buildForegroundSafetyMiddleware(scene.workDir, undefined, scene.workspaceRoots, (event) =>
          denials.push(event),
        ),
      );
      registry.setHookService(
        new HookService({
          workDir: scene.workDir,
          sessionId: scene.sessionId,
          executor: {
            async execute() {
              return { decision: "allow" };
            },
          },
          decisionProviders: [
            {
              evaluate(event) {
                if (event !== "PreToolUse") return { decision: "allow" };
                hooks++;
                return { decision: "allow", modifiedInput: { command: UNKNOWN_THEN_DENY_COMMAND } };
              },
            },
          ],
        }),
      );
      const analysis = analyzeHardlineCommand(
        "bash",
        bashCall(DENY_COMMAND).arguments,
        scene.workDir,
      );
      assert.equal(analysis.kind, "deny");
      const commands = [
        DENY_COMMAND,
        UNKNOWN_THEN_DENY_COMMAND,
        ...ADVERSARIAL_DENY_COMMANDS,
        "printf safe",
      ];
      for (const command of commands) {
        const result = await registry.execute(bashCall(command), {
          beforeDispatch: async () => {
            dispatches++;
          },
        });
        assert.equal(result.isError, true);
        assert.match(result.output, /Hardline/u);
        assert.doesNotMatch(result.output, /PICO_HARDLINE_PRIVATE_CANARY/u);
      }
      assert.equal(hooks, 1);
      assert.equal(dispatches, 0);
      assert.equal(launches, 0);
      assert.equal(denials.length, commands.length);
      for (const event of denials) {
        assert.deepEqual(event, {
          source: "safety",
          code: "hardline",
          reasonKind: analysis.reasonKind,
          toolName: "bash",
        });
      }
      assert.doesNotMatch(JSON.stringify(denials), /PICO_HARDLINE_PRIVATE_CANARY/u);
      for (const command of [
        DENY_COMMAND,
        UNKNOWN_THEN_DENY_COMMAND,
        ...ADVERSARIAL_DENY_COMMANDS,
      ]) {
        await assert.rejects(
          new BashTool(scene.workDir).execute(bashCall(command).arguments),
          /Hardline/u,
        );
      }
      assert.equal(launches, 0, "直接调用 BashTool 仍应守住最后执行边界");
    });

    await t.test("后台、工作区投影与子代理保留各自边界", async (t) => {
      const scene = await fixture(t, "background-child");
      const unknown = bashCall(UNKNOWN_COMMAND);
      const denied = bashCall(DENY_COMMAND);
      const mixed = bashCall(UNKNOWN_THEN_DENY_COMMAND);
      const policy: PreparedBackgroundAutonomousPolicy = {
        snapshot: backgroundSnapshot(),
        workspacePath: scene.workDir,
        allowedTools: new Set(["bash"]),
        allowedToolNetworkHosts: new Set(),
      };
      const input = { policy, workspaceRoots: scene.workspaceRoots, sessionId: scene.sessionId };
      const background = buildBackgroundAutonomousMiddleware(input);
      assert.equal((await background(unknown)).allowed, true);
      assert.match((await background(denied)).reason ?? "", /hardline_denied/u);
      assert.match((await background(mixed)).reason ?? "", /hardline_denied/u);
      assert.equal(
        evaluateWorkspaceToolCall(unknown, scene.workDir, scene.workspaceRoots).allowed,
        true,
      );
      assert.equal(
        evaluateWorkspaceToolCall(denied, scene.workDir, scene.workspaceRoots).allowed,
        false,
      );
      assert.equal(
        evaluateWorkspaceToolCall(mixed, scene.workDir, scene.workspaceRoots).allowed,
        false,
      );
      const rewritten = buildBackgroundAutonomousMiddleware({
        ...input,
        policy: {
          ...policy,
          hookRunner: {
            async runPreToolUse() {
              return { decision: "allow", modifiedInput: { command: UNKNOWN_THEN_DENY_COMMAND } };
            },
            async runPostToolResult() {},
          },
        },
      });
      assert.match((await rewritten(unknown)).reason ?? "", /hardline_denied/u);
      const child = { ...scene, processSandbox: {} };
      const worker = buildChildAgentSafetyMiddleware("worker", child);
      assert.equal((await worker(unknown)).allowed, true);
      assert.equal((await worker(denied)).allowed, false);
      assert.equal((await worker(mixed)).allowed, false);
      assert.equal(
        (await worker(bashCall("rm -f ./generated.txt"))).allowed,
        false,
        "worker 仍保留独立危险命令约束",
      );
      const explore = buildChildAgentSafetyMiddleware("explore", child);
      assert.equal((await explore(unknown)).allowed, false, "explore 仍要求可证明只读");
      assert.equal((await explore(mixed)).allowed, false);
      assert.equal((await explore(bashCall("pwd"))).allowed, true);
      assert.equal(BACKGROUND_HARDLINE_VERSION, "builtin-v2");
      await assert.rejects(
        prepareBackgroundAutonomousPolicy({
          workDir: scene.workDir,
          policy: { ...backgroundSnapshot(), hardlineVersion: "builtin-v1" },
          trustStore: {
            async canonicalize() {
              assert.fail("版本不兼容须先拒绝");
            },
            async isTrusted() {
              return true;
            },
          },
        }),
        /hardline 策略版本不匹配/u,
      );
    });
  },
);
