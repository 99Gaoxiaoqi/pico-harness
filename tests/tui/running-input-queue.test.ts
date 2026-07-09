import { describe, expect, it } from "vitest";
import { RunningInputQueue } from "../../src/tui/running-input-queue.js";

describe("RunningInputQueue", () => {
  it("enqueue queues normal input in FIFO order", () => {
    const queue = new RunningInputQueue();

    expect(queue.enqueue("first")).toEqual({
      type: "queued",
      item: { kind: "normal", text: "first" },
    });
    expect(queue.enqueue("second")).toEqual({
      type: "queued",
      item: { kind: "normal", text: "second" },
    });

    expect(queue.size).toBe(2);
    expect(queue.drain()).toEqual([
      { kind: "normal", text: "first" },
      { kind: "normal", text: "second" },
    ]);
  });

  it("inject returns steer and inject input immediately without queueing it", () => {
    const queue = new RunningInputQueue();
    queue.enqueue("queued");

    expect(queue.inject("change tone", "steer")).toEqual({
      type: "inject",
      item: { kind: "steer", text: "change tone" },
    });
    expect(queue.inject("context note", "inject")).toEqual({
      type: "inject",
      item: { kind: "inject", text: "context note" },
    });

    expect(queue.size).toBe(1);
    expect(queue.drain()).toEqual([{ kind: "normal", text: "queued" }]);
  });

  it("drain clears the queued input", () => {
    const queue = new RunningInputQueue();
    queue.enqueue("first");
    queue.enqueue("second");

    expect(queue.drain()).toEqual([
      { kind: "normal", text: "first" },
      { kind: "normal", text: "second" },
    ]);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("clear drops queued input and reports how many items were removed", () => {
    const queue = new RunningInputQueue();
    queue.enqueue("first");
    queue.enqueue("second");

    expect(queue.clear()).toBe(2);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it("rejects normal input when the queue reaches capacity", () => {
    const queue = new RunningInputQueue({ maxQueued: 1 });

    expect(queue.enqueue("first").type).toBe("queued");
    expect(queue.enqueue("second")).toEqual({
      type: "rejected",
      reason: "full",
      capacity: 1,
    });

    expect(queue.drain()).toEqual([{ kind: "normal", text: "first" }]);
  });
});
