import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@pico/pico-host/agent-runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";
const realTest = process.env.RUN_COMPACTION_E2E === "1" ? test : test.skip;
realTest("真实模型通过归档URI找回预览之外的精确标记", { timeout: 300_000 }, async (t) => {
  const model = await configuredUserDefaultRealModel();
  const root = await mkdtemp(join(tmpdir(), "pico-archive-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const marker = `ARCHIVE_${randomUUID().replaceAll("-", "")}`;
  const source = Array.from({ length: 180 }, (_, index) =>
    index === 175 ? `FINAL_MARKER=${marker}` : `record ${index}: ${"archived evidence ".repeat(4)}`,
  ).join("\n");
  await writeFile(join(workDir, "evidence.txt"), source);
  const calls: Array<{ name: string; args: string }> = [];
  const replies: string[] = [];
  const errors: string[] = [];
  const reporter = new SilentReporter();
  reporter.onToolCall = (name, args) => {
    calls.push({ name, args });
  };
  reporter.onMessage = (content?: string) => {
    if (content) replies.push(content);
  };
  reporter.onToolResult = (result) => {
    if (result.status !== "succeeded") errors.push(result.toolName);
  };
  await new AgentRuntime().execute(
    {
      dir: workDir,
      provider: model.provider,
      baseURL: model.config.baseURL,
      apiKey: model.config.apiKey,
      model: model.config.model,
      modelRouteId: model.route.id,
      modelCapabilities: model.route.capabilities,
      sessionSelection: { mode: "new", sessionId: `archive-${randomUUID()}` },
      permissionMode: "full-access",
      ...(model.route.capabilities.reasoningProfile.levels.includes("off")
        ? { thinkingEffort: "off" }
        : {}),
      prompt:
        "仅使用 read_file：先完整读取 evidence.txt，若结果归档，必须使用返回的 pico://archive/ URI 按字符偏移分页回读（可跳到尾部），找到文件最后的 FINAL_MARKER。最终只回复等号后的精确值。不要改文件，不用 shell、grep 或其他工具。",
    },
    {
      picoHome,
      env: process.env,
      modelRouter: model.runtime.router,
      reporter,
      signal: AbortSignal.timeout(280_000),
    },
  );
  assert.ok(
    calls.some(
      (call) =>
        call.name === "read_file" && JSON.parse(call.args).path.startsWith("pico://archive/"),
    ),
    "must actually read the archive resource",
  );
  assert.equal(replies.at(-1)?.trim(), marker);
  assert.equal(await readFile(join(workDir, "evidence.txt"), "utf8"), source);
  t.diagnostic(
    `archive read calls=${calls.filter((call) => call.args.includes("pico://archive/")).length}; tool errors=${errors.length}`,
  );
});
