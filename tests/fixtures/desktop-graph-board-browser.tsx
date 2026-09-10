/// <reference lib="dom" />
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConversationGraphBoard } from "../../apps/desktop/src/renderer/conversation/ConversationGraphBoard.js";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const target = document.getElementById("app")!;
const root = createRoot(target);
const summary = {
  graphId: "history",
  epoch: 1,
  phase: "finished",
  headRevision: 1,
  createdAt: 1,
  counts: { operators: 1, intents: 0, claims: 0, records: 0, resources: 0, wakes: 0 },
};
let listed: (typeof summary)[] = [];
let failList = false;
let failDetail = false;
const calls: { action: string; graphId?: string }[] = [];
Object.assign(window, {
  pico: {
    runtime: {
      "session.graph.query": async (params: { action: string; graphId?: string }) => {
        calls.push(params);
        if (params.action === "list" ? failList : failDetail) {
          return {
            ok: false,
            error: { code: "internal", message: "Graph query unavailable", retryable: true },
          };
        }
        return {
          ok: true,
          value:
            params.action === "list"
              ? { graphs: listed }
              : {
                  summary: listed.find((item) => item.graphId === params.graphId),
                  operators: [{ operatorId: "child", role: "explore", profile: {} }],
                  intents: [],
                  claims: [],
                  records: [],
                  runtimeClaims: [],
                  outputs: [],
                  diagnostics: [],
                  wakes: [],
                },
        };
      },
    },
  },
});

// Control only the board's polling; React keeps the browser's normal scheduling.
const timers = new Map<number, () => void>();
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
let timerId = -1;
window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (delay !== 3_000) return nativeSetTimeout(callback, delay, ...args);
  if (typeof callback !== "function") throw new Error("Expected polling callback");
  const id = timerId--;
  timers.set(id, () => callback(...args));
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (typeof id === "number" && timers.delete(id)) return;
  nativeClearTimeout(id);
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function board() {
  return target.querySelector('[aria-label="Agent Graph"]');
}
async function render(key: string, enabled = false, refreshKey = "idle") {
  await act(async () => {
    root.render(
      <ConversationGraphBoard
        key={key}
        workspacePath="/test"
        sessionId={key}
        enabled={enabled}
        refreshKey={refreshKey}
        onOpenSession={() => undefined}
        onDetails={() => undefined}
      />,
    );
  });
}
async function poll() {
  check(timers.size === 1, "Exactly one retry must be scheduled");
  const [id, callback] = [...timers][0]!;
  timers.delete(id);
  await act(async () => callback());
}

async function main() {
  failList = true;
  await render("ordinary-failed");
  check(!board(), "Ordinary chat must not show a Graph error card after a failed history probe");
  check(calls.length === 1 && timers.size === 0, "Failed history probe must not keep polling");

  failList = false;
  calls.length = 0;
  await render("ordinary-empty");
  check(!board(), "An empty history must not show a Graph board");
  check(calls.length === 1 && timers.size === 0, "Empty history must not fetch detail or poll");

  // A later conversation refresh can still discover history while Graph mode is off.
  listed = [summary];
  await render("ordinary-empty", false, "updated");
  check(
    board() && target.textContent?.includes("已结束"),
    "Existing Graph history must remain visible",
  );
  check(calls.at(-1)?.graphId === "history", "History discovery must fetch the selected Graph");
  check(timers.size === 0, "Finished history does not need polling");
  failList = true;
  await render("ordinary-empty", false, "updated-again");
  check(target.querySelector('[role="alert"]'), "Known history must retain real list errors");
  failList = false;
  await poll();
  check(!target.querySelector('[role="alert"]'), "A successful retry clears history errors");

  failDetail = true;
  await render("history-detail-failed");
  check(
    board() && target.querySelector('[role="alert"]'),
    "Listed history must expose detail errors",
  );
  failDetail = false;
  await poll();
  check(board() && !target.querySelector('[role="alert"]'), "Detail retry must restore history");

  // Multiple epochs remain selectable in ordinary chat, including an active latest epoch.
  listed = [summary, { ...summary, graphId: "current", epoch: 2, phase: "open" }];
  await render("multiple-history");
  const select = target.querySelector<HTMLSelectElement>('[aria-label="Graph 周期"]');
  check(select && select.options.length === 2, "Historical Graph selection must remain available");
  await act(async () => {
    select.value = "history";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  check(calls.at(-1)?.graphId === "history", "Selecting history must query that epoch");
  check(Number(timers.size) === 1, "An open latest epoch must continue polling");

  failList = true;
  await render("enabled-failed", true);
  check(
    board() && target.querySelector('[role="alert"]'),
    "Graph mode must expose initial query errors",
  );
  check(Number(timers.size) === 1, "Graph mode errors must remain retryable");
  failList = false;
  listed = [];
  const retry = [...target.querySelectorAll("button")].find(
    (button) => button.textContent === "重试",
  );
  check(retry, "Error board must provide a retry action");
  await act(async () => retry.click());
  check(!target.querySelector('[role="alert"]'), "Manual retry must clear the error");
  await act(async () => root.unmount());
  check(timers.size === 0, "Unmount must clean up polling");
}

void main().then(
  () => report("PASS: Graph board discovery and query failure recovery"),
  (error: unknown) => report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`),
);

async function report(result: string) {
  document.getElementById("result")!.textContent = result;
  await fetch("/result", { method: "POST", body: result });
}
