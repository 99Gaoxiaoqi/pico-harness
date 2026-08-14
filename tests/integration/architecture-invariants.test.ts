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
// 以下测试追踪 docs/architecture/20 的 P0/P1 债。与 test.todo 不同，这些是**普通测试**：
// 断言"债务表征当前存在"。债务在 → 测试绿；债务被修复 → 表征消失 → 测试红，
// 提醒开发者删除/反转本测试。这是活体追踪——修复落地时由红测试强制显式处理，
// 而不是靠人记。修复对应债务后：删除该测试，或按注释转为正向断言。

test("D7 正向不变量：graph work 去重走 durable lease，records 已降为非权威活跃表", () => {
  // 阶段 2 claim 推广已完成：dispatch 用 RuntimeStore.acquireLease 做执行主权去重
  // （替代 records 扫描），settle 链 records.delete 使 records 降为非权威活跃表，
  // orphan 恢复按 lease 活性（isWorkLeaseLive）判定。
  const manager = readSource("src/tools/delegation-manager.ts");
  // 正向：lease 回源路径与 orphan lease 判定已接入。
  assert.match(manager, /acquireLease/, "DelegationManager 已接入 durable lease 去重");
  assert.match(manager, /isWorkLeaseLive/, "orphan 恢复按 lease 活性判定");
  // 负向：旧的内存负信号与 settleFinalized 标志已移除。
  assert.doesNotMatch(
    manager,
    /\bliveDelegationIds\b/,
    "liveDelegationIds 内存负信号已移除（orphan 改 lease 判定）",
  );
  assert.doesNotMatch(
    manager,
    /\bsettleFinalized\b/,
    "settleFinalized 标志已移除（lease + records.delete 取代）",
  );
});

test("D9 债务追踪：多外壳连接状态/重连两套仍并存（无统一网关层）", () => {
  // P0 机械态债（阶段 3 网关层）：Desktop / daemon-client 各维护一套连接状态机
  // 与重连策略，互不互通——daemon 重启后传输层自愈，renderer 却卡"请重启 Pico
  // 应用"。网关层统一后两套收敛为一套 RuntimeHostConnection（移动端已于 2026-08
  // 移除，不再计入）。
  const desktopModel = readSource("apps/desktop/src/renderer/model.ts");
  const daemonClient = readSource("src/daemon/client.ts");
  // 债务表征：两套状态机定义都还在。任一外壳收敛到网关后对应断言红。
  assert.match(
    desktopModel,
    /\bConnectionState\b/,
    "Desktop ConnectionState 状态机仍在（未收敛到网关）",
  );
  assert.match(
    daemonClient,
    /\breconnectAttempt\b/,
    "daemon client 自维护无限重连（reconnectAttempt 无重试上限）仍在",
  );
  // 阶段 3 网关层统一后：删除本测试（外壳只保留展示层，无自有状态机）。
});

test("D11 债务追踪：Memory rebuild 不重放 overlay mutation（复活链仍在）", () => {
  // P1 叙事态债：forgetFact 后账本保留原始来源，派生重建绕过 forget postcondition
  // ——overlay 意图（Settings/manual-fact/Fact 裁决/审计）无法从账本重建。
  const rebuild = readSource("src/memory/memory-rebuild.ts");
  // 债务表征：rebuild 只重建派生层（Source + Jobs），不触碰 overlay——不重放
  // overlay mutation。overlay 可重建化（或账本镜像 forget 意图）落地后，rebuild
  // 必然开始引用 forgetFact/重放逻辑 → 本断言红。
  assert.doesNotMatch(
    rebuild,
    /\bforgetFact\b/,
    "memory-rebuild 不得重放 overlay mutation（forgetFact 等）；overlay 可重建化后删除本测试",
  );
});

test("D12 债务追踪：transcript 同步实现仍并存（desktop 自持一套）", () => {
  // P1 机械态债（阶段 3 网关层）：Desktop 的 conversationLoadGenerationsRef
  // 应统一吸收进网关客户端（maka 式 RuntimeHostConnection.loadTranscript）。
  // 移动端已于 2026-08 移除，不再计入双实现。
  const desktopRuntime = readSource("apps/desktop/src/renderer/runtime.ts");
  // 债务表征：desktop 的 generation 追踪 ref 还在。被网关吸收后断言红。
  assert.match(
    desktopRuntime,
    /\bconversationLoadGenerationsRef\b/,
    "Desktop transcript generation 追踪仍在（未收敛到网关）",
  );
  // 阶段 3 网关层统一 transcript 同步后：删除本测试。
});
