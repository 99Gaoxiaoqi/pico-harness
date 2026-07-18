import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { render } from "ink";
import { TerminalMarkdownModel } from "../../src/tui/terminal-markdown-model.js";

test("TerminalMarkdownModel 的测量与 Ink 实际行数一致", async () => {
  const model = new TerminalMarkdownModel(
    ["# 标题", "", "一段足够长的文本用于验证终端换行行为。", "", "- 第一项", "- 第二项"].join("\n"),
  );
  const width = 16;
  const rendered = await renderModel(model, width);
  const actualRows = rendered.split("\n").length - 1;

  assert.equal(model.measure(width), actualRows);
  assert.equal(model.clip(0, model.measure(width), width).length, actualRows);
});

test("TerminalMarkdownModel.clip 返回完整渲染视觉行的切片", () => {
  const model = new TerminalMarkdownModel("第一行\n\n第二行\n第三行");
  const allRows = model.clip(0, undefined, 80);

  assert.deepEqual(model.clip(1, 2, 80), allRows.slice(1, 3));
});

async function renderModel(model: TerminalMarkdownModel, width: number): Promise<string> {
  const stdout = new PassThrough();
  Object.defineProperty(stdout, "columns", { value: width });
  let rendered = "";
  stdout.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const instance = render(model.render(width), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    interactive: false,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  instance.unmount();
  await instance.waitUntilExit();
  return rendered;
}
