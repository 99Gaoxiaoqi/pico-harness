import React from "react";
import { describe, expect, it, vi } from "vitest";

const { useInputSpy } = vi.hoisted(() => ({ useInputSpy: vi.fn() }));

vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return { ...actual, useInput: useInputSpy };
});

import { renderToString } from "ink";
import { ToolCard } from "../../src/tui/tool-card.js";

describe("ToolCard focus ownership", () => {
  it("不自行注册全局键盘监听", () => {
    renderToString(
      <ToolCard
        name="read_file"
        args='{"path":"README.md"}'
        status="success"
        summary="done"
        isLast
      />,
    );
    renderToString(
      <ToolCard
        name="delegate_task"
        args='{"agent_name":"reviewer","goal":"review"}'
        status="running"
        isLast
      />,
    );

    expect(useInputSpy).not.toHaveBeenCalled();
  });
});
