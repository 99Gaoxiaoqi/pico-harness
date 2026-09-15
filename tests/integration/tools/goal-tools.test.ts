import assert from "node:assert/strict";
import test from "node:test";
import { GoalManager } from "@pico/runtime/goal-manager";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "@pico/pico-host/goal-tools";

test("goal tools preserve the GoalManager lifecycle and bounded budget validation", async () => {
  const manager = new GoalManager({ now: () => 1_700_000_000_000 });
  const create = new CreateGoalTool(manager);
  const get = new GetGoalTool(manager);
  const update = new UpdateGoalTool(manager);

  const created = await create.execute(
    JSON.stringify({
      title: "迁移包边界",
      description: "保持兼容入口与运行时契约",
      budget: { maxTurns: 8, maxTokens: 4096 },
    }),
  );
  assert.match(created, /已创建并激活目标 goal-1/u);
  assert.equal(manager.getActive()?.id, "goal-1");

  const projected = await get.execute("");
  assert.match(projected, /当前激活目标/u);
  assert.match(projected, /8 轮/u);

  const updated = await update.execute(
    JSON.stringify({ id: "goal-1", progress: "Runtime 工具已下沉", status: "blocked" }),
  );
  assert.match(updated, /已更新目标 goal-1/u);
  assert.equal(manager.get("goal-1")?.status, "blocked");
  assert.equal(manager.get("goal-1")?.progress, "Runtime 工具已下沉");
  assert.equal(manager.getActive(), undefined);

  await assert.rejects(
    create.execute(JSON.stringify({ title: "无效预算", description: "应失败", budget: {} })),
    /至少需含一个预算字段/u,
  );
  await assert.rejects(
    update.execute(JSON.stringify({ id: "goal-1", status: "unknown" })),
    /合法值:active\/paused\/blocked\/complete/u,
  );
});
