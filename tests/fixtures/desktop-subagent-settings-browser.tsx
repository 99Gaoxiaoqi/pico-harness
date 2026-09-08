/// <reference lib="dom" />
import * as React from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  RuntimeConfiguredSubagent,
  RuntimeSubagentPreset,
  RuntimeSubagentSettingsSnapshot,
} from "@pico/protocol";
import { SubagentSettingsPage } from "../../apps/desktop/src/renderer/pages/SubagentSettingsPage.js";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const target = document.getElementById("app")!;
const root = createRoot(target);
const snapshot: RuntimeSubagentSettingsSnapshot = {
  revision: "1",
  presets: [],
  connections: [
    { id: "retired", name: "退役连接", enabled: true, retired: true, models: [] },
    {
      id: "first",
      name: "首选连接",
      enabled: true,
      models: [
        { id: "hidden", offerable: false, thinkingLevels: [] },
        { id: "reasoner", offerable: true, thinkingLevels: ["low", "high"] },
        { id: "fast", offerable: true, thinkingLevels: [] },
      ],
    },
    {
      id: "second",
      name: "第二连接",
      enabled: true,
      models: [{ id: "other", offerable: true, thinkingLevels: ["medium"] }],
    },
  ],
};
const writes: { presets: readonly RuntimeSubagentPreset[]; revision: string }[] = [];
let rejectWrite = false;
let dropWrite = false;
let holdWrite: (() => void) | undefined;
let pendingWrite = false;
let externallyUpdate: (value: RuntimeSubagentSettingsSnapshot) => void;

function Harness({ initial }: { initial: RuntimeSubagentSettingsSnapshot }) {
  const [current, setCurrent] = useState(initial);
  externallyUpdate = setCurrent;
  return (
    <SubagentSettingsPage
      snapshot={current}
      onUpdate={async (presets, revision) => {
        writes.push({ presets, revision });
        if (pendingWrite)
          await new Promise<void>((resolve) => {
            holdWrite = resolve;
          });
        if (rejectWrite) throw new Error("配置已变更，请刷新后重试。");
        const next: RuntimeSubagentSettingsSnapshot = {
          ...current,
          revision: String(Number(current.revision) + 1),
          presets: dropWrite
            ? []
            : presets.map((preset) => ({
                ...preset,
                availability: { status: "available" as const },
              })),
        };
        setCurrent(next);
        return next;
      }}
    />
  );
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function button(name: string): HTMLButtonElement {
  const result = [...target.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name,
  );
  check(result, `Missing button: ${name}`);
  return result;
}
function field(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...target.querySelectorAll("label")].find(
    (item) => item.querySelector("span")?.textContent === name,
  );
  const result = label?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input,textarea,select",
  );
  check(result, `Missing field: ${name}`);
  return result;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function enter(name: string, value: string) {
  await act(async () => {
    const input = field(name);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    check(setter, `Missing setter: ${name}`);
    setter.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
function latest() {
  const value = writes.at(-1);
  check(value, "No configuration write");
  return value;
}
function firstPreset() {
  const value = latest().presets[0];
  check(value, "No preset written");
  return value;
}
async function mount(initial: RuntimeSubagentSettingsSnapshot) {
  await act(async () => root.render(<Harness key={Math.random()} initial={initial} />));
}

async function main() {
  await mount(snapshot);
  check(target.querySelectorAll("button").length === 1, "Empty state must have one CTA");
  await click("新建子 Agent");
  check(
    document.activeElement?.getAttribute("aria-labelledby"),
    "Editor region must receive focus",
  );
  check(field("ID").value === "", "ID must start empty");
  check(field("能力").value === "local_read", "Default profile must be local_read");
  check(
    field("连接").value === "first" && field("模型").value === "reasoner",
    "Default must be first selectable connection and offerable model",
  );
  check(field("思考级别").value === "", "Thinking must default to model default");
  await click("创建");
  check(
    writes.length === 0 && target.querySelector('[aria-invalid="true"]'),
    "Invalid form must show errors without writing",
  );
  await enter("名称", "Code Review");
  check(field("ID").value === "code-review", "Name must derive ID");
  await enter("ID", "stable.review");
  await enter("名称", "Changed Name");
  check(field("ID").value === "stable.review", "Manual ID must stop derivation");
  await enter("名称", "  " + "N".repeat(140));
  check(field("名称").value.trim().length === 128, "Name must respect trimmed limit");
  await enter("名称", "Code Review");
  await enter("使用说明（可选）", " " + "D".repeat(1100));
  check(
    field("使用说明（可选）").value.trim().length === 1000,
    "Description must respect trimmed limit",
  );
  await enter("思考级别", "high");
  await enter("模型", "fast");
  check(!target.textContent?.includes("跟随模型默认"), "Non-thinking model must hide thinking row");
  await enter("模型", "reasoner");
  check(field("思考级别").value === "", "Model change must reset thinking");
  await enter("思考级别", "high");
  await enter("连接", "second");
  check(
    field("模型").value === "other" && field("思考级别").value === "",
    "Connection change must choose first model and clear thinking",
  );
  await enter("能力", "implementation");
  check(
    target.textContent?.includes("隔离 worktree"),
    "Implementation must explain workspace boundary",
  );
  await click("创建");
  check(
    firstPreset().id === "stable.review" && firstPreset().thinkingLevel === undefined,
    "Create must preserve ID and omit default thinking",
  );
  check(
    !("availability" in firstPreset()) && latest().revision === "1",
    "Write must use CAS and exclude Host metadata",
  );
  check(
    document.activeElement === button("新建子 Agent"),
    "Create must return focus to add button",
  );
  await click("新建子 Agent");
  await enter("名称", "Another");
  await enter("ID", "stable.review");
  const beforeDuplicate = writes.length;
  await click("创建");
  check(
    writes.length === beforeDuplicate && target.textContent?.includes("此 ID 已存在"),
    "Duplicate IDs must be rejected without writing",
  );
  await click("取消");
  await click("配置 Code Review");
  check(
    ![...target.querySelectorAll("label")].some(
      (item) => item.querySelector("span")?.textContent === "ID",
    ),
    "Existing ID must be readonly",
  );
  await enter("名称", "Renamed");
  await click("保存");
  check(
    firstPreset().id === "stable.review" && firstPreset().name === "Renamed",
    "Renaming must retain stable ID",
  );
  check(
    document.activeElement === button("配置 Renamed"),
    "Edit must return focus to original row",
  );
  await act(async () => target.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  check(
    firstPreset().enabled === false && latest().revision === "3",
    "List toggle must persist using new revision",
  );
  await click("配置 Renamed");
  window.confirm = () => false;
  const beforeCancelDelete = writes.length;
  await click("删除子 Agent");
  check(writes.length === beforeCancelDelete, "Cancelled deletion must not write");
  window.confirm = () => true;
  await click("删除子 Agent");
  check(
    latest().presets.length === 0 && document.activeElement === button("新建子 Agent"),
    "Deletion must return to empty list and focus add",
  );

  // Critical failure path: rejected/normalized writes keep the form and never silently lose its draft.
  await click("新建子 Agent");
  await enter("名称", "Preserved");
  rejectWrite = true;
  pendingWrite = true;
  await act(async () => {
    button("创建").click();
  });
  check(
    button("返回子 Agent 列表").disabled &&
      button("取消").disabled &&
      field("名称").matches(":disabled"),
    "Pending save must freeze navigation and fields",
  );
  await act(async () => {
    holdWrite?.();
  });
  pendingWrite = false;
  rejectWrite = false;
  check(
    field("名称").value === "Preserved" && target.textContent?.includes("配置已变更"),
    "Failed save must retain draft and show error",
  );
  dropWrite = true;
  await click("创建");
  check(
    field("名称").value === "Preserved" && target.textContent?.includes("保存结果中未找到"),
    "Normalized-away creation must not claim success",
  );
  dropWrite = false;
  await click("取消");

  const invalid: RuntimeConfiguredSubagent = {
    id: "missing",
    name: "Missing",
    description: "",
    profile: "local_read",
    connectionSlug: "deleted",
    model: "old",
    thinkingLevel: "high",
    enabled: true,
    availability: { status: "unavailable", reason: "missing_connection" },
  };
  await mount({
    ...snapshot,
    presets: [
      {
        ...invalid,
        connectionSlug: "second",
        model: "other",
        availability: { status: "available" },
      },
    ],
  });
  await click("配置 Missing");
  check(
    field("思考级别").value === "",
    "Unsupported saved thinking level must display model default",
  );
  await click("保存");
  check(
    firstPreset().thinkingLevel === undefined,
    "Unsupported invisible thinking level must be omitted when saving",
  );
  await mount({ ...snapshot, presets: [invalid] });
  check(target.textContent?.includes("连接已删除"), "Unavailable preset must show problem badge");
  await click("配置 Missing");
  check(
    field("连接").value === "deleted" && field("模型").value === "old",
    "Invalid saved route must remain visible",
  );
  const beforeInvalid = writes.length;
  await click("保存");
  check(
    writes.length === beforeInvalid && target.textContent?.includes("请选择可用的连接"),
    "Invalid route must not save",
  );
  await act(async () => externallyUpdate({ ...snapshot, presets: [] }));
  check(
    document.activeElement === button("新建子 Agent"),
    "External deletion must resolve editor to list",
  );

  const full = Array.from({ length: 64 }, (_, i) => ({
    ...invalid,
    id: `id-${i}`,
    name: `Preset ${i}`,
    enabled: false,
  }));
  await mount({ ...snapshot, presets: full });
  check(button("新建子 Agent").disabled, "64 presets must disable creation");
  check(
    !target.textContent?.includes("连接已删除"),
    "Disabled presets must not show redundant problem badges",
  );
  await act(async () => root.unmount());
}

void main().then(
  () => report("PASS: preset UI lifecycle and failure recovery"),
  (error: unknown) => report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`),
);

async function report(result: string) {
  document.getElementById("result")!.textContent = result;
  await fetch("/result", { method: "POST", body: result });
}
