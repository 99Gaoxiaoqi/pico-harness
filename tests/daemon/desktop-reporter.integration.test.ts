import { describe, expect, it, vi } from "vitest";
import { DesktopReporter } from "../../src/daemon/desktop-reporter.js";

describe("DesktopReporter", () => {
  it("projects reporter callbacks in a monotonic, reasoning-safe timeline", () => {
    const publish = vi.fn();
    const reporter = new DesktopReporter({ runId: "run-1", publish, now: () => 10 });

    reporter.onStart("/workspace");
    reporter.onThinking();
    reporter.onToolCall("bash", '{"command":"npm test"}', "call-1");
    reporter.onToolResult("bash", "passed", false, "call-1");
    reporter.onFinish();

    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      "run.started",
      "assistant.thinking",
      "tool.started",
      "tool.completed",
      "run.finished",
    ]);
    expect(publish.mock.calls.map(([event]) => event.resourceVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(publish).toHaveBeenNthCalledWith(2, expect.objectContaining({ payload: {}, at: 10 }));
  });

  it("bounds tool results before they enter the IPC event stream", () => {
    const publish = vi.fn();
    const reporter = new DesktopReporter({ runId: "run-2", publish });

    reporter.onToolResult("read_file", "x".repeat(70_000), false);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.completed",
        payload: expect.objectContaining({ truncated: true }),
      }),
    );
    const event = publish.mock.calls[0]?.[0];
    expect(String(event?.payload.result).length).toBeLessThan(70_000);
  });
});
