import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  readFileSync(join(repositoryRoot, relativePath), "utf8");

test("事件账本无事件级 GC（append-only 不变量）", () => {
  // 19 文档 1.8：事件账本内没有事件级 GC，无 prune/trim/prune。
  // 唯一删除是 deleteSession 的整会话级联（SQLite 迁移后为删行），不是事件级回收。
  const store = readSource("src/storage/sqlite/sqlite-runtime-event-store.ts");
  // 排除 recover/repair（崩溃恢复，不是 GC）；只针对 GC 语义的回收动词。
  assert.doesNotMatch(
    store,
    /\b(?:pruneEntries|trimEvents|garbageCollectEvents|evictEvents)\s*\(/,
    "事件账本不得引入事件级 GC；唯一删除是 deleteSession 整目录",
  );
});

test("appendBatch 是 RuntimeEventStore 内唯一写原语", () => {
  // 19 文档 1.2：appendSessionState/appendTranscriptEvent/appendPlanOperation
  // 全是 appendBatch 的包装（SQLite 迁移后契约不变，ADR 24）。
  const store = readSource("src/storage/sqlite/sqlite-runtime-event-store.ts");
  assert.match(store, /\bappendBatch\b/, "appendBatch 必须存在为唯一写原语");
  // 文档声称的写包装都应存在（委托 appendBatch）。
  for (const wrapper of ["appendSessionState", "appendTranscriptEvent", "appendPlanOperation"]) {
    assert.match(store, new RegExp(`\\b${wrapper}\\b`), `${wrapper} 应作为 appendBatch 的包装存在`);
  }
});

test("投影入口 RuntimeProjectionService 不直接持久化（无第二事实源）", () => {
  // 19 文档 1.4：RuntimeProjectionService 是读模型入口，从账本重算，不写事实。
  const projection = readSource("src/engine/runtime-projection-service.ts");
  // 投影服务不得直接调用账本的写原语（它是纯读侧）。
  assert.doesNotMatch(
    projection,
    /\bappendBatch\b|\.append\(|appendPlanOperation/,
    "RuntimeProjectionService 是读模型，不得调用账本写原语",
  );
});

test("压缩不改账本、只追加 checkpoint（读模型变化）", () => {
  // 19 文档 3.3：压缩永不改账本、永不删事件，只追加 context.checkpoint.recorded。
  const compactor = readSource("src/context/compactor.ts");
  // 压缩器不得调用账本写/删原语（它只产出供投影使用的 summary，写入由 engine 负责）。
  assert.doesNotMatch(
    compactor,
    /\bappendBatch\b|appendPlanOperation|deleteSession\b/,
    "Compactor 不得直接写/删账本；压缩只产出 summary，checkpoint 追加由 engine 负责",
  );
});

// --- 已知架构债（活体追踪器）-----------------------------------------------
// 以下测试追踪 docs/architecture/20 的 P0/P1 债。与 test.todo 不同，这些是**普通测试**：
// 断言"债务表征当前存在"。债务在 → 测试绿；债务被修复 → 表征消失 → 测试红，
// 提醒开发者删除/反转本测试。这是活体追踪——修复落地时由红测试强制显式处理，
// 而不是靠人记。修复对应债务后：删除该测试，或按注释转为正向断言。

test("D7 正向不变量：DelegationManager 不再承担 graph 调度职责", () => {
  // Graph v2 的去重、claim 与收口已归持久化调度器所有。DelegationManager
  // 只管普通委派与 plan settle，不再接收 graph 身份、lease 或 settle 回调。
  const manager = readSource("src/tools/delegation-manager.ts");
  assert.doesNotMatch(manager, /graphWorkId/, "DelegationManager 不得携带 graph work 身份");
  assert.doesNotMatch(manager, /GraphWorkLease/, "DelegationManager 不得消费 graph lease");
  assert.doesNotMatch(manager, /onGraphWorkSettled/, "DelegationManager 不得回调 graph settle 链");
  assert.doesNotMatch(manager, /\bliveDelegationIds\b/, "liveDelegationIds 内存负信号已移除");
  assert.doesNotMatch(
    manager,
    /\bsettleFinalized\b/,
    "settleFinalized 标志已移除（lease + records.delete 取代）",
  );
});

test("D10 正向不变量：旧 graph work lease 协议已删除", () => {
  // Graph v2 由 SQLite Provision/Claim CAS 与 exact RuntimeRun admission 持有执行主权，
  // 不再保留 v1 DelegationManager graph work lease 协议。
  const manager = readSource("src/tools/delegation-manager.ts");
  assert.equal(existsSync(join(repositoryRoot, "src/graph/work-lease.ts")), false);
  assert.doesNotMatch(manager, /GRAPH_WORK_LEASE_TTL_MS|graphWorkLeaseKey|heartbeatGraphWorkLease/);
});

test("D9 正向不变量：连接决策在监督器与共享 client，外壳只渲染推送相位", () => {
  // P0 机械态债已消除（3-C，2026-08-15）：连接探活/降级/恢复广播收口在主进程
  // runtime-supervisor，重连/重生/重试在共享 client（src/daemon/client.ts 的
  // RuntimeSubscription 重连环 + KERNEL_RETRY_SAFE_METHODS 幂等重试）——全仓
  // 唯一的连接状态机。渲染层不再自维护 ConnectionState，只消费 unavailable/
  // recovered 推送事件展示 AppRuntimePhase（fail-stuck 随 recovered 自动
  // re-bootstrap 消除）。
  const desktopModel = readSource("apps/desktop/src/renderer/model.ts");
  const supervisor = readSource("apps/desktop/src/main/runtime-supervisor.ts");
  const daemonClient = readSource("src/daemon/client.ts");
  // 负向：外壳自维护状态机定义已移除。
  assert.doesNotMatch(
    desktopModel,
    /\bConnectionState\b/,
    "渲染层不得自维护 ConnectionState（决策在监督器与共享 client，展示相位为 AppRuntimePhase）",
  );
  // 正向：监督器提供降级/恢复双相位广播；共享 client 保有唯一重连状态机。
  assert.match(
    supervisor,
    /"unavailable" \| "recovered"/,
    "监督器应广播 unavailable/recovered 双相位",
  );
  assert.match(daemonClient, /\breconnectAttempt\b/, "共享 client 是全仓唯一重连状态机");
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

test("D12 正向不变量：transcript 分页算法只在 daemon 服务层，renderer 仅持视图竞态护栏", () => {
  // P1 机械态债已消除（3-C 重评后反转，2026-08-15）：“transcript 同步双实现”的
  // 实质是 Desktop 与移动端各自维护一套同步状态机，移动端移除（bc9efbd3）后已
  // 消解。剩余的过期响应护栏是视图层竞态职责（与 workspaceLoadGenerationRef 同
  // 类），不应下沉传输层——收编为单一职责模块 ConversationLoadTracker，分页/
  // 游标算法保持只在 daemon 服务层一处。
  const desktopRuntime = readSource("apps/desktop/src/renderer/runtime.ts");
  const tracker = readSource("apps/desktop/src/renderer/conversation-load-tracker.ts");
  const daemonTranscript = readSource("src/daemon/desktop-transcript.ts");
  // 负向：renderer 裸 ref 形态的 generation 追踪已收编。
  assert.doesNotMatch(
    desktopRuntime,
    /\bconversationLoadGenerationsRef\b/,
    "transcript 加载护栏应收编在 ConversationLoadTracker（分页算法不得进 renderer）",
  );
  // 正向：护栏模块存在且只做代数判定；分页/游标算法在 daemon 服务层唯一所在。
  assert.match(tracker, /\bisCurrent\b/, "ConversationLoadTracker 提供过期加载判定");
  assert.match(
    daemonTranscript,
    /\bselectPage\b/,
    "transcript 分页/游标算法在 daemon 服务层唯一实现",
  );
});

test("D14 正向不变量：src/tui 零引擎装配，连接���一经共享 client（3-D Phase 5）", () => {
  // 3-D 终态架构（2026-08-15，Phase 5 扩展到整个 src/tui）：交互 TUI =
  // daemon 瘦客户端——in-process repl 装配链已删除，src/tui 全目录不得
  // import 引擎装配面（engine session 构建、globalSessionManager、bundle
  // 装配），引擎执行唯一在 daemon 侧；连接/重连/重生唯一经 LocalRuntimeClient
  // （与 Desktop/cron 同一实现，全仓连接状态机数 = 1）。
  const tuiDir = join(repositoryRoot, "src", "tui");
  const tuiSources = readdirSync(tuiDir).filter((name) => /\.(ts|tsx)$/.test(name));
  assert.ok(
    tuiSources.length > 40,
    `src/tui 应有大量模块（实际 ${tuiSources.length}），扫描疑似失效`,
  );
  // 引擎 wire 契约例外：tool-result-contract 是 transcript 数据形状工厂
  // （投影层合法消费），不是引擎装配。
  const ALLOWED_ENGINE_VALUE_IMPORTS = new Set(["../engine/tool-result-contract.js"]);
  for (const name of tuiSources) {
    const source = readSource(`src/tui/${name}`);
    // 引擎/运行时装配面 import：只允许 type 契约或白名单数据形状。
    for (const match of source.matchAll(
      /import\s+(type\s+)?(?:\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)\s+from\s+"(\.\.\/(?:engine|runtime)\/[^"]+)";/g,
    )) {
      const isTypeOnly = Boolean(match[1]);
      const importedFrom = match[2] ?? "(unknown)";
      if (isTypeOnly || ALLOWED_ENGINE_VALUE_IMPORTS.has(importedFrom)) continue;
      assert.fail(
        `${name} 不得 value import 引擎装配面（${importedFrom}）；引擎执行唯一在 daemon 侧，type 契约与 tool-result-contract 数据形状除外`,
      );
    }
    assert.doesNotMatch(
      source,
      /\bglobalSessionManager\b/,
      `${name} 不得触碰进程内会话管理器（会话独占在 daemon 侧持有）`,
    );
  }
  // 正向：客户端经共享连接入口（LocalRuntimeClient）接入 kernel。
  const clientRepl = readSource("src/tui/client-repl.tsx");
  assert.match(
    clientRepl,
    /\bLocalRuntimeClient\b/,
    "客户端壳经共享 LocalRuntimeClient 连接（连接状态机唯一）",
  );
});
