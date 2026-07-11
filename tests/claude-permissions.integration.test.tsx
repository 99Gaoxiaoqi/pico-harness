import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager, type ApprovalNotice } from "../src/approval/manager.js";
import {
  globalSessionPermissionGrants,
  SessionPermissionGrants,
} from "../src/approval/session-permissions.js";
import { runAgentFromCli, type RunAgentCliDependencies } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import {
  getOrCreateSessionSettings,
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../src/input/session-settings.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import type { DialogRequest } from "../src/tui/dialog-arbiter.js";
import { formatApprovalPanel, type ApprovalPanelAction } from "../src/tui/approval-panel.js";
import { runTuiAgentPrompt, type TuiRunAgent } from "../src/tui/repl.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";

class ScriptedProvider implements LLMProvider {
  constructor(private readonly responses: Message[]) {}

  generate(): Promise<Message> {
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response left");
    return Promise.resolve(response);
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  globalApprovalManager.clear();
  globalSessionPermissionGrants.clear();
  globalSessionManager.clear();
  resetSessionSettingsForTests();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude-style permission integration", () => {
  it("Bash session prefix 不吸收 shell 链、重定向或后台执行", () => {
    const grants = new SessionPermissionGrants();
    grants.add("grant", { type: "bash-command", command: "npm test", match: "prefix" });
    const call = (command: string, background = false) => ({
      id: "bash-grant",
      name: "bash",
      arguments: JSON.stringify({ command, background }),
    });

    expect(grants.allows("grant", call("npm test -- --runInBand"), process.cwd())).toBe(true);
    expect(grants.allows("grant", call("npm test ; touch escaped"), process.cwd())).toBe(false);
    expect(grants.allows("grant", call("npm test && touch escaped"), process.cwd())).toBe(false);
    expect(grants.allows("grant", call("npm test\ntouch escaped"), process.cwd())).toBe(false);
    expect(grants.allows("grant", call("npm test > escaped.log"), process.cwd())).toBe(false);
    expect(grants.allows("grant", call("npm test", true), process.cwd())).toBe(false);
  });

  it("default 模式通过 TUI 一次选择原子授权外部目录并切换 session edits", async () => {
    const workDir = await realTempDir("pico-permission-default-");
    const outsideDir = await realTempDir("pico-permission-outside-");
    const outsideFile = join(outsideDir, "outside.txt");
    const secondOutsideFile = join(outsideDir, "second.txt");
    await writeFile(outsideFile, "before\n", "utf8");
    await writeFile(secondOutsideFile, "second-before\n", "utf8");
    const sessionId = "claude_permission_default";
    getOrCreateSessionSettings({
      sessionId,
      cwd: workDir,
      provider: "openai",
      model: "test-model",
      mode: "default",
    });
    const provider = new ScriptedProvider([
      toolMessage("edit-external", "edit_file", {
        path: outsideFile,
        old_text: "before",
        new_text: "after",
      }),
      toolMessage("edit-second-external", "edit_file", {
        path: secondOutsideFile,
        old_text: "second-before",
        new_text: "second-after",
      }),
      toolMessage("write-followup", "write_file", {
        path: "followup.txt",
        content: "auto edit",
      }),
      { role: "assistant", content: "done" },
    ]);
    const reporter = new TuiReporter(() => undefined);
    const dialogs: DialogRequest[] = [];
    let resolveFirstDialog!: (request: DialogRequest) => void;
    let resolveSecondDialog!: (request: DialogRequest) => void;
    const firstDialog = new Promise<DialogRequest>((resolve) => {
      resolveFirstDialog = resolve;
    });
    const secondDialog = new Promise<DialogRequest>((resolve) => {
      resolveSecondDialog = resolve;
    });

    const run = runTuiAgentPrompt(
      {
        prompt: "edit outside then write followup",
        dir: workDir,
        session: sessionId,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        model: "test-model",
      },
      {
        reporter,
        runAgent: injectedRunAgent(provider),
        openDialog: (request) => {
          dialogs.push(request);
          if (dialogs.length === 1) resolveFirstDialog(request);
          if (dialogs.length === 2) resolveSecondDialog(request);
        },
      },
    );

    const request = await withTimeout(firstDialog, "approval dialog did not open");
    const element = request.content;
    expect(React.isValidElement(element)).toBe(true);
    const props = (
      element as React.ReactElement<
        ApprovalNotice & { onAction: (action: ApprovalPanelAction) => void }
      >
    ).props;
    expect(formatApprovalPanel(props)).toContain(
      `Yes, allow all edits in ${outsideDir.split("/").at(-1)}/ during this session`,
    );
    expect(formatApprovalPanel(props)).not.toContain(props.taskId);
    props.onAction("approve");

    const secondRequest = await withTimeout(
      secondDialog,
      "approve once leaked to another file in the external directory",
    );
    const secondProps = (
      secondRequest.content as React.ReactElement<
        ApprovalNotice & { onAction: (action: ApprovalPanelAction) => void }
      >
    ).props;
    secondProps.onAction("approve-session");
    await run;

    expect(dialogs).toHaveLength(2);
    await expect(readFile(outsideFile, "utf8")).resolves.toContain("after");
    await expect(readFile(secondOutsideFile, "utf8")).resolves.toContain("second-after");
    await expect(readFile(join(workDir, "followup.txt"), "utf8")).resolves.toBe("auto edit");
    expect(getStoredSessionSettings(sessionId)).toMatchObject({
      mode: "auto",
      permissionMode: "auto",
      additionalDirectories: [outsideDir],
    });
  });

  it("默认 yolo 不弹审批并放权普通操作，仅保留 hardline 红线", async () => {
    const workDir = await realTempDir("pico-permission-yolo-");
    const outsideDir = await realTempDir("pico-permission-yolo-outside-");
    const nestedDir = join(outsideDir, "new", "nested");
    const outsideFile = join(nestedDir, "bash.txt");
    const sessionId = "claude_permission_yolo";
    const provider = new ScriptedProvider([
      toolMessage("bash-external", "bash", {
        command: `mkdir -p '${nestedDir}' && printf yolo-ok > '${outsideFile}'`,
      }),
      toolMessage("safety-file", "write_file", { path: ".env", content: "TOKEN=blocked" }),
      toolMessage("hardline", "bash", { command: "rm -rf /" }),
      { role: "assistant", content: "safety preserved" },
    ]);
    const reporter = new TuiReporter(() => undefined);
    const notices: ApprovalNotice[] = [];

    const run = runTuiAgentPrompt(
      {
        prompt: "exercise yolo boundaries",
        dir: workDir,
        session: sessionId,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        model: "test-model",
      },
      {
        reporter,
        runAgent: injectedRunAgent(provider),
        openDialog: (request) => {
          const props = (request.content as React.ReactElement<ApprovalNotice>).props;
          notices.push(props);
        },
      },
    );

    await run;

    expect(notices).toHaveLength(0);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("yolo-ok");
    await expect(readFile(join(workDir, ".env"), "utf8")).resolves.toBe("TOKEN=blocked");
    expect(getStoredSessionSettings(sessionId)?.mode).toBe("yolo");
    // 一次性工具通行不应污染会话的显式 additionalDirectories 配置。
    expect(getStoredSessionSettings(sessionId)?.additionalDirectories).not.toContain(outsideDir);
  });
});

function toolMessage(id: string, name: string, input: object): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(input) }],
  };
}

function injectedRunAgent(provider: LLMProvider): TuiRunAgent {
  return (options, dependencies) =>
    runAgentFromCli(options, {
      ...dependencies,
      provider,
    } satisfies RunAgentCliDependencies);
}

async function realTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  await mkdir(path, { recursive: true });
  return realpath(path);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
