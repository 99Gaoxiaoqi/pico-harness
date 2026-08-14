import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["src", "apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_DECLARATION =
  /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([\s\S]*?)(\s+from\s+)?["']([^"']+)["']\s*;?/g;
// Dynamic import() is a runtime load and must be visible to the gate:
// `await import("../runtime/private.js")` previously slipped through entirely.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * These are deliberately explicit, temporary exceptions. They make the gate useful before the
 * remaining legacy edges are migrated: a newly introduced edge fails immediately, while the
 * existing debt remains visible in the command output and in the baseline file.
 */
const BASELINE_PATH = resolve(REPOSITORY_ROOT, "scripts/architecture-boundaries-baseline.json");

/**
 * 手写超时原语白名单（2026-08-13 全仓共现扫描基线，逐文件核验后落档）。
 *
 * 语义：同文件同时出现 `new Promise` 构造与 `setTimeout` 调用，即手写
 * "Promise + 定时器"原语（race-with-deadline 的雏形），应统一收敛到
 * src/util/race-with-deadline.ts。全仓实测共现 31 个文件，其中：
 *
 * - canonical（1）：race-with-deadline.ts 是统一原语本体，豁免。
 * - 误报（3）：setTimeout 与 new Promise 无语义关联——auth 超时定时器直接
 *   destroy socket、pending 队列 promise + worker 调度 debounce、ws close
 *   事件 promise + 独立 auth 定时器。setTimeout 不在任何 Promise executor 内。
 * - 既有手写原语（27）：delay/sleep helper 与请求/握手超时包装，收敛迁移候选。
 *   规则只拦截新增文件/新增共现，既有无声豁免（与 baseline 哲学一致，避免
 *   破坏 --strict 的"0 条受控边界记录"断言）。
 */
const HANDWRITTEN_TIMEOUT_WHITELIST = new Map([
  // canonical：统一超时/排空原语本体。
  ["src/util/race-with-deadline.ts", "canonical 原语本体"],
  // 误报：setTimeout 不在 Promise executor 内，与 new Promise 无因果。
  ["src/daemon/server.ts", "误报：auth 超时定时器直接 destroy socket，promise 为事件驱动"],
  ["src/memory/worker.ts", "误报：pending 队列 promise + worker 调度 debounce 定时器"],
  // 既有手写超时原语（收敛迁移候选）。
  ["src/approval/manager.ts", "既有：审批等待超时包装（executor 内 setTimeout reject）"],
  ["src/code-intelligence/lsp-client.ts", "既有：LSP 请求超时 / 子进程 SIGKILL 升级（2 处）"],
  ["src/daemon/client.ts", "既有：connectWithTimeout 超时包装"],
  ["src/daemon/instance-lock.ts", "既有：runtime.ping 超时包装"],
  ["src/daemon/ipc-auth.ts", "既有：Windows 工具执行超时包装"],
  ["src/hooks/executors/executor.ts", "既有：SIGKILL 升级超时"],
  ["src/input/cron-daemon-bridge.ts", "既有：daemon 启动重试退避 sleep"],
  ["src/input/user-config-store.ts", "既有：delay() helper"],
  ["src/internal/headless-one-shot-runner.ts", "既有：delay() helper / cancel 超时"],
  ["src/mcp/http-client.ts", "既有：请求超时包装"],
  ["src/mcp/stdio-client.ts", "既有：请求超时 / waitForChildExit 包装（多处）"],
  ["src/mcp/user-config-store.ts", "既有：delay() helper"],
  ["src/os/process-tree.ts", "既有：waitForExit 超时包装"],
  ["src/provider/provider-operation-journal.ts", "既有：delay() helper"],
  ["src/provider/retry.ts", "既有：sleep/abortableSleep（canonical 注释引为 clearTimeout 范式）"],
  ["src/runtime/agent-recoverable-task-adapter.ts", "既有：delay() helper"],
  ["src/runtime/runtime-run.ts", "既有：事件写重试退避（3 处）"],
  ["src/safety/background-yolo-policy.ts", "既有：hook 超时 fail-closed"],
  ["src/storage/atomic-json.ts", "既有：sleep() helper"],
  ["src/storage/file-history-mutation-lease.ts", "既有：租约冲突重试退避"],
  ["src/storage/local-file-storage.ts", "既有：租约冲突重试退避"],
  ["src/storage/owner-lease.ts", "既有：租约冲突重试退避"],
  ["src/tasks/worktree-supervisor.ts", "既有：waitForSettlement 超时包装"],
  ["src/tools/background-manager.ts", "既有：后台任务等待超时"],
  ["src/tools/bash.ts", "既有：bash 执行超时 / 强杀定时器"],
  ["src/tui/system-actions.ts", "既有：进程执行超时（2 处）"],
  ["src/tui/terminal-grid.ts", "既有：grid 读取超时"],
  // runtime-host 骨架移植（阶段 3-A）：连接机制层的退避/握手超时/idle drain，
  // 移植自 runtime-host 模式，非业务超时原语，不收敛到 race-with-deadline。
  ["packages/runtime-host/src/client/connect-or-spawn.ts", "骨架：选举退避 sleep（backoff 抖动）"],
  ["packages/runtime-host/src/client/connection.ts", "骨架：握手/连接/request 超时"],
  ["packages/runtime-host/src/control/artifact-writer-bootstrap-lock.ts", "骨架：flock 自旋 sleep"],
  ["packages/runtime-host/src/server/host-kernel.ts", "骨架：idle drain / shutdown grace 定时器"],
  ["packages/runtime-host/src/server/connection-session.ts", "骨架：operation server-side deadline（挂死 handler 防泄漏）"],
  ["packages/runtime-host/src/transport/framed-transport.ts", "骨架：帧读超时"],
]);

function normalizeRelativePath(path, repositoryRoot = REPOSITORY_ROOT) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function resolveImportPath(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const requested = resolve(dirname(importer), specifier);
  const candidates = [requested];
  if (extname(requested) === ".js" || extname(requested) === ".jsx") {
    candidates.unshift(
      requested.replace(/\.(?:js|jsx)$/, ".ts"),
      requested.replace(/\.(?:js|jsx)$/, ".tsx"),
    );
  } else if (!extname(requested)) {
    candidates.push(`${requested}.ts`, `${requested}.tsx`);
  }
  candidates.push(resolve(requested, "index.ts"), resolve(requested, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate));
}

function sourceArea(path, repositoryRoot) {
  const normalized = normalizeRelativePath(path, repositoryRoot);
  if (normalized.startsWith("src/input/")) return "input";
  if (normalized.startsWith("src/provider/")) return "provider";
  if (normalized.startsWith("src/engine/")) return "engine";
  if (normalized.startsWith("src/daemon/")) return "daemon";
  if (normalized.startsWith("src/runtime/")) return "runtime";
  return undefined;
}

function isDaemonBarrel(path, repositoryRoot) {
  return normalizeRelativePath(path, repositoryRoot) === "src/daemon/index.ts";
}

function isPureTypeImport(declaration) {
  return declaration.typeOnly;
}

function classifyViolation(importer, target, declaration, repositoryRoot, fromArea, toArea) {
  // 单文件精确规则（对抗审查 C）：DelegationManager 承载 graph/plan 调度职责，
  // 但 import 级全面禁止 tools→graph 会误伤合法的 graph-tools.ts，因此只禁
  // src/tools/delegation-manager.ts 直接 import src/graph/ 或 src/runtime/ 下
  // 的任何模块（value 或 type）。与 graph 的耦合必须走回调（onGraphWorkSettled
  // 等）解耦——规则只禁 import，不禁回调。
  const importerRelative = normalizeRelativePath(importer, repositoryRoot);
  if (importerRelative === "src/tools/delegation-manager.ts") {
    const targetRelative = normalizeRelativePath(target, repositoryRoot);
    if (
      targetRelative.startsWith("src/graph/") ||
      targetRelative.startsWith("src/runtime/")
    ) {
      return "delegation-manager-scheduling-leak";
    }
  }
  // fromArea/toArea override the raw areas for neutral files whose effective area is
  // derived from their re-exports (see effectiveSourceArea).
  const from = fromArea ?? sourceArea(importer, repositoryRoot);
  const to = toArea ?? sourceArea(target, repositoryRoot);
  if (!from || !to) return undefined;

  if (from === "input" && to === "daemon" && isDaemonBarrel(target, repositoryRoot)) {
    return "input-to-daemon-barrel";
  }
  // Engine may not reach into Runtime even for types: contracts belong to Engine or neutral
  // storage. Type-only imports are exempt only after directional implementation rules run.
  if (from === "engine" && to === "runtime") return "engine-to-runtime-implementation";
  // Other pure type imports express contract dependencies without loading implementations.
  if (isPureTypeImport(declaration)) return undefined;
  if (from === "provider" && to === "input") return "provider-to-input-concrete";
  return undefined;
}

function parseImportsFromSource(source) {
  const imports = [];
  for (const match of source.matchAll(IMPORT_DECLARATION)) {
    const [, kind, typeModifier, clause, fromPart, specifier] = match;
    if (!specifier || !kind) continue;
    // A non-empty clause without a `from` keyword is not a valid import/export-from
    // declaration: `export const notes = "../runtime/private.js"` is a string literal,
    // not an import. Bare `import "module"` (side-effect import, empty clause) and
    // `export * from "..."` (has `from`) stay valid.
    if (clause.trim() && !fromPart) continue;
    imports.push({
      specifier,
      typeOnly: typeModifier?.trim() === "type",
      clause: clause ?? "",
    });
  }
  // Dynamic import() is always a runtime load: never type-only, never an export.
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    imports.push({ specifier: match[1], typeOnly: false, clause: "", dynamic: true });
  }
  return imports;
}

function parseImports(file) {
  return parseImportsFromSource(stripComments(readFileSync(file, "utf8")));
}

/**
 * Re-export statements on a file (`export * from`, `export { x } from`,
 * `export type * from`, `export type { x } from`). A neutral file that re-exports
 * protected content is a pass-through of that area, not a neutral wall.
 */
function parseReExports(source) {
  const specifiers = [];
  for (const match of source.matchAll(/export[\s\S]*?from\s+["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Effective source area of a file: its declared area, or — for files in the neutral
 * zone (sourceArea === undefined) — the area of the first protected file they
 * re-export from. Neutral chains are followed recursively; re-export cycles between
 * neutral files resolve to neutral. Conservative: when several areas are re-exported,
 * the first protected hit wins (over-reporting is preferred over blind spots).
 */
function effectiveSourceArea(path, repositoryRoot, cache, source, visiting = new Set()) {
  if (cache.has(path)) return cache.get(path);
  if (visiting.has(path)) return undefined;
  visiting.add(path);
  let area = sourceArea(path, repositoryRoot);
  if (!area) {
    const text = source ?? stripComments(readFileSync(path, "utf8"));
    for (const specifier of parseReExports(text)) {
      const target = resolveImportPath(path, specifier);
      if (!target) continue;
      area = effectiveSourceArea(target, repositoryRoot, cache, undefined, visiting);
      if (area) break;
    }
  }
  visiting.delete(path);
  cache.set(path, area);
  return area;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return new Map();
  const records = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return new Map(
    records.map((record) => [`${record.rule}|${record.source}|${record.target}`, record]),
  );
}

/**
 * Scan source imports and return both current violations and the subset covered by the explicit
 * legacy baseline. This function is exported so integration tests can exercise the gate without
 * duplicating its import-resolution logic.
 */
export function scanArchitectureBoundaries({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(repositoryRoot, root)),
  );
  const areaCache = new Map();
  const violations = [];
  for (const importer of sourceFiles) {
    const source = stripComments(readFileSync(importer, "utf8"));
    const fromArea = effectiveSourceArea(importer, repositoryRoot, areaCache, source);
    for (const declaration of parseImportsFromSource(source)) {
      const target = resolveImportPath(importer, declaration.specifier);
      if (!target) continue;
      const toArea = effectiveSourceArea(target, repositoryRoot, areaCache);
      const rule = classifyViolation(
        importer,
        target,
        declaration,
        repositoryRoot,
        fromArea,
        toArea,
      );
      if (!rule) continue;
      violations.push({
        rule,
        source: normalizeRelativePath(importer, repositoryRoot),
        target: normalizeRelativePath(target, repositoryRoot),
        specifier: declaration.specifier,
      });
    }
  }
  return violations.sort((left, right) =>
    `${left.rule}|${left.source}|${left.target}`.localeCompare(
      `${right.rule}|${right.source}|${right.target}`,
    ),
  );
}

/**
 * 横切原语唯一性：超时/排空原语应统一用 src/util/race-with-deadline.ts 的
 * raceWithDeadline / raceWithDeadlineReject，不得在别处重新定义本地副本。
 * 新增本地定义即违规（baseline 容纳过渡期存量，收敛后清空）。
 */
const CROSS_CUTTING_PRIMITIVES = [
  "settleWithinDeadline",
  "settlesWithin",
  "settleWithin",
  "withTimeout",
];

export function scanCrossCuttingDefinitions({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(repositoryRoot, root)),
  );
  const violations = [];
  for (const file of sourceFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const name of CROSS_CUTTING_PRIMITIVES) {
      const pattern = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\b`, "g");
      for (const _match of source.matchAll(pattern)) {
        violations.push({
          rule: "cross-cutting-duplicate-definition",
          source: normalizeRelativePath(file, repositoryRoot),
          target: name,
        });
      }
    }
  }
  return violations.sort((left, right) =>
    `${left.rule}|${left.source}|${left.target}`.localeCompare(
      `${right.rule}|${right.source}|${right.target}`,
    ),
  );
}

/**
 * 手写超时原语语义化检测：同文件内同时出现 `new Promise` 构造与 `setTimeout`
 * 调用即视为手写"Promise + 定时器"原语，应统一收敛到 race-with-deadline.ts。
 * 对抗审查（B）的"同文件共现"签名实测：全仓 31 个文件共现，除 canonical 外
 * 均为 pre-existing（白名单见 HANDWRITTEN_TIMEOUT_WHITELIST，含误报 3 +
 * 既有原语 27），因此本规则当前零新增违规，只拦截新引入的共现。
 *
 * 精确性说明：
 * - `new Promise` 可能以 new Promise<...> / new Promise(( 形式出现，取
 *   \bnew\s+Promise\s*[<(] 覆盖两种形态；
 * - `setTimeout` 以调用形态 setTimeout( 匹配，避开 ReturnType<typeof
 *   setTimeout> 这类类型位置的误匹配；
 * - stripComments 后字符串字面量误匹配已全仓评估：无任何文件依赖字符串
 *   字面量判定（"new Promise"/"setTimeout" 从不只出现在字符串里）。
 */
const NEW_PROMISE_TOKEN = /\bnew\s+Promise\s*[<(]/;
const SET_TIMEOUT_TOKEN = /\bsetTimeout\s*\(/;

export function scanHandwrittenTimeoutPrimitives({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(repositoryRoot, root)),
  );
  const violations = [];
  for (const file of sourceFiles) {
    const relative = normalizeRelativePath(file, repositoryRoot);
    if (HANDWRITTEN_TIMEOUT_WHITELIST.has(relative)) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    if (NEW_PROMISE_TOKEN.test(source) && SET_TIMEOUT_TOKEN.test(source)) {
      violations.push({
        rule: "handwritten-timeout-primitive",
        source: relative,
        target: "new Promise + setTimeout",
      });
    }
  }
  return violations.sort((left, right) =>
    `${left.rule}|${left.source}|${left.target}`.localeCompare(
      `${right.rule}|${right.source}|${right.target}`,
    ),
  );
}

/**
 * canonical 原语名唯一性：raceWithDeadline / raceWithDeadlineReject 只允许在
 * src/util/race-with-deadline.ts 内被定义。只匹配"定义形态"（function 声明 /
 * const|let 赋值），import 与调用形态天然不匹配（import 后无 `=`，调用形态
 * 前无 function/const/let 关键字），因此 import { raceWithDeadline } 不算违规。
 */
const CANONICAL_PRIMITIVE_FILE = "src/util/race-with-deadline.ts";
const CANONICAL_PRIMITIVES = ["raceWithDeadline", "raceWithDeadlineReject"];

export function scanCanonicalPrimitiveRedefinitions({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(resolve(repositoryRoot, root)),
  );
  const violations = [];
  for (const file of sourceFiles) {
    const relative = normalizeRelativePath(file, repositoryRoot);
    if (relative === CANONICAL_PRIMITIVE_FILE) continue;
    const source = stripComments(readFileSync(file, "utf8"));
    for (const name of CANONICAL_PRIMITIVES) {
      const definitionPattern = new RegExp(
        `function\\s+${name}\\b|\\b(?:const|let)\\s+${name}\\s*=`,
      );
      if (definitionPattern.test(source)) {
        violations.push({
          rule: "canonical-primitive-redefinition",
          source: relative,
          target: name,
        });
      }
    }
  }
  return violations.sort((left, right) =>
    `${left.rule}|${left.source}|${left.target}`.localeCompare(
      `${right.rule}|${right.source}|${right.target}`,
    ),
  );
}

export function evaluateArchitectureBoundaries(violations, baseline = loadBaseline()) {
  const known = [];
  const unexpected = [];
  for (const violation of violations) {
    const key = `${violation.rule}|${violation.source}|${violation.target}`;
    (baseline.has(key) ? known : unexpected).push(violation);
  }
  return { known, unexpected };
}

function printViolations(title, violations) {
  if (violations.length === 0) return;
  console.error(`[architecture-boundaries] ${title} (${violations.length})`);
  for (const violation of violations) {
    const specifier = violation.specifier ? ` (${violation.specifier})` : "";
    console.error(
      `  - ${violation.rule}: ${violation.source} -> ${violation.target}${specifier}`,
    );
  }
}

function printUsage() {
  console.error("用法: node scripts/check-architecture-boundaries.mjs [--strict]");
  console.error(
    "默认模式阻止新增逆依赖，同时报告已登记的架构债务；--strict 将现有债务也视为失败。",
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => arg !== "--strict")) {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const violations = [
    ...scanArchitectureBoundaries(),
    ...scanCrossCuttingDefinitions(),
    ...scanHandwrittenTimeoutPrimitives(),
    ...scanCanonicalPrimitiveRedefinitions(),
  ];
  const { known, unexpected } = evaluateArchitectureBoundaries(violations);
  console.log(
    `[architecture-boundaries] 扫描 ${SOURCE_ROOTS.join(", ")}，发现 ${violations.length} 条受控边界记录。`,
  );
  printViolations("现有架构债务（baseline）", known);
  printViolations("新增边界违规", unexpected);
  if (args.has("--strict") && known.length > 0) {
    console.error(
      "[architecture-boundaries] strict 模式拒绝现有 baseline；请先迁移后删除对应记录。",
    );
  }
  if (unexpected.length > 0 || (args.has("--strict") && known.length > 0)) {
    process.exitCode = 1;
    return;
  }
  console.log("[architecture-boundaries] 通过：没有新增逆依赖。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
