import React from "react";
import { PassThrough } from "node:stream";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, type Instance } from "ink";
import { expect, it } from "vitest";
import { ToolResultArtifactStore } from "../../src/context/artifact-store.js";
import { Session } from "../../src/engine/session.js";
import { toolResultMessage, type ToolCall } from "../../src/schema/message.js";
import {
  fileHistoryBeginRewindPoint,
  fileHistoryChanges,
  fileHistoryRestoreFile,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";
import { AskUserHandler, registerAskUserTool } from "../../src/tools/ask-user.js";
import { ToolRegistry, WriteFileTool } from "../../src/tools/registry-impl.js";
import { createToolResultObservationProcessor } from "../../src/tools/tool-result-observation.js";
import { App } from "../../src/tui/app.js";
import { bindAskUserDialogs } from "../../src/tui/ask-user-dialog.js";
import { createChangesPanelModel } from "../../src/tui/changes-panel.js";
import type { DialogRequest } from "../../src/tui/dialog-arbiter.js";
import {
  createArtifactInspectorContext,
  createToolInspectorSource,
  readInspectorPage,
} from "../../src/tui/inspector.js";
import { hydrateTuiReporter } from "../../src/tui/session-hydration.js";
import { projectTuiEntriesForRendering, TuiEventStore } from "../../src/tui/tui-event-store.js";
import { TuiReporter, type TuiEntry } from "../../src/tui/tui-reporter.js";

it("Stage 11 从结构化询问到水合检查与单文件恢复保持同一条可靠链路", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-stage11-e2e-"));
  const historyDir = join(workDir, ".test-file-history");
  const sessionId = "stage11-integration";
  const messageId = "user-message-1";
  const firstPath = join(workDir, "first.txt");
  const secondPath = join(workDir, "second.txt");
  const hardLinkPath = join(workDir, "first-peer.txt");
  const session = new Session(sessionId, workDir, { persistence: false });
  const registry = new ToolRegistry({ truncateResults: false });
  const askUserHandler = new AskUserHandler();
  let dialogs: DialogRequest[] = [];
  let entries: TuiEntry[] = [];
  let inspectedToolCallId: string | undefined;
  let unbindAskUserDialogs = (): void => {};
  let harness: ReturnType<typeof createAppHarness> | undefined;

  const app = (): React.ReactElement => (
    <App
      model="stage11-model"
      workDir={workDir}
      entries={entries}
      running={false}
      dialogRequests={dialogs}
      onSubmit={() => undefined}
      onInspectTool={(toolCallId) => {
        inspectedToolCallId = toolCallId;
      }}
    />
  );

  try {
    await writeFile(firstPath, "first-before\n", "utf8");
    await writeFile(secondPath, "second-before\n", "utf8");
    registry.register(new WriteFileTool(workDir));
    registerAskUserTool(registry, askUserHandler);

    harness = createAppHarness(app());
    await harness.settle();
    unbindAskUserDialogs = bindAskUserDialogs(askUserHandler, {
      openDialog: (request) => {
        dialogs = [...dialogs.filter((dialog) => dialog.id !== request.id), request];
        void harness?.rerender(app());
      },
      closeDialog: (dialogId) => {
        dialogs = dialogs.filter((dialog) => dialog.id !== dialogId);
        void harness?.rerender(app());
      },
    });

    const askCall: ToolCall = {
      id: "ask-call",
      name: "ask_user",
      arguments: JSON.stringify({
        header: "Apply changes",
        question: "Proceed with the Stage 11 integration fixture?",
        options: [
          { label: "Cancel", description: "Leave files unchanged." },
          { label: "Proceed", description: "Run the fixture." },
        ],
      }),
    };
    const askResultPromise = registry.execute(askCall);
    await harness.settle();
    expect(stripAnsi(harness.output())).toContain("Proceed with the Stage 11 integration fixture?");
    await harness.write("\u001b[B");
    await harness.write("\r");
    const askResult = await askResultPromise;
    expect(askResult.isError).toBe(false);
    expect(JSON.parse(askResult.output)).toMatchObject({
      status: "answered",
      selectedOption: { optionId: "option-2", label: "Proceed" },
    });
    expect(askUserHandler.pendingCount).toBe(0);

    await fileHistoryBeginRewindPoint(
      session.fileHistory,
      {
        messageId,
        userPrompt: "Apply two Stage 11 changes",
        messageIndex: 0,
        transcriptIndex: 0,
        interactionMode: "yolo",
      },
      sessionId,
      historyDir,
    );
    registry.setPreWriteHook(async (toolName, rawArgs) => {
      if (toolName !== "write_file") return;
      const input = JSON.parse(rawArgs) as { path: string };
      await fileHistoryTrackEdit(
        session.fileHistory,
        join(workDir, input.path),
        messageId,
        sessionId,
        historyDir,
      );
    });

    const reusedProviderCallId = "reused-provider-call";
    const firstWriteCall: ToolCall = {
      id: reusedProviderCallId,
      name: "write_file",
      arguments: JSON.stringify({ path: "first.txt", content: "first-after\n" }),
    };
    const secondWriteCall: ToolCall = {
      id: "write-second",
      name: "write_file",
      arguments: JSON.stringify({ path: "second.txt", content: "second-after\n" }),
    };
    const firstWriteResult = await registry.execute(firstWriteCall);
    const secondWriteResult = await registry.execute(secondWriteCall);
    expect(firstWriteResult.isError).toBe(false);
    expect(secondWriteResult.isError).toBe(false);

    const artifactCall: ToolCall = {
      id: reusedProviderCallId,
      name: "bash",
      arguments: JSON.stringify({ command: "emit-stage11-log" }),
    };
    const literalErrorPrefixCall: ToolCall = {
      id: "literal-error-prefix",
      name: "read_file",
      arguments: JSON.stringify({ path: "literal.log" }),
    };
    const fullOutput = `日志开始\n${"你好🙂".repeat(400)}\n日志结束\n`;
    const artifactStore = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    });
    const observationProcessor = createToolResultObservationProcessor({
      store: artifactStore,
      externalizeThresholdChars: 128,
      summaryMaxChars: 256,
      cleanupAfterWrite: false,
    });
    const artifactObservation = await observationProcessor({
      toolCall: artifactCall,
      result: { toolCallId: artifactCall.id, output: fullOutput, isError: false },
      output: fullOutput,
      sessionId,
    });
    expect(artifactObservation).toContain("[大型工具输出已外部化]");

    session.updateRuntimeState({
      settings: {
        provider: "openai",
        model: "stage11-model",
        modelRouteId: "stage11-route",
        mode: "yolo",
        thinkingEffort: "medium",
        thinkingEffortExplicit: false,
        additionalDirectories: [],
      },
    });
    session.append(
      { role: "user", content: "Apply two Stage 11 changes" },
      { role: "assistant", content: "First, confirm.", toolCalls: [askCall] },
      { role: "user", content: askResult.output, toolCallId: askCall.id },
      {
        role: "assistant",
        content: "Now edit both files.",
        toolCalls: [firstWriteCall, secondWriteCall],
      },
      { role: "user", content: firstWriteResult.output, toolCallId: firstWriteCall.id },
      { role: "user", content: secondWriteResult.output, toolCallId: secondWriteCall.id },
      {
        role: "assistant",
        content: "Read a literal prefix.",
        toolCalls: [literalErrorPrefixCall],
      },
      toolResultMessage(literalErrorPrefixCall.id, "[ERROR] literal successful output", false),
      { role: "assistant", content: "Inspect the log.", toolCalls: [artifactCall] },
      { role: "user", content: artifactObservation, toolCallId: artifactCall.id },
      { role: "assistant", content: "Stage 11 fixture complete." },
    );

    const hydration = await session.readHydrationSnapshot();
    expect(hydration.runtime.settings).toMatchObject({
      modelRouteId: "stage11-route",
      mode: "yolo",
    });
    const reporter = new TuiReporter(() => undefined, [], {
      onProjectionUpdate: (projection) => {
        entries = projectTuiEntriesForRendering(projection);
      },
    });
    hydrateTuiReporter(reporter, hydration);
    const projection = reporter.getProjection();
    const reusedCalls = Object.values(projection.toolCalls).filter(
      (tool) => tool.providerCallId === reusedProviderCallId,
    );
    expect(reusedCalls).toHaveLength(2);
    expect(new Set(reusedCalls.map((tool) => tool.id)).size).toBe(2);
    expect(new Set(entries.map((entry) => entry.uiEntryId)).size).toBe(entries.length);
    expect(
      Object.values(projection.toolCalls).find(
        (tool) => tool.providerCallId === literalErrorPrefixCall.id,
      )?.status,
    ).toBe("success");

    // 同名并发工具可以乱序返回；providerCallId 必须精确配对，
    // 不能退化为同名 FIFO 而把结果挂到错误的 args 上。
    const pairingReporter = new TuiReporter(() => undefined);
    const firstPairArgs = JSON.stringify({ path: "pair-first.txt", content: "first" });
    const secondPairArgs = JSON.stringify({ path: "pair-second.txt", content: "second" });
    pairingReporter.onToolCall("write_file", firstPairArgs, "pair-first");
    pairingReporter.onToolCall("write_file", secondPairArgs, "pair-second");
    pairingReporter.onToolResult("write_file", "second-result-marker", false, "pair-second");
    pairingReporter.onToolResult("write_file", "first-result-marker", false, "pair-first");
    const pairedTools = Object.values(pairingReporter.getProjection().toolCalls);
    const firstPairedTool = pairedTools.find((tool) => tool.providerCallId === "pair-first");
    const secondPairedTool = pairedTools.find((tool) => tool.providerCallId === "pair-second");
    expect(firstPairedTool).toMatchObject({
      args: firstPairArgs,
      status: "success",
      summary: expect.stringContaining("first-result-marker"),
    });
    expect(firstPairedTool?.summary).not.toContain("second-result-marker");
    expect(secondPairedTool).toMatchObject({
      args: secondPairArgs,
      status: "success",
      summary: expect.stringContaining("second-result-marker"),
    });
    expect(secondPairedTool?.summary).not.toContain("first-result-marker");
    const replayedReporter = new TuiReporter(() => undefined, [], {
      eventStore: new TuiEventStore({ initialSnapshot: reporter.getReplaySnapshot() }),
    });
    expect(replayedReporter.getProjection().entries.map((entry) => entry.id)).toEqual(
      projection.entries.map((entry) => entry.id),
    );
    expect(Object.keys(replayedReporter.getProjection().toolCalls)).toEqual(
      Object.keys(projection.toolCalls),
    );

    const artifactTool = reusedCalls.find((tool) => tool.name === "bash");
    expect(artifactTool).toMatchObject({
      status: "success",
      resultAvailability: "artifact",
      truncated: true,
    });
    if (!artifactTool) throw new Error("Hydrated artifact tool is missing");

    await harness.rerender(app());
    await harness.write("\u0005");
    expect(inspectedToolCallId).toBe(artifactTool.id);

    const inspectorSource = createToolInspectorSource(
      artifactTool,
      createArtifactInspectorContext({ workDir, sessionId }),
    );
    if (!inspectorSource || inspectorSource.kind !== "artifact") {
      throw new Error("Artifact Inspector source was not reconstructed");
    }
    let inspectedOutput = "";
    let offsetBytes = 0;
    let locatePath: string | undefined;
    for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
      const page = await readInspectorPage(inspectorSource, { offsetBytes, limitBytes: 256 });
      inspectedOutput += page.content;
      locatePath = page.locatePath;
      if (page.eof) break;
      expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
      offsetBytes = page.nextOffsetBytes;
    }
    expect(inspectedOutput).toBe(fullOutput);
    expect(locatePath).toBeDefined();
    expect(await readFile(locatePath!, "utf8")).toBe(fullOutput);

    const staleModel = createChangesPanelModel(
      await fileHistoryChanges(session.fileHistory, messageId, sessionId, historyDir),
    );
    expect(staleModel.files).toHaveLength(2);
    const staleFirst = staleModel.files.find((file) => file.filePath === firstPath);
    if (!staleFirst) throw new Error("first.txt is missing from Changes");
    await writeFile(firstPath, "first-after-preview\n", "utf8");
    await expect(
      fileHistoryRestoreFile(
        session.fileHistory,
        staleFirst.restoreAction.messageId,
        staleFirst.restoreAction.filePath,
        staleFirst.restoreAction.expectedCurrentFingerprint,
        sessionId,
        historyDir,
      ),
    ).rejects.toThrow("在预览后又发生变化");

    await link(firstPath, hardLinkPath);
    const freshModel = createChangesPanelModel(
      await fileHistoryChanges(session.fileHistory, messageId, sessionId, historyDir),
    );
    const freshFirst = freshModel.files.find((file) => file.filePath === firstPath);
    if (!freshFirst) throw new Error("first.txt is missing after Changes refresh");
    await fileHistoryRestoreFile(
      session.fileHistory,
      freshFirst.restoreAction.messageId,
      freshFirst.restoreAction.filePath,
      freshFirst.restoreAction.expectedCurrentFingerprint,
      sessionId,
      historyDir,
    );
    expect(await readFile(firstPath, "utf8")).toBe("first-before\n");
    expect(await readFile(hardLinkPath, "utf8")).toBe("first-after-preview\n");
    expect(await readFile(secondPath, "utf8")).toBe("second-after\n");
    const remaining = await fileHistoryChanges(
      session.fileHistory,
      messageId,
      sessionId,
      historyDir,
    );
    expect(remaining.files.map((file) => file.filePath)).toEqual([secondPath]);
  } finally {
    unbindAskUserDialogs();
    askUserHandler.cancelAll("integration cleanup");
    await harness?.cleanup();
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

function createAppHarness(node: React.ReactNode): {
  settle: () => Promise<void>;
  write: (input: string) => Promise<void>;
  rerender: (next: React.ReactNode) => Promise<void>;
  output: () => string;
  cleanup: () => Promise<void>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, {
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 100 },
    rows: { value: 28 },
  });
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await instance.waitUntilRenderFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await instance.waitUntilRenderFlush();
  };
  return {
    settle,
    async write(input): Promise<void> {
      stdin.write(input);
      await settle();
    },
    async rerender(next): Promise<void> {
      instance.rerender(next);
      await settle();
    },
    output: () => output,
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
