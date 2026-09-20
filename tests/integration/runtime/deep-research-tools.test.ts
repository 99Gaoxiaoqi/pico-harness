import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeepResearchTools } from "@pico/pico-host/deep-research-tools";
import {
  SqliteDeepResearchStore,
  SqliteSessionWorkbarRepository,
  withWorkspaceSqliteLease,
} from "@pico/storage";
import {
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
  buildDeepResearchImplementationPrompt,
  projectDeepResearchProgress,
  type DeepResearchProgress,
} from "@pico/core/deep-research";

function fixture() {
  const storageRoot = mkdtempSync(join(tmpdir(), "pico-research-"));
  withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    for (const id of ["research", "other"])
      database
        .prepare(
          "INSERT INTO sessions (session_id,work_dir,created_at,updated_at) VALUES (?,?,?,?)",
        )
        .run(id, storageRoot, new Date().toISOString(), new Date().toISOString());
  });
  const tools = createDeepResearchTools({
    storageRoot,
    sessionId: "research",
    onChanged: () => {
      throw new Error("observer unavailable");
    },
  });
  let sequence = 0;
  const call = async (name: string, args: object = {}, key = `call-${++sequence}`) =>
    JSON.parse(
      await tools
        .find((tool) => tool.name() === `deep_research_${name}`)!
        .execute(JSON.stringify(args), { toolCallId: key }),
    ) as { run: DeepResearchProgress };
  return {
    storageRoot,
    tools,
    call,
    close: () => rmSync(storageRoot, { recursive: true, force: true }),
  };
}

test("deep research persists source-backed rounds, reports and handoff across restart with preview artifacts", async () => {
  const f = fixture();
  try {
    let { run } = await f.call("start", { objective: "核实研究闭环", scope_level: "standard" });
    assert.equal(run.checklist.length, 4);
    const sourceRequest = {
      role: "source",
      name: "入口源码",
      content: "你好🌍\nexport function main() {}",
      locator: "src/main.ts",
    };
    ({ run } = await f.call("save_artifact", sourceRequest, "source-call"));
    const source = run.artifacts.at(-1)!.artifactId;
    assert.deepEqual((await f.call("save_artifact", sourceRequest, "source-call")).run, run);
    ({ run } = await f.call("save_artifact", {
      role: "evidence_note",
      name: "入口证据",
      content: "main 是执行入口。",
      source_artifact_ids: [source],
    }));
    const evidence = run.artifacts.at(-1)!.artifactId;
    ({ run } = await f.call("record_step", {
      kind: "local_exploration",
      status: "completed",
      objective: "入口验证",
      summary: "已确认入口",
      roots: ["src"],
      ignored_paths: ["node_modules"],
      stopping_condition: "读到 main",
      expected_evidence: "函数定义",
      evidence_artifact_ids: [evidence],
      inspected_refs: [{ kind: "symbol", locator: "src/main.ts:main", source_artifact_id: source }],
    }));
    for (const item of run.checklist)
      await f.call("update_checklist", {
        item_id: item.itemId,
        status: "completed",
        evidence_artifact_ids: [evidence],
      });
    ({ run } = await f.call("checkpoint", {
      round: 1,
      stage: "report_writing",
      summary: "证据归档完成",
      next_steps: ["编写报告"],
      artifact_ids: [source, evidence],
    }));
    assert.deepEqual(
      projectDeepResearchProgress(
        new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!,
      ),
      run,
    );
    const reopened = createDeepResearchTools({ storageRoot: f.storageRoot, sessionId: "research" });
    const read = JSON.parse(
      await reopened
        .find((tool) => tool.name() === "deep_research_read_artifact")!
        .execute(JSON.stringify({ artifact_id: source, offset: 2, limit: 1 })),
    );
    assert.equal(read.content, "🌍");
    assert.equal(read.nextOffset, 3);
    await f.call("save_artifact", {
      role: "outline",
      name: "提纲",
      content: "结论、源码、借鉴、落地、验证",
      source_artifact_ids: [source],
    });
    for (const key of DEEP_RESEARCH_REPORT_SECTION_KEYS)
      await f.call("save_artifact", {
        role: "report_section",
        name: key,
        content: `源码支持的章节 ${key}`,
        source_artifact_ids: [source],
        report_section_key: key,
        report_section_status: "completed",
      });
    ({ run } = await f.call("save_artifact", {
      role: "report",
      name: "完整报告",
      content: "# 结论\n可按实现建议推进。",
      source_artifact_ids: [source],
    }));
    const report = run.artifacts.at(-1)!.artifactId;
    ({ run } = await f.call("save_artifact", {
      role: "handoff",
      name: "实现交接",
      content: "任务：补全入口校验；验证：npm test",
      source_artifact_ids: [source],
    }));
    const handoff = run.artifacts.at(-1)!.artifactId;
    const complete = {
      report_artifact_id: report,
      handoff_artifact_id: handoff,
      implementation_tasks: ["补全入口校验"],
      recommended_pull_requests: ["入口校验最小变更"],
      verification_commands: ["npm test"],
    };
    ({ run } = await f.call("complete", complete, "complete-call"));
    const durable = new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!;
    const dense = projectDeepResearchProgress({
      ...durable,
      objective: "\u0001".repeat(2000),
      artifacts: Array.from({ length: 2000 }, (_, index) => ({
        ...durable.artifacts[0]!,
        artifactId: `artifact-${index}`,
        name: "\u0001".repeat(240),
        locator: "汉".repeat(4000),
        sourceArtifactIds: Array.from({ length: 100 }, (_, n) => `source-${n}`),
      })),
      handoff: {
        ...durable.handoff!,
        implementationTasks: Array.from({ length: 50 }, () => "汉".repeat(1000)),
      },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(dense)) <= 46 * 1024);
    assert.equal(dense.artifactsCount, 2000);
    assert.ok(dense.artifacts.length <= 8);
    assert.equal(run.status, "completed");
    assert.equal(run.stage, "completed");
    assert.match(
      buildDeepResearchImplementationPrompt(
        new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!,
      ),
      /补全入口校验/,
    );
    assert.match(
      buildDeepResearchImplementationPrompt(
        new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!,
      ),
      /npm test/,
    );
    assert.deepEqual((await f.call("complete", complete, "complete-call")).run, run);
    const repo = new SqliteSessionWorkbarRepository({ storageRoot: f.storageRoot });
    assert.equal(
      repo.queryArtifacts({ sessionId: "research" }).artifacts.length,
      run.artifactsCount,
    );
    const preview = repo.readArtifactChunk({ sessionId: "research", artifactId: report });
    assert.match(Buffer.from(preview.contentBase64, "base64").toString("utf8"), /完整|结论/);
    assert.deepEqual(
      projectDeepResearchProgress(
        new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!,
      ),
      run,
    );
  } finally {
    f.close();
  }
});

test("deep research rejects premature completion, invalid references, request drift and cross-session reads without partial artifacts", async () => {
  const f = fixture();
  try {
    await f.call("start", { objective: "边界校验" });
    await assert.rejects(
      f.call("save_artifact", {
        role: "report_section",
        name: "无证据",
        content: "unsupported",
        source_artifact_ids: ["foreign"],
        report_section_key: "conclusion",
        report_section_status: "completed",
      }),
      /source|unknown|references/,
    );
    assert.equal(
      new SqliteSessionWorkbarRepository({ storageRoot: f.storageRoot }).queryArtifacts({
        sessionId: "research",
      }).artifacts.length,
      0,
    );
    const request = { role: "source", name: "来源", content: "证据", locator: "README.md" };
    const { run } = await f.call("save_artifact", request, "same-key");
    const source = run.artifacts[0]!.artifactId;
    await assert.rejects(
      f.call("save_artifact", { ...request, content: "改变内容" }, "same-key"),
      /Idempotency/,
    );
    await assert.rejects(
      f.call("complete", {
        report_artifact_id: source,
        handoff_artifact_id: source,
        implementation_tasks: ["x"],
        recommended_issues: ["待实现"],
        verification_commands: ["npm test"],
      }),
      /report/,
    );
    await assert.rejects(
      f.call("update_checklist", { item_id: "boundaries", status: "completed" }),
      /evidence/,
    );
    await assert.rejects(
      f.call("update_checklist", { item_id: "boundaries", status: "skipped" }),
      /reason/,
    );
    await assert.rejects(f.call("read_artifact", { artifact_id: source, offset: -1 }), /Invalid/);
    await assert.rejects(f.call("read_artifact", { artifact_id: source, limit: 64001 }), /Invalid/);
    await assert.rejects(f.call("status", { session_id: "other" }), /Invalid/);
    const other = createDeepResearchTools({ storageRoot: f.storageRoot, sessionId: "other" });
    await assert.rejects(
      other
        .find((tool) => tool.name() === "deep_research_read_artifact")!
        .execute(JSON.stringify({ artifact_id: source })),
      /belong/,
    );
    assert.equal(
      new SqliteDeepResearchStore({ storageRoot: f.storageRoot }).read("research")!.artifacts
        .length,
      1,
    );
    withWorkspaceSqliteLease(f.storageRoot, ({ database }) =>
      database.prepare("UPDATE sessions SET archived_at=1 WHERE session_id=?").run("research"),
    );
    await assert.rejects(
      f.call("checkpoint", { round: 1, stage: "knowledge_base", summary: "归档写入" }),
      /unarchived/,
    );
  } finally {
    f.close();
  }
});

test("research resumes older sources through bounded status pages after tool recreation", async () => {
  const f = fixture();
  try {
    await f.call("start", { objective: "恢复长研究的来源索引" });
    const savedIds: string[] = [];
    for (let index = 0; index < 11; index++) {
      const { run } = await f.call("save_artifact", {
        role: "source",
        name: `来源 ${index}`,
        content: `原始证据 ${index}`,
        locator: `src/source-${index}.ts`,
      });
      savedIds.push(run.artifacts.at(-1)!.artifactId);
    }
    await f.call("save_artifact", {
      role: "evidence_note",
      name: "引用全部来源",
      content: "汇总证据",
      source_artifact_ids: savedIds,
    });
    const restarted = createDeepResearchTools({
      storageRoot: f.storageRoot,
      sessionId: "research",
    });
    const status = restarted.find((tool) => tool.name() === "deep_research_status")!;
    const defaultStatus = JSON.parse(await status.execute("{}"));
    assert.equal(defaultStatus.run.artifacts.length, 8);
    assert.ok(
      !defaultStatus.run.artifacts.some(
        (artifact: { artifactId: string }) => artifact.artifactId === savedIds[0],
      ),
    );
    const found: Array<{ artifactId: string; name: string; sourceArtifactIds: string[] }> = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const response = await status.execute(
        JSON.stringify({ artifact_offset: offset, artifact_limit: 3 }),
      );
      assert.ok(Buffer.byteLength(response) <= 46 * 1024);
      const page = JSON.parse(response).artifactPage;
      assert.equal(page.totalArtifacts, 12);
      assert.ok(page.artifacts.length <= 3);
      found.push(...page.artifacts);
      assert.ok(page.nextOffset === undefined || page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(found.length, 12);
    assert.equal(new Set(found.map((artifact) => artifact.artifactId)).size, 12);
    assert.deepEqual(found.at(-1)!.sourceArtifactIds, savedIds);
    const first = found.find((artifact) => artifact.name === "来源 0")!;
    const read = restarted.find((tool) => tool.name() === "deep_research_read_artifact")!;
    assert.equal(
      JSON.parse(await read.execute(JSON.stringify({ artifact_id: first.artifactId }))).content,
      "原始证据 0",
    );
    await assert.rejects(status.execute('{"artifact_offset":-1}'), /Invalid/);
    await assert.rejects(status.execute('{"artifact_limit":51}'), /Invalid/);
    const other = createDeepResearchTools({ storageRoot: f.storageRoot, sessionId: "other" }).find(
      (tool) => tool.name() === "deep_research_status",
    )!;
    assert.deepEqual(
      JSON.parse(await other.execute('{"artifact_offset":0}')).artifactPage.artifacts,
      [],
    );
  } finally {
    f.close();
  }
});
