import { describe, expect, it } from "vitest";
import { pickFocusedDialog, type DialogRequest } from "../../src/tui/dialog-arbiter.js";

describe("pickFocusedDialog", () => {
  it("returns only the highest-priority active dialog as focused", () => {
    const requests: DialogRequest[] = [
      { id: "slash-help", layer: "overlay", priority: 10, content: "slash help" },
      { id: "permissions", layer: "modal", priority: 50, content: "permissions" },
      { id: "background-task", layer: "overlay", priority: 20, content: "task" },
    ];

    const focused = pickFocusedDialog(requests);

    expect(focused).toEqual({
      id: "permissions",
      layer: "modal",
      priority: 50,
      content: requests[1]?.content,
      focused: true,
    });
  });

  it("ignores inactive dialogs and keeps request order for priority ties", () => {
    const requests: DialogRequest[] = [
      { id: "stale", layer: "modal", priority: 100, active: false, content: "stale" },
      { id: "first", layer: "overlay", priority: 10, content: "first" },
      { id: "second", layer: "modal", priority: 10, content: "second" },
    ];

    expect(pickFocusedDialog(requests)?.id).toBe("first");
  });

  it("returns null when no dialog is active", () => {
    expect(pickFocusedDialog([])).toBeNull();
    expect(
      pickFocusedDialog([{ id: "hidden", layer: "modal", active: false, content: "hidden" }]),
    ).toBeNull();
  });
});
