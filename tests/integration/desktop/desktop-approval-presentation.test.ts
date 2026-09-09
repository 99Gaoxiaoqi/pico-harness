import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalSessionScopeView } from "@pico/protocol";
import type { ApprovalView } from "../../../apps/desktop/src/renderer/model.js";
import { ConversationInteractionSlot } from "../../../apps/desktop/src/renderer/conversation/ConversationInteractionSlot.js";

Object.assign(globalThis, { React });
const base: ApprovalView = {
  id: "approval-1",
  runId: "run-1",
  kind: "tool",
  title: "需要工具审批",
  detail: "需要写入工作区以外的文件",
  risk: "medium",
  toolName: "write_file",
  command: JSON.stringify({ path: "/tmp/report.txt", content: "new" }),
  diff: "-old\n+new",
  providerCallId: "call-1",
};
function render(approval: ApprovalView): string {
  return renderToStaticMarkup(
    React.createElement(ConversationInteractionSlot, {
      approval,
      busy: false,
      onApprovalDecision() {},
      onPromptAnswer() {},
    }),
  );
}

test("审批卡按真实 scope 展示授权范围、单次批准和变更预览", () => {
  const cases: readonly [ApprovalSessionScopeView, string, string][] = [
    [{ type: "file", path: "/tmp/report.txt", access: "edit" }, "允许修改此文件", "仅此文件"],
    [{ type: "all-edits" }, "自动允许文件修改", "权限切换为"],
    [
      {
        type: "directories",
        directories: ["/tmp/reports", "/tmp/docs"],
        access: "read",
        enableAutoEdits: false,
      },
      "加入任务授权目录",
      "/tmp/docs",
    ],
    [
      { type: "directories", directories: ["/tmp/reports"], access: "edit", enableAutoEdits: true },
      "加入任务授权目录",
      "权限切换为",
    ],
    [{ type: "bash-command", command: "git status", match: "exact" }, "允许此命令", "仅匹配此命令"],
    [
      { type: "bash-command", command: "git", match: "prefix" },
      "允许此前缀的命令",
      "所有匹配此前缀的命令",
    ],
    [{ type: "tool", toolName: "search" }, "允许 search 工具", "后续调用此工具"],
  ];
  for (const [sessionScope, label, detail] of cases) {
    const html = render({ ...base, sessionScope });
    for (const text of [
      "写入文件",
      "需要写入工作区以外的文件",
      "仅允许这次",
      "拒绝",
      "文件变更预览",
      "-old",
      "+new",
      label,
      detail,
    ])
      assert.ok(html.includes(text), text);
    assert.ok(html.includes("完整工具参数"));
    assert.match(html, /<strong>路径<\/strong><pre>\/tmp\/report.txt<\/pre>/u);
    assert.match(html, /<details[^>]*><summary>技术详情<\/summary>/u);
    assert.doesNotMatch(html, /本任务内允许|风险等级/u);
  }
});

test("缺少 scope 的审批只提供本次批准与拒绝，计划仍使用原执行操作", () => {
  const html = render(base);
  assert.equal((html.match(/<button /gu) ?? []).length, 2);
  assert.ok(html.includes("仅允许这次"));
  assert.doesNotMatch(html, /授权范围|允许修改此文件|自动允许文件修改/u);
  const plan = render({ ...base, kind: "plan", title: "执行计划", planTitle: "整理报告" });
  assert.ok(plan.includes("整理报告"));
  assert.ok(plan.includes("拒绝并退出"));
  assert.doesNotMatch(plan, /文件变更预览|仅允许这次/u);
});
