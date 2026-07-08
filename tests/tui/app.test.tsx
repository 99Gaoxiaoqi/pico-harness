import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/tui/app.js";

describe("App", () => {
  it("renders history messages separately from the single bottom input box", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[
          { kind: "user", content: "你好" },
          { kind: "assistant", content: "你好！" },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("你好");
    expect(output).toContain("你好！");
    expect(countOccurrences(output, "Enter 发送")).toBe(1);
    expect(countOccurrences(output, "Tab 补全")).toBe(1);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
