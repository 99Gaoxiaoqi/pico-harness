import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { StatusBar, buildStatusItems, buildStatusBarText } from "../../src/tui/status-bar.js";

describe("StatusBar", () => {
  it("renders compact runtime phase without repeating model or cwd", () => {
    const output = renderToString(
      <StatusBar
        phase="running"
        sessionMode="resume"
        permissionMode="acceptEdits"
        contextSummary="ctx 42%"
        taskSummary="2 queued"
      />,
    );

    expect(output).toContain("phase running");
    expect(output).toContain("mode resume");
    expect(output).toContain("perm acceptEdits");
    expect(output).toContain("ctx 42%");
    expect(output).toContain("2 queued");
    expect(output).not.toContain("glm-5.2");
    expect(output).not.toContain("/workspace/demo");
  });

  it("keeps status item order stable for scanning", () => {
    expect(
      buildStatusItems({
        phase: "approval",
        sessionMode: "new",
        permissionMode: "ask",
        contextSummary: "ctx 18%",
        taskSummary: "approval pending",
      }),
    ).toEqual([
      ["phase", "approval"],
      ["mode", "new"],
      ["perm", "ask"],
      ["context", "ctx 18%"],
      ["task", "approval pending"],
    ]);
  });

  it("shows a fork source as a short session id", () => {
    const source = "cli-source-session-abcdef123456";
    const output = renderToString(<StatusBar phase="idle" sessionMode="fork" forkFrom={source} />);

    expect(output).toContain("mode fork");
    expect(output).toContain("from cli-...123456");
    expect(output).not.toContain(source);
    expect(
      buildStatusItems({
        phase: "idle",
        sessionMode: "fork",
        forkFrom: source,
      }),
    ).toContainEqual(["forkFrom", "cli-...123456"]);
  });

  it("falls back cleanly when provider is missing", () => {
    const output = renderToString(<StatusBar sessionMode="new" />);

    expect(output).toContain("phase idle");
    expect(output).toContain("mode new");
    expect(output).toContain("perm yolo");
    expect(output).not.toContain("provider");
  });

  it("truncates long context and task values in the middle", () => {
    const output = renderToString(
      <StatusBar
        phase="queued"
        sessionMode="continue"
        contextSummary="/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness"
        taskSummary="queued input waiting for the current run to finish"
        summaryMaxLength={30}
        renderWidth={120}
      />,
      { columns: 140 },
    );

    expect(output).toContain("/Users/anxua...");
    expect(output).toContain("pico-harness");
    expect(output).toContain("queued input...");
    expect(output).not.toContain("geektime-downloader/从0开始构建AgentHarness");
  });

  it("keeps a single line at 26 columns by dropping low-priority fields", () => {
    const props = {
      phase: "approval",
      sessionMode: "resume",
      permissionMode: "acceptEdits",
      contextSummary: "ctx 你好 🚀 80%",
      taskSummary: "queued task with long description",
      renderWidth: 24,
    };
    const output = renderToString(<StatusBar {...props} />, { columns: 26 });

    expect(output.split("\n")).toHaveLength(1);
    expect(output).toBe(` ${buildStatusBarText(props)}`);
    expect(output).toContain("approval");
    expect(output).not.toContain("queued task");
  });
});
