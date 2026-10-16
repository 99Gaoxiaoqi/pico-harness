import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MemoryExtractionJobs } from "../../../apps/desktop/src/renderer/pages/MemoryPolicySection.js";
Object.assign(globalThis, { React });

test("pending panel distinguishes unknown, zero, processing and blocked; raw errors never render", () => {
  const render = (jobs?: Parameters<typeof MemoryExtractionJobs>[0]["jobs"]) =>
    renderToStaticMarkup(React.createElement(MemoryExtractionJobs, { jobs, now: 3_600_001 }));
  assert.match(render(), /无法判断待办数量/);
  assert.doesNotMatch(render(), /排队：0/);
  const empty = render({ pending: 0, working: 0, blocked: 0, reasons: [] });
  assert.match(empty, /排队：0/);
  const active = render({
    pending: 2,
    working: 1,
    blocked: 3,
    oldestPendingAt: 1,
    reasons: [
      { reason: "model_unavailable", count: 2 },
      { reason: "secret /private/path exception", count: 1 },
    ],
  });
  for (const label of [
    "排队：2",
    "处理中：1",
    "需处理：3",
    "1 小时",
    "模型暂不可用",
    "其他原因，暂无法保存",
  ])
    assert.ok(active.includes(label), label);
  assert.doesNotMatch(active, /secret|private|exception/);
});
