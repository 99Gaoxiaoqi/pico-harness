import { describe, expect, it, vi } from "vitest";
import {
  HookRewakeCoordinator,
  HookRewakeQueue,
  type HookRewakeEntry,
} from "../../src/runtime/session-runtime.js";

describe("Hook asyncRewake integration", () => {
  it("运行期先有界合并，空闲后只续跑一次", async () => {
    let idle = false;
    const delivered: HookRewakeEntry[][] = [];
    const resumes: string[][] = [];
    const queue = new HookRewakeQueue(async (entries) => delivered.push([...entries]));
    const coordinator = new HookRewakeCoordinator({
      queue,
      isIdle: () => idle,
      resume: async (ids, deliver) => {
        resumes.push([...ids]);
        await deliver();
      },
    });
    try {
      expect(queue.enqueue("first")).toBe(true);
      expect(queue.enqueue("second")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resumes).toHaveLength(0);

      idle = true;
      coordinator.notifyIdle();
      await vi.waitFor(() => expect(resumes).toHaveLength(1));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.map((entry) => entry.message)).toEqual(["first", "second"]);
      expect(queue.hasPending).toBe(false);
    } finally {
      coordinator.dispose();
      queue.close();
    }
  });

  it("会话关闭后拒绝迟到的异步回调", () => {
    const queue = new HookRewakeQueue(async () => undefined, 1);
    expect(queue.enqueue("before-close")).toBe(true);
    expect(queue.enqueue("over-capacity")).toBe(false);
    queue.close();
    expect(queue.enqueue("late")).toBe(false);
  });
});
