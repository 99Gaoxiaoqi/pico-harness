import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { createTerminalWorkspaceTrustPrompt } from "@pico/cli/workspace-trust-prompt";
import { createTerminalWorkspaceTrustPrompt as legacyCreateTerminalWorkspaceTrustPrompt } from "@pico/cli/workspace-trust-prompt";

function startTrustRequest(workspacePath = "/tmp/pico-workspace") {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  const prompt = createTerminalWorkspaceTrustPrompt({ input, output });
  const decision = prompt.requestTrust({
    workspacePath,
    risks: ["读取项目配置", "启动配置的 MCP 服务"],
  });
  return { input, output, decision, rendered: () => rendered };
}

test("terminal workspace trust prompt retries invalid input and escapes invisible path controls", async () => {
  const request = startTrustRequest("/tmp/a\u202eb");
  const retryShown = new Promise<void>((resolve) => {
    const onOutput = () => {
      if (request.rendered().includes("无法识别该选项")) {
        resolve();
      }
    };
    request.output.on("data", onOutput);
  });
  request.input.write("maybe\n");
  await retryShown;
  request.input.end("trust\n");

  assert.equal(await request.decision, "trust");
  assert.match(request.rendered(), /Pico 需要信任此工作区/u);
  assert.match(request.rendered(), /\\u202e/u, "路径中的双向控制符必须可见");
  assert.match(request.rendered(), /无法识别该选项/u);
  assert.match(request.rendered(), /启动配置的 MCP 服务/u);
});

test("terminal workspace trust prompt denies an empty answer and keeps the legacy entrypoint", async () => {
  const request = startTrustRequest();
  request.input.end("\n");
  assert.equal(await request.decision, "deny");

  const input = new PassThrough();
  const output = new PassThrough();
  const prompt = legacyCreateTerminalWorkspaceTrustPrompt({ input, output });
  const decision = prompt.requestTrust({ workspacePath: "/tmp/legacy", risks: [] });
  queueMicrotask(() => input.end("1\n"));
  assert.equal(await decision, "trust");
});
