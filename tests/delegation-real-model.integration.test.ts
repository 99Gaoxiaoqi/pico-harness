import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentFromCli } from "../src/cli/run-agent.js";

const realModelEnabled =
  process.env.RUN_REAL_MODEL_TEST === "1" &&
  Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);

const describeRealModel = realModelEnabled ? describe : describe.skip;

describeRealModel("real model delegation integration", () => {
  it("uses delegate_task to launch a worker subagent that writes a real file", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-real-delegate-test-"));
    const result = await runAgentFromCli(
      {
        prompt:
          "这是一次真实模型集成测试。你必须调用 delegate_task 工具，不要直接调用 write_file。" +
          "请用 delegate_task 的 tasks 参数启动 1 个 mode=worker 的子代理。" +
          "子代理目标：必须调用 write_file，在当前工作区创建 real-subagent-result.txt，" +
          "文件内容必须精确为 REAL_SUBAGENT_OK。子代理完成后，你读取/确认结果，" +
          "然后最终只回复 REAL_DELEGATE_DONE。",
        dir: workDir,
        session: `real-delegate-test-${Date.now()}`,
        provider: "openai",
        planMode: false,
      },
      {},
    );

    expect(result.finalMessage.trim()).toBe("REAL_DELEGATE_DONE");
    expect(await readFile(join(workDir, "real-subagent-result.txt"), "utf8")).toBe(
      "REAL_SUBAGENT_OK",
    );
  }, 90_000);
});
