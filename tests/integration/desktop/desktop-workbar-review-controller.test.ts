import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

test("Workbar review ignores stale diffs, reloads selection on refresh, and isolates workspace", async () => {
  const result = await runRendererBrowserScenario(`
    import * as React from "react";
    import { act } from "react";
    import { createRoot } from "react-dom/client";
    import { PicoTheme } from "./apps/desktop/src/renderer/astryx-provider.tsx";
    import { WorkbarPanelHost } from "./apps/desktop/src/renderer/workbar-panels/WorkbarPanelHost.tsx";
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.getElementById("app"));
    const delayed = {};
    const diffCalls = [];
    let revision = "rev-1";
    let setWorkspace;
    const ok = value => ({ ok: true, value });
    const defer = key => new Promise(resolve => { delayed[key] = resolve; });
    window.pico = {
      runtime: {
        "git.review.snapshot": async ({ source, workspacePath }) => ok({
          revision: workspacePath === "/two" ? "rev-two" : revision,
          branch: "feature/review",
          source,
          files: workspacePath === "/two"
            ? (source === "unstaged" ? [{ path: "z.ts", status: "modified", additions: 1, deletions: 0 }] : [])
            : (source === "unstaged" ? ["a.ts", "b.ts"].map(path => ({ path, status: "modified", additions: 1, deletions: 0 })) : []),
          truncated: false,
        }),
        "git.review.diff": async ({ path, expectedRevision, workspacePath }) => {
          diffCalls.push({ path, expectedRevision, workspacePath });
          const key = workspacePath + ":" + expectedRevision + ":" + path;
          if (key in delayed) return defer(key + ":again");
          if (key === "/one:rev-1:a.ts" || key === "/one:rev-1:b.ts" || key === "/one:rev-2:b.ts" || key === "/one:rev-2:a.ts") return defer(key);
          return ok({ path, revision: expectedRevision, patch: "workspace-two-diff", truncated: false });
        },
      },
      sessionFrames: { subscribe: () => ({ dispose() {} }) },
    };
    const check = (value, message) => { if (!value) throw new Error(message + "\\n" + document.body.innerText); };
    const wait = async (predicate, message) => {
      for (let index = 0; index < 300; index++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(message + "\\n" + document.body.innerText);
    };
    const click = element => act(() => element.click());
    const fileButton = name => [...document.querySelectorAll(".tool-panel__file-group button")].find(button => button.textContent.includes(name));
    function Harness() {
      const [workspace, updateWorkspace] = React.useState("/one");
      setWorkspace = updateWorkspace;
      return <PicoTheme><button id="switch" onClick={() => updateWorkspace("/two")}>switch</button><WorkbarPanelHost
        kind="review" workspacePath={workspace} sessionId="session" instanceId="review" active={true} readOnly={false}
      /></PicoTheme>;
    }
    async function run() {
      await act(async () => root.render(<Harness />));
      await wait(() => fileButton("a.ts") && fileButton("b.ts"), "initial Git snapshot loaded");
      await click(fileButton("a.ts"));
      await wait(() => diffCalls.some(call => call.path === "a.ts"), "first diff requested");
      await click(fileButton("b.ts"));
      await wait(() => diffCalls.some(call => call.path === "b.ts"), "second diff requested");
      act(() => delayed["/one:rev-1:b.ts"](ok({ path: "b.ts", revision: "rev-1", patch: "newer-b-diff", truncated: false })));
      await wait(() => document.querySelector(".tool-panel__diff pre")?.textContent === "newer-b-diff", "newer selection diff displayed");
      act(() => delayed["/one:rev-1:a.ts"](ok({ path: "a.ts", revision: "rev-1", patch: "stale-a-diff", truncated: false })));
      check(document.querySelector(".tool-panel__diff pre")?.textContent === "newer-b-diff", "late old diff cannot replace selected file");
      revision = "rev-2";
      await click(document.querySelector('[aria-label="刷新 Git 变更"]'));
      await wait(() => diffCalls.some(call => call.path === "b.ts" && call.expectedRevision === "rev-2"), "refresh reloads selected diff at new revision");
      check(fileButton("b.ts").getAttribute("aria-pressed") === "true", "refresh retains selection");
      act(() => delayed["/one:rev-2:b.ts"](ok({ path: "b.ts", revision: "rev-2", patch: "refreshed-b-diff", truncated: false })));
      await wait(() => document.querySelector(".tool-panel__diff pre")?.textContent === "refreshed-b-diff", "refreshed diff displayed");
      await click(fileButton("a.ts"));
      await wait(() => diffCalls.some(call => call.path === "a.ts" && call.expectedRevision === "rev-2"), "old workspace request started");
      act(() => setWorkspace("/two"));
      await wait(() => fileButton("z.ts"), "new workspace snapshot loaded");
      act(() => delayed["/one:rev-2:a.ts"](ok({ path: "a.ts", revision: "rev-2", patch: "old-workspace-diff", truncated: false })));
      check(!document.querySelector('[aria-label="a.ts 差异"]'), "old workspace response cannot populate new panel");
      await click(fileButton("z.ts"));
      await wait(() => document.querySelector(".tool-panel__diff pre")?.textContent === "workspace-two-diff", "new workspace diff displayed");
      return "PASS: Workbar diff ordering, refresh, and workspace isolation";
    }
    run().then(value => fetch("/result", { method: "POST", body: value }))
      .catch(error => fetch("/result", { method: "POST", body: "FAIL: " + (error.stack || error.message) }));
  `);
  assert.match(result, /^PASS:/u);
});

test("Tasks controller preserves failed create drafts and reports refresh failure without inviting duplicates", async () => {
  const result = await runRendererBrowserScenario(`
    import * as React from "react";
    import { act } from "react";
    import { createRoot } from "react-dom/client";
    import { PicoTheme } from "./apps/desktop/src/renderer/astryx-provider.tsx";
    import { TasksPanelController } from "./apps/desktop/src/renderer/workbar-panels/TasksPanelController.tsx";
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.getElementById("app"));
    let queryCount = 0;
    let commandCount = 0;
    const ok = value => ({ ok: true, value });
    window.pico = {
      runtime: {
        "session.tasks.query": async () => {
          queryCount++;
          return queryCount === 1 ? ok({ revision: 1, tasks: [] }) : { ok: false, error: { code: "temporary", message: "网络暂时不可用", retryable: true } };
        },
        "session.tasks.command": async params => {
          commandCount++;
          if (commandCount === 1) return { ok: false, error: { code: "revision_conflict", message: "待办版本冲突", retryable: false } };
          return ok({ revision: 2, task: { taskId: "task-1", title: params.title, status: "pending", ordinal: 1, version: 1, createdAt: 1, updatedAt: 1 } });
        },
      },
      sessionFrames: { subscribe: () => ({ dispose() {} }) },
    };
    const check = (value, message) => { if (!value) throw new Error(message + "\\n" + document.body.innerText); };
    const wait = async (predicate, message) => {
      for (let index = 0; index < 300; index++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(message + "\\n" + document.body.innerText);
    };
    const submit = () => act(() => document.querySelector('button[type="submit"]').click());
    async function run() {
      await act(async () => root.render(<PicoTheme><TasksPanelController workspacePath="/workspace" sessionId="session" instanceId="tasks" active={true} readOnly={false}/></PicoTheme>));
      await wait(() => queryCount === 1 && document.querySelector('input[name="workbar-task-title"]'), "initial task ledger loaded");
      const input = document.querySelector('input[name="workbar-task-title"]');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "保留待办草稿");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      submit();
      await wait(() => document.querySelector('[role="alert"]')?.textContent.includes("待办版本冲突"), "failed create reported");
      check(input.value === "保留待办草稿", "failed command preserves title in real controller and panel");
      submit();
      await wait(() => document.querySelector('[role="alert"]')?.textContent.includes("避免重复创建"), "successful create followed by refresh error reported");
      check(commandCount === 2 && queryCount === 2, "one confirmed create and one failed refresh");
      check(input.value === "", "confirmed create clears title even when refresh fails");
      return "PASS: task create draft retained on failure";
    }
    run().then(value => fetch("/result", { method: "POST", body: value }))
      .catch(error => fetch("/result", { method: "POST", body: "FAIL: " + (error.stack || error.message) }));
  `);
  assert.match(result, /^PASS:/u);
});
