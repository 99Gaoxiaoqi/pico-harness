import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveObservedElement,
  type ComputerObservation,
  type ObservedElement,
} from "../../../apps/desktop/src/main/computer-observation-guard.js";

const element: ObservedElement = {
  index: 1,
  role: "AXButton",
  title: "Continue",
  description: "",
  x: 100,
  y: 200,
  width: 80,
  height: 30,
};

test("Computer Use acts only on the current observed element and foreground app", () => {
  const previous: ComputerObservation = {
    id: "observation-a",
    at: 1_000,
    pid: 42,
    elements: [element],
  };
  const valid = {
    previous,
    observationId: "observation-a",
    elementIndex: 1,
    currentPid: 42,
    currentElements: [element],
    now: 2_000,
  };
  assert.deepEqual(resolveObservedElement(valid), element);
  assert.throws(() => resolveObservedElement({ ...valid, currentPid: 43 }), /前台应用已切换/);
  assert.throws(() => resolveObservedElement({ ...valid, now: 40_000 }), /观察已过期/);
  assert.throws(
    () => resolveObservedElement({ ...valid, currentElements: [{ ...element, title: "Delete" }] }),
    /目标元素已变化/,
  );
  assert.throws(() => resolveObservedElement({ ...valid, elementIndex: 2 }), /目标元素已变化/);
});
