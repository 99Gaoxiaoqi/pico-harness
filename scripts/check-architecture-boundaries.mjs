import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["src", "apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_DECLARATION =
  /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([\s\S]*?)(?:\s+from\s+)?["']([^"']+)["']\s*;?/g;

/**
 * These are deliberately explicit, temporary exceptions. They make the gate useful before the
 * remaining legacy edges are migrated: a newly introduced edge fails immediately, while the
 * existing debt remains visible in the command output and in the baseline file.
 */
const BASELINE_PATH = resolve(REPOSITORY_ROOT, "scripts/architecture-boundaries-baseline.json");

function normalizeRelativePath(path) {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/");
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

function sourceArea(path) {
  const normalized = normalizeRelativePath(path);
  if (normalized.startsWith("src/input/")) return "input";
  if (normalized.startsWith("src/provider/")) return "provider";
  if (normalized.startsWith("src/engine/")) return "engine";
  if (normalized.startsWith("src/daemon/")) return "daemon";
  if (normalized.startsWith("src/runtime/")) return "runtime";
  return undefined;
}

function isDaemonBarrel(path) {
  return normalizeRelativePath(path) === "src/daemon/index.ts";
}

function isPureTypeImport(declaration) {
  return declaration.typeOnly;
}

function classifyViolation(importer, target, declaration) {
  const from = sourceArea(importer);
  const to = sourceArea(target);
  if (!from || !to) return undefined;

  if (from === "input" && to === "daemon" && isDaemonBarrel(target)) {
    return "input-to-daemon-barrel";
  }
  // A pure type-only import is a contract dependency and does not couple runtime implementations.
  if (isPureTypeImport(declaration)) return undefined;
  if (from === "provider" && to === "input") return "provider-to-input-concrete";
  if (from === "engine" && to === "runtime") return "engine-to-runtime-implementation";
  return undefined;
}

function parseImports(file) {
  const source = stripComments(readFileSync(file, "utf8"));
  const imports = [];
  for (const match of source.matchAll(IMPORT_DECLARATION)) {
    const [, kind, typeModifier, clause, specifier] = match;
    if (!specifier || !kind) continue;
    imports.push({
      specifier,
      typeOnly: typeModifier?.trim() === "type",
      clause: clause ?? "",
    });
  }
  return imports;
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
  const violations = [];
  for (const importer of sourceFiles) {
    for (const declaration of parseImports(importer)) {
      const target = resolveImportPath(importer, declaration.specifier);
      if (!target) continue;
      const rule = classifyViolation(importer, target, declaration);
      if (!rule) continue;
      violations.push({
        rule,
        source: normalizeRelativePath(importer),
        target: normalizeRelativePath(target),
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
    console.error(
      `  - ${violation.rule}: ${violation.source} -> ${violation.target} (${violation.specifier})`,
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
  const violations = scanArchitectureBoundaries();
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
