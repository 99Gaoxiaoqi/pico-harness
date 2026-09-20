import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntime, type RunAgentCliOptions } from "@pico/pico-host/agent-runtime";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteDeepResearchStore, SqliteSessionWorkbarRepository } from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
realTest(
  "real research archives evidence, resumes and completes a source-backed report without changing project files",
  { timeout: 12 * 60_000 },
  async (t) => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-research-real-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    const source = "export function add(a: number, b: number) { return a + b; }\n";
    await writeFile(join(workDir, "calculator.ts"), source);
    const sessionId = `research-${randomUUID()}`;
    const runtime = new AgentRuntime();
    const options: Omit<RunAgentCliOptions, "prompt" | "sessionSelection"> = {
      dir: workDir,
      provider: model.provider,
      baseURL: model.config.baseURL,
      apiKey: model.config.apiKey,
      model: model.config.model,
      modelRouteId: model.route.id,
      modelCapabilities: model.route.capabilities,
      collaborationMode: "research",
      permissionMode: "full-access",
      ...(model.route.capabilities.reasoningProfile.enabled &&
      model.route.capabilities.reasoningProfile.levels.includes("off")
        ? { thinkingEffort: "off" }
        : {}),
    };
    const trace: Array<{ tool: string; status: string; error?: string }> = [];
    const reportPath = process.env.RESEARCH_E2E_REPORT ?? join(tmpdir(), `pico-${sessionId}.json`);
    const reporter = new SilentReporter();
    reporter.onToolResult = (result) => {
      trace.push({
        tool: result.toolName,
        status: result.status,
        ...(result.status !== "succeeded"
          ? {
              error: result.projection.text
                .replaceAll(model.config.apiKey || "__no_key__", "[redacted]")
                .slice(0, 500),
            }
          : {}),
      });
      writeFileSync(reportPath, JSON.stringify({ model: model.route.id, trace }, null, 2));
    };
    t.after(() => t.diagnostic(`Research trace: ${reportPath}`));
    const dependencies = {
      picoHome,
      env: process.env,
      modelRouter: model.runtime.router,
      reporter,
      signal: AbortSignal.timeout(11 * 60_000),
    };
    await runtime.execute(
      {
        ...options,
        sessionSelection: { mode: "new", sessionId },
        prompt:
          "请按快速范围研究 calculator.ts，为增加 subtract 函数给出实施建议。本轮只完成第一轮证据收集：启动研究、读取实际源码、归档 source 和 evidence_note、记录探索步骤，再保存 knowledge_base 检查点（下一步为撰写报告），然后暂停并回复一句进度。不要现在完成报告，也不要修改项目文件。无需联网，不需要提问。",
      },
      dependencies,
    );
    const storageRoot = resolvePicoPaths(workDir, { picoHome }).workspace.root;
    const first = new SqliteDeepResearchStore({ storageRoot }).read(sessionId);
    assert.ok(
      first && first.checkpoints.length && first.artifacts.some((a) => a.role === "source"),
      "first round must persist evidence and a checkpoint",
    );
    assert.notEqual(first.status, "completed");
    const priorSource = first.artifacts.find((a) => a.role === "source")!;
    // Reconstruct the Runtime and stores. The next turn must use the durable workspace.
    await new AgentRuntime().execute(
      {
        ...options,
        sessionSelection: { mode: "resume", sessionId },
        prompt:
          "继续同一研究。先查询 deep_research_status，并用 deep_research_read_artifact 回读已保存的源码证据。无需更多探索或联网：完成四项检查（无相关测试的项目要明确说明跳过原因），保存 outline 和五个完成的 report_section（每个短小且引用已有来源），保存最终 report 和 handoff；handoff给出增加subtract的任务、建议PR和验证命令。保存report_writing检查点，最后调用 deep_research_complete 收口。只读，不实际修改文件或运行命令。",
      },
      dependencies,
    );
    const completed = new SqliteDeepResearchStore({ storageRoot }).read(sessionId);
    assert.equal(
      completed?.status,
      "completed",
      `research did not settle: ${JSON.stringify({ status: completed?.status, checklist: completed?.checklist, sections: completed?.reportSections })}`,
    );
    assert.equal(
      completed.artifacts.filter((a) => a.artifactId === priorSource.artifactId).length,
      1,
    );
    assert.ok(completed.reportSections.every((s) => s.status === "completed"));
    assert.ok(completed.handoff?.implementationTasks.some((task) => task.includes("subtract")));
    const artifacts = new SqliteSessionWorkbarRepository({ storageRoot });
    assert.ok(
      artifacts.readArtifactChunk({ sessionId, artifactId: completed.reportArtifactId! })
        .totalBytes > 0,
    );
    assert.equal(await readFile(join(workDir, "calculator.ts"), "utf8"), source);
    assert.deepEqual(await readdir(workDir), ["calculator.ts"]);
    const ledger = new SqliteRuntimeEventStore({ storageRoot });
    try {
      const events = await ledger.readSession(sessionId);
      const calls = events.filter((event) => event.kind === "tool.result.recorded");
      const successful = calls
        .filter((event) => event.data.status === "succeeded")
        .map((event) => event.data.toolName);
      for (const name of [
        "start",
        "save_artifact",
        "read_artifact",
        "update_checklist",
        "record_step",
        "checkpoint",
        "status",
        "complete",
      ])
        assert.ok(successful.includes(`deep_research_${name}`), `${name} must succeed`);
      assert.ok(
        !successful.some((name) =>
          ["write_file", "edit_file", "bash", "exec", "agent_spawn"].includes(name),
        ),
      );
      t.diagnostic(
        JSON.stringify({
          model: model.route.id,
          artifacts: completed.artifacts.length,
          steps: completed.steps.length,
          checkpoints: completed.checkpoints.length,
          researchStatus: completed.status,
          toolCalls: calls.length,
          failedTools: calls
            .filter((event) => event.data.status !== "succeeded")
            .map((event) => event.data.toolName),
        }),
      );
    } finally {
      ledger.close();
    }
  },
);
