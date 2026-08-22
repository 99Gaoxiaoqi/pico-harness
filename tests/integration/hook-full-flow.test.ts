import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookTrustStore } from "../../src/hooks/trust/store.js";
import type { CommandHookHandler, HookSource } from "../../src/hooks/types.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { Message } from "../../src/schema/message.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

// shell 化后 hook 全链路验收（2026-08-17）：配置加载 → 指纹审批 → PreToolUse
// 触发时 shell 执行（命令含 && 组合，证明是 shell 解释而非 argv 直启）→
// 决策信封回流（allow 放行工具 / deny 阻断工具 / 未信任静默跳过）。

test("shell 化 hook 全链路：allow 场景——shell 组合命令执行且工具正常放行", async (context) => {
  const fixture = await createFixture(context, "flow-allow");
  const marker = join(fixture.root, "marker.txt");
  const target = join(fixture.workspace, "target.txt");
  await writeFile(target, "TARGET_CONTENT_E2E\n");
  // shell 组合命令：第一支写 marker（副作用证据），第二支输出 allow 决策信封；
  // && 必须由 shell 解释——argv 直启模型下这种命令无法执行。
  // 引号约定：外层单引号（bash/PS 均为字面量），脚本内部用双引号
  // （JSON.stringify 的路径自带转义反斜杠，直接可嵌）。
  const command = [
    `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "fired")'`,
    "&&",
    `node -e 'process.stdout.write(JSON.stringify({decision:"allow",additionalContext:"HOOK_E2E_OK"}))'`,
  ].join(" ");
  const handler: CommandHookHandler = { type: "command", command };
  const source = projectSource(fixture.workspace);
  await writeHookConfig(fixture.workspace, "PreToolUse", handler);

  // 指纹审批：预写信任记录（runtime 内 trust store 读同一文件）。
  const trustStore = new HookTrustStore({ picoHome: fixture.picoHome });
  await trustStore.trust({ workspace: fixture.workspace, source, handler });
  await trustWorkspace(fixture);

  const seen = await runWithReadFileTool(fixture, target);

  assert.equal(await readFile(marker, "utf8"), "fired", "shell 组合命令的第一支必须执行");
  const toolResult = findToolResult(seen);
  assert.ok(toolResult, "read_file 工具结果必须回到 provider");
  assert.match(toolResult, /TARGET_CONTENT_E2E/u, "allow 决策下工具正常执行");
  assert.doesNotMatch(toolResult, /被 PreToolUse hook 阻断/u);
});

test("shell 化 hook 全链路：deny 场景——决策信封阻断工具并携带原因", async (context) => {
  const fixture = await createFixture(context, "flow-deny");
  const target = join(fixture.workspace, "target.txt");
  await writeFile(target, "SHOULD_NOT_BE_READ\n");
  const command = `node -e 'process.stdout.write(JSON.stringify({decision:"deny",reason:"e2e-blocked-by-hook"}))'`;
  const handler: CommandHookHandler = { type: "command", command };
  const source = projectSource(fixture.workspace);
  await writeHookConfig(fixture.workspace, "PreToolUse", handler);

  const trustStore = new HookTrustStore({ picoHome: fixture.picoHome });
  await trustStore.trust({ workspace: fixture.workspace, source, handler });
  await trustWorkspace(fixture);

  const seen = await runWithReadFileTool(fixture, target);

  const toolResult = findToolResult(seen);
  assert.ok(toolResult, "被阻断的工具调用仍须把结果回给 provider");
  assert.match(toolResult, /被 PreToolUse hook 阻断/u);
  assert.match(toolResult, /e2e-blocked-by-hook/u, "deny 原因必须回流");
  assert.doesNotMatch(toolResult, /SHOULD_NOT_BE_READ/u, "被阻断的工具不得执行");
});

test("shell 化 hook 全链路：未信任场景——hook 静默跳过且工具不受影响", async (context) => {
  const fixture = await createFixture(context, "flow-untrusted");
  const marker = join(fixture.root, "marker.txt");
  const target = join(fixture.workspace, "target.txt");
  await writeFile(target, "UNTRUSTED_TARGET\n");
  const command = [
    `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "fired")'`,
    "&&",
    `node -e 'process.stdout.write(JSON.stringify({decision:"deny",reason:"must-not-run"}))'`,
  ].join(" ");
  await writeHookConfig(fixture.workspace, "PreToolUse", { type: "command", command });

  // 不写信任记录：pending 状态的 executable hook 必须被跳过（fail-open 放行工具）。
  const seen = await runWithReadFileTool(fixture, target);

  assert.equal(
    await readFile(marker, "utf8").catch(() => undefined),
    undefined,
    "未信任 hook 不得执行",
  );
  const toolResult = findToolResult(seen);
  assert.match(toolResult ?? "", /UNTRUSTED_TARGET/u, "工具照常执行");
});

// --- fixture ---------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
}

async function createFixture(
  context: { after: (fn: () => void | Promise<void>) => void },
  label: string,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-hook-full-flow-${label}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, picoHome };
}

function projectSource(workspace: string): HookSource {
  return { kind: "project", path: join(workspace, ".pico", "hooks.json"), version: 1 };
}

/** workspace trust 锚：不信任的工作区里 executable hooks 在 dispatch 边界被跳过。 */
async function trustWorkspace(fixture: Fixture): Promise<void> {
  const store = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await store.trust(await store.canonicalize(fixture.workspace));
}

async function writeHookConfig(
  workspace: string,
  event: string,
  handler: CommandHookHandler,
): Promise<void> {
  await writeFile(
    join(workspace, ".pico", "hooks.json"),
    `${JSON.stringify({ [event]: [{ matcher: "read_file", hooks: [handler] }] }, null, 2)}\n`,
  );
}

/** 跑一轮真 runtime：provider 第一回合发 read_file 工具调用，第二回合收口。 */
async function runWithReadFileTool(fixture: Fixture, target: string): Promise<Message[][]> {
  const seen: Message[][] = [];
  let calls = 0;
  await executeAgentRuntime(
    {
      prompt: "读取目标文件",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: `hook-flow-${Date.now()}` },
      provider: "openai",
      modelRouteId: "test/test",
    },
    {
      provider: {
        async generate(messages) {
          seen.push(messages);
          calls++;
          if (calls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call-read-target",
                  name: "read_file",
                  arguments: JSON.stringify({ path: target }),
                },
              ],
            };
          }
          return { role: "assistant", content: "done" };
        },
      },
      picoHome: fixture.picoHome,
    },
  );
  return seen;
}

function findToolResult(seen: Message[][]): string | undefined {
  // pico 工具结果以 role:"user" + toolCallId 回流。
  for (const messages of seen) {
    for (const message of messages) {
      if (message.toolCallId !== undefined && typeof message.content === "string") {
        return message.content;
      }
    }
  }
  return undefined;
}
