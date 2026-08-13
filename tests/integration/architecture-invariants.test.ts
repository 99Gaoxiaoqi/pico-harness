import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * 架构不变量测试：把 docs/architecture/19-concepts-map.md 的核心断言变成可运行检查。
 *
 * 这些测试冻结 pico 的 4 条设计原则在叙事态（最干净的一态，4/5）的落地，防止
 * 未来重构/补丁无意破坏。每条测试对应 19 文档的一处断言，改实现前必须同步改测试
 * ——测试就是原则的"牙齿"。详见 docs/architecture/20-architecture-audit-and-governance.md。
 */
const repositoryRoot = resolve(import.meta.dirname, "../..");
const readSource = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

test("事件账本无事件级 GC（append-only 不变量）", () => {
  // 19 文档 1.8：事件账本内没有事件级 GC，无 prune/trim/prune。
  // 唯一删除是 deleteSession 的整目录级联，不是事件级回收。
  const store = readSource("src/storage/runtime-event-store.ts");
  // 排除 recover/repair（崩溃恢复，不是 GC）；只针对 GC 语义的回收动词。
  assert.doesNotMatch(
    store,
    /\b(?:pruneEntries|trimEvents|garbageCollectEvents|evictEvents)\s*\(/,
    "事件账本不得引入事件级 GC；唯一删除是 deleteSession 整目录",
  );
});

test("appendBatch 是 RuntimeEventStore 内唯一写原语", () => {
  // 19 文档 1.2：append/appendSessionState/appendTranscriptEvent/appendPlanOperation/
  // appendGraphOperation 全是 appendBatch 的包装。
  const store = readSource("src/storage/runtime-event-store.ts");
  assert.match(store, /\bappendBatch\b/, "appendBatch 必须存在为唯一写原语");
  // 文档声称的写包装都应存在（委托 appendBatch）。
  for (const wrapper of [
    "appendSessionState",
    "appendTranscriptEvent",
    "appendPlanOperation",
    "appendGraphOperation",
  ]) {
    assert.match(
      store,
      new RegExp(`\\b${wrapper}\\b`),
      `${wrapper} 应作为 appendBatch 的包装存在`,
    );
  }
});

test("投影入口 RuntimeProjectionService 不直接持久化（无第二事实源）", () => {
  // 19 文档 1.4：RuntimeProjectionService 是读模型入口，从账本重算，不写事实。
  const projection = readSource("src/engine/runtime-projection-service.ts");
  // 投影服务不得直接调用账本的写原语（它是纯读侧）。
  assert.doesNotMatch(
    projection,
    /\bappendBatch\b|\.append\(|appendPlanOperation|appendGraphOperation/,
    "RuntimeProjectionService 是读模型，不得调用账本写原语",
  );
});

test("压缩不改账本、只追加 checkpoint（读模型变化）", () => {
  // 19 文档 3.3：压缩永不改账本、永不删事件，只追加 context.checkpoint.recorded。
  const compactor = readSource("src/context/compactor.ts");
  // 压缩器不得调用账本写/删原语（它只产出供投影使用的 summary，写入由 engine 负责）。
  assert.doesNotMatch(
    compactor,
    /\bappendBatch\b|appendPlanOperation|appendGraphOperation|deleteSession\b/,
    "Compactor 不得直接写/删账本；压缩只产出 summary，checkpoint 追加由 engine 负责",
  );
});

// --- 已知架构债（活体追踪器）-----------------------------------------------
// 以下测试追踪 docs/architecture/20 的 P0/P1 债。标记为 todo：当前债存在（预期），
// 对应修复落地后转为正向断言。todo 测试不阻塞 CI，但让债务在测试套件里可见、可检索。

test(
  "DelegationManager.records 应可重建或标为非权威缓存",
  {
    todo: "P0 调度态债（阶段 2 claim 推广）：records 当前是不可持久化的事实权威（孤儿检测依赖重启清空）。" +
      "修复方向——用 RuntimeStore.acquireLease 给 graph work 套 durable lease，records 降为非权威缓存，" +
      "orphan 恢复按 lease 活性判定。修复后本测试转为断言 records 有 rebuild/lease 回源路径。",
  },
  () => {
    const manager = readSource("src/tools/delegation-manager.ts");
    // 当前预期：records 既无 rebuild 路径、也无 delete（只增不删的事实权威）。
    // 修复后这两个断言应反转。
    assert.doesNotMatch(manager, /\brestore\b|\bhydrate\b|replaceFromAuthority/);
  },
);
