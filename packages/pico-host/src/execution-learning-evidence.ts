import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutionAcceptanceClaim,
  ExecutionCondition,
  ExecutionConditionObservation,
  ExecutionFileCommitFact,
  ExecutionLearningTarget,
  ExecutionTestReport,
  ExecutionVerificationResult,
  ExecutionVerificationTicket,
} from "@pico/core";
import {
  createBashAnalysisBudget,
  initializeBashParser,
  parseBashScript,
} from "@pico/runtime/bash-parser";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";

export const EXECUTION_EVIDENCE_MAX_PATHS = 8;
export const EXECUTION_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const REPORT_SCHEMA = "pico.node-test.v1";

/** The Host supplies permission-aware readers; no fallback filesystem read is performed. */
export interface ExecutionEvidenceIO {
  readonly readFile: (path: string, maxBytes: number) => Promise<Uint8Array | string | undefined>;
  readonly realpath: (path: string) => Promise<string | undefined>;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function staticSegments(command: string): string[] | undefined {
  let quoted: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  const segments: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const character = command[i]!;
    if (escaped) {
      if (character === "\n" || character === "\r") return undefined;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted !== "'") {
      escaped = true;
      continue;
    }
    if (quoted) {
      if (character === quoted) quoted = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = character;
      continue;
    }
    if (character === "&" && command[i + 1] === "&") {
      segments.push(command.slice(start, i));
      start = ++i + 1;
    } else if (/[;&|<>()[\]{}\n\r]/u.test(character) || character === "#") return undefined;
  }
  if (quoted || escaped) return undefined;
  segments.push(command.slice(start));
  return segments.length <= 2 && segments.every((part) => part.trim()) ? segments : undefined;
}

class BoundedReader {
  readonly paths = new Set<string>();
  readonly files = new Map<string, Uint8Array | undefined>();
  bytes = 0;
  complete = true;
  constructor(readonly io: ExecutionEvidenceIO) {}
  path(path: string): boolean {
    if (!isAbsolute(path)) return (this.complete = false);
    this.paths.add(path);
    if (this.paths.size > EXECUTION_EVIDENCE_MAX_PATHS) return (this.complete = false);
    return true;
  }
  async canonical(path: string): Promise<string | undefined> {
    if (!this.path(path)) return undefined;
    try {
      const canonical = await this.io.realpath(path);
      if (!canonical || !isAbsolute(canonical)) this.complete = false;
      return canonical;
    } catch {
      this.complete = false;
      return undefined;
    }
  }
  async read(path: string): Promise<Uint8Array | undefined> {
    if (this.files.has(path)) return this.files.get(path);
    if (!this.path(path) || this.bytes >= EXECUTION_EVIDENCE_MAX_BYTES) {
      this.complete = false;
      return undefined;
    }
    try {
      const value = await this.io.readFile(path, EXECUTION_EVIDENCE_MAX_BYTES - this.bytes);
      if (
        typeof value === "string" &&
        Buffer.byteLength(value) > EXECUTION_EVIDENCE_MAX_BYTES - this.bytes
      ) {
        this.complete = false;
        this.files.set(path, undefined);
        return undefined;
      }
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      if (!bytes || bytes.byteLength > EXECUTION_EVIDENCE_MAX_BYTES - this.bytes) {
        this.complete = false;
        this.files.set(path, undefined);
        return undefined;
      }
      this.bytes += bytes.byteLength;
      this.files.set(path, bytes);
      return bytes;
    } catch {
      this.complete = false;
      this.files.set(path, undefined);
      return undefined;
    }
  }
}

/** Narrow POSIX subset: one static command, optionally preceded by one static cd &&. */
export async function resolveExecutionLearningTarget(
  command: string,
  cwd: string,
  io: ExecutionEvidenceIO,
): Promise<ExecutionLearningTarget | undefined> {
  const segments = staticSegments(command.trim());
  if (!segments || !isAbsolute(cwd)) return undefined;
  await initializeBashParser();
  const commands: string[][] = [];
  for (const segment of segments) {
    const parsed = parseBashScript(segment, createBashAnalysisBudget());
    if (
      parsed.ambiguous ||
      parsed.destructiveSystemSyntax ||
      parsed.nestedCommands.length ||
      parsed.commands.length !== 1 ||
      parsed.commandContexts.some(
        (context) =>
          context.flow ||
          context.subshellDepth ||
          context.isolatedCwd ||
          context.opaqueInput ||
          context.stdinPayload !== undefined ||
          context.conditionallyExecuted,
      ) ||
      parsed.commands[0]!.some(
        (word) => word.dynamic || word.unquotedExpansion || word.outputRedirection,
      )
    )
      return undefined;
    commands.push(parsed.commands[0]!.map((word) => word.value));
  }
  if (segments.length === 2) {
    const cd = commands[0]!;
    if (cd.length !== 2 || cd[0] !== "cd" || !cd[1] || cd[1].startsWith("-")) return undefined;
    cwd = resolve(cwd, cd[1]);
  }
  const argv = commands.at(-1)!;
  if (
    !argv.length ||
    !argv[0] ||
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[0]) ||
    [
      "cd",
      "eval",
      "exec",
      "source",
      ".",
      "env",
      "bash",
      "sh",
      "zsh",
      "npm",
      "npx",
      "pnpm",
      "yarn",
    ].includes(basename(argv[0]))
  )
    return undefined;
  const reader = new BoundedReader(io);
  const canonicalCwd = await reader.canonical(cwd);
  if (!canonicalCwd) return undefined;
  let kind: ExecutionLearningTarget["kind"] = "command";
  let entryPaths: string[] = [];
  let testFiles: string[] | undefined;
  if (basename(argv[0]) === "node" || basename(argv[0]) === "node.exe") {
    if (argv[1] === "--test") {
      if (
        argv.length < 3 ||
        argv.slice(2).some((arg) => arg.startsWith("-") || !/\.(?:[cm]?js|[cm]?ts)$/u.test(arg))
      )
        return undefined;
      kind = "node-test";
      entryPaths = argv.slice(2).map((path) => resolve(canonicalCwd, path));
    } else {
      if (!argv[1] || argv[1].startsWith("-") || !/\.(?:[cm]?js|[cm]?ts)$/u.test(argv[1]))
        return undefined;
      entryPaths = [resolve(canonicalCwd, argv[1])];
    }
  } else if (isAbsolute(argv[0]) || argv[0].includes("/")) {
    entryPaths = [resolve(canonicalCwd, argv[0])];
  }
  if (!entryPaths.length) return undefined;
  const entryFiles: { path: string; hash: string }[] = [];
  for (const path of [...new Set(entryPaths)]) {
    const canonical = await reader.canonical(path);
    if (!canonical) return undefined;
    const contents = await reader.read(canonical);
    if (!contents) return undefined;
    entryFiles.push({ path: canonical, hash: hash(contents) });
  }
  if (!reader.complete) return undefined;
  if (kind === "node-test") testFiles = entryFiles.map((file) => file.path);
  const normalizedCommand = argv.map(quote).join(" ");
  const scopeHash = hash(
    JSON.stringify({ argv, cwd: canonicalCwd, entryFiles, testFiles: testFiles ?? [] }),
  );
  return {
    targetId: `execution-target:${scopeHash}`,
    label: normalizedCommand,
    kind,
    command: normalizedCommand,
    argv,
    cwd: canonicalCwd,
    scopeHash,
    entryFiles,
    ...(testFiles ? { testFiles } : {}),
  };
}

export function conditionsFromFileCommit(
  fact: ExecutionFileCommitFact,
): readonly ExecutionCondition[] {
  if (!isAbsolute(fact.path) || !/^[a-f0-9]{64}$/u.test(fact.afterHash)) return [];
  if (
    fact.content !== undefined &&
    (Buffer.byteLength(fact.content) > EXECUTION_EVIDENCE_MAX_BYTES ||
      hash(fact.content) !== fact.afterHash)
  )
    return [];
  return [{ kind: "file", path: fact.path, hash: fact.afterHash }];
}

export async function observeExecutionConditions(
  conditions: readonly ExecutionCondition[],
  io: ExecutionEvidenceIO,
): Promise<ExecutionConditionObservation> {
  const reader = new BoundedReader(io);
  const observed: unknown[] = [];
  let matches = conditions.length <= 32;
  for (const condition of conditions.slice(0, 32)) {
    if (condition.kind === "cwd") {
      const canonical = await reader.canonical(condition.path);
      matches &&= canonical === condition.path;
      observed.push([condition.kind, condition.path, canonical ?? null]);
      continue;
    }
    const contents = await reader.read(condition.path);
    const fileHash = contents ? hash(contents) : null;
    if (condition.kind === "file") {
      matches &&= fileHash === condition.hash;
      observed.push([condition.kind, condition.path, fileHash]);
      continue;
    }
    let value: unknown;
    try {
      value = contents ? JSON.parse(Buffer.from(contents).toString("utf8")) : undefined;
    } catch {
      value = undefined;
    }
    if (condition.kind === "json") {
      for (const field of condition.field) {
        value =
          value && typeof value === "object" && Object.hasOwn(value, field)
            ? (value as Record<string, unknown>)[field]
            : undefined;
      }
      matches &&= value === condition.value;
      observed.push([condition.kind, condition.path, condition.field, value ?? null, fileHash]);
    } else {
      const manifest =
        value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
      const entry = await reader.read(condition.entryPath);
      const entryHash = entry ? hash(entry) : null;
      matches &&=
        manifest?.name === condition.name &&
        manifest?.version === condition.version &&
        entryHash === condition.entryHash;
      observed.push([condition.kind, condition.path, fileHash, condition.entryPath, entryHash]);
    }
  }
  if (conditions.length > 32) reader.complete = false;
  return {
    complete: reader.complete,
    matches: reader.complete && matches,
    fingerprint: hash(JSON.stringify(observed)),
    facts: [...reader.files].map(([path, bytes]) => ({ path, hash: bytes ? hash(bytes) : null })),
  };
}

export interface InstrumentedExecutionLearningCommand {
  readonly command: string;
  readonly reportPath: string;
}

/** Must run before the permission chain so it authorizes the final command and report destination. */
export async function instrumentCommand(
  target: ExecutionLearningTarget,
  options: { readonly reportDirectory: string },
): Promise<InstrumentedExecutionLearningCommand | undefined> {
  if (
    target.kind !== "node-test" ||
    !target.testFiles?.length ||
    !isAbsolute(options.reportDirectory)
  )
    return undefined;
  const bundledReporterPath = fileURLToPath(
    new URL("./execution-learning-reporter.js", import.meta.url),
  );
  // External Node has no Electron ASAR filesystem. Desktop ships this ESM resource outside it.
  const archiveBoundary = bundledReporterPath.search(/[\\/]app\.asar[\\/]/u);
  const reporterPath =
    archiveBoundary < 0
      ? bundledReporterPath
      : resolve(bundledReporterPath.slice(0, archiveBoundary), "execution-learning-reporter.mjs");
  const reportPath = resolve(options.reportDirectory, `execution-learning-${randomUUID()}.jsonl`);
  const file = await open(reportPath, "wx", 0o600);
  await file.close();
  const argv = [
    target.argv[0]!,
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    `--test-reporter=${reporterPath}`,
    `--test-reporter-destination=${reportPath}`,
    ...target.testFiles,
  ];
  return { command: `cd ${quote(target.cwd)} && ${argv.map(quote).join(" ")}`, reportPath };
}

function incompleteReport(): ExecutionTestReport {
  return { complete: false, success: false, passed: [], failed: [], skipped: [] };
}

export function parseExecutionTestReport(contents: string): ExecutionTestReport {
  if (Buffer.byteLength(contents) > EXECUTION_EVIDENCE_MAX_BYTES || !contents.endsWith("\n"))
    return incompleteReport();
  const lines = contents.trimEnd().split("\n");
  if (lines.length < 3 || lines.length > 8192) return incompleteReport();
  const passed: string[] = [],
    failed: string[] = [],
    skipped: string[] = [];
  const seen = new Set<string>();
  let tests = 0,
    suites = 0;
  let summary: { success: boolean; counts: Record<string, number> } | undefined;
  let runner: ExecutionTestReport["runner"];
  try {
    for (let i = 0; i < lines.length; i++) {
      const row = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (!row || row.schema !== REPORT_SCHEMA) return incompleteReport();
      if (i === 0) {
        if (row.kind !== "begin") return incompleteReport();
        const identity = row.runner as Record<string, unknown> | undefined;
        if (
          !identity ||
          typeof identity.execPath !== "string" ||
          !isAbsolute(identity.execPath) ||
          typeof identity.version !== "string" ||
          !/^v\d+\.\d+\.\d+$/u.test(identity.version) ||
          typeof identity.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/u.test(identity.fingerprint)
        )
          return incompleteReport();
        runner = {
          execPath: identity.execPath,
          version: identity.version,
          fingerprint: identity.fingerprint,
        };
        continue;
      }
      if (i === lines.length - 1) {
        if (row.kind !== "complete" || row.valid !== true) return incompleteReport();
        continue;
      }
      if (row.kind === "summary") {
        if (
          summary ||
          typeof row.success !== "boolean" ||
          !row.counts ||
          typeof row.counts !== "object"
        )
          return incompleteReport();
        const counts = row.counts as Record<string, number>;
        if (
          ["tests", "suites", "passed", "failed", "cancelled", "skipped", "todo"].some(
            (key) => !Number.isSafeInteger(counts[key]) || counts[key]! < 0,
          )
        )
          return incompleteReport();
        summary = { success: row.success, counts };
      } else if (row.kind === "outcome" && !summary) {
        if (
          typeof row.id !== "string" ||
          typeof row.file !== "string" ||
          !isAbsolute(row.file) ||
          typeof row.suite !== "boolean" ||
          seen.has(row.id)
        )
          return incompleteReport();
        const identity: unknown = JSON.parse(row.id);
        if (
          !Array.isArray(identity) ||
          identity.length < 2 ||
          identity[0] !== row.file ||
          identity.some((part) => typeof part !== "string")
        )
          return incompleteReport();
        seen.add(row.id);
        if (row.suite) suites++;
        else tests++;
        if (row.status === "passed") passed.push(row.id);
        else if (row.status === "failed") failed.push(row.id);
        else if (row.status === "skipped") skipped.push(row.id);
        else return incompleteReport();
      } else return incompleteReport();
    }
  } catch {
    return incompleteReport();
  }
  if (!summary || !tests || summary.counts.tests !== tests || summary.counts.suites !== suites)
    return incompleteReport();
  const success =
    summary.success &&
    failed.length === 0 &&
    skipped.length === 0 &&
    ["failed", "cancelled", "skipped", "todo"].every((key) => summary.counts[key] === 0);
  return { complete: true, success, passed, failed, skipped, ...(runner ? { runner } : {}) };
}

export async function readExecutionTestReport(
  path: string,
  io: ExecutionEvidenceIO,
): Promise<ExecutionTestReport> {
  const bytes = await new BoundedReader(io).read(path);
  return bytes ? parseExecutionTestReport(Buffer.from(bytes).toString("utf8")) : incompleteReport();
}

export function evaluateAcceptance(
  claim: ExecutionAcceptanceClaim,
  ticket: ExecutionVerificationTicket,
  result: ExecutionVerificationResult,
): { readonly accepted: boolean; readonly reason?: string } {
  const reject = (reason: string) => ({ accepted: false as const, reason });
  if (
    ticket.candidateId !== claim.candidateId ||
    ticket.claimRevision !== claim.revision ||
    ticket.claimHash !== claim.claimHash ||
    ticket.createdAt < claim.createdAt ||
    !ticket.admissionId ||
    !ticket.argumentsHash ||
    !ticket.preparedEventId ||
    !ticket.toolCallId ||
    result.ticketId !== ticket.ticketId ||
    result.source.sessionId !== ticket.sessionId ||
    result.source.runId !== ticket.runId ||
    !result.source.eventId ||
    result.settledAt < ticket.createdAt
  )
    return reject("verification-ticket-mismatch");
  if (!result.complete || result.exitCode !== 0) return reject("execution-not-complete-success");
  if (
    !ticket.before.complete ||
    !ticket.before.matches ||
    !result.after.complete ||
    !result.after.matches ||
    ticket.before.fingerprint !== result.after.fingerprint
  )
    return reject("conditions-not-stable");
  if (claim.predicateId === "test-target-pass.v1") {
    const report = result.report;
    if (
      claim.runner &&
      (report?.runner?.execPath !== claim.runner.execPath ||
        report.runner.version !== claim.runner.version ||
        report.runner.fingerprint !== claim.runner.fingerprint)
    )
      return reject("runner-changed");
    if (
      claim.target.kind !== "node-test" ||
      claim.failedTestIds.length === 0 ||
      !report?.complete ||
      !report.success ||
      report.failed.length ||
      report.skipped.length ||
      claim.failedTestIds.some((id) => !report.passed.includes(id))
    )
      return reject("test-target-not-proven");
  } else if (claim.predicateId === "command-conditions.v1") {
    if (claim.target.kind !== "command" || claim.conditions.length === 0)
      return reject("command-conditions-missing");
  } else return reject("unsupported-predicate");
  return { accepted: true };
}

export function safeTemplate(content: string | undefined): string | undefined {
  if (content === undefined || [...content].length > 800) return undefined;
  const safety = sanitizeMemoryContent({ title: "配置模板", content, reason: "原生文件提交内容" });
  return safety.disposition === "allow" ? content : undefined;
}

/** Fixed Host wording records the observed recipe and outcome; it makes no causal claim. */
export function renderAcceptedLesson(claim: ExecutionAcceptanceClaim): string {
  const lines = [
    `已验证执行方案：${claim.target.command}`,
    `工作目录：${claim.target.cwd}`,
    "适用范围：同一静态命令及入口源码，且以下准备条件保持一致。",
  ];
  for (const preparation of claim.recipe) {
    if (preparation.kind === "cwd") lines.push(`准备目录：${preparation.path}`);
    else if (preparation.kind === "dependency")
      lines.push(
        `准备依赖：${preparation.command}；清单摘要 ${preparation.manifestHash.slice(0, 12)}`,
      );
    else {
      const content = safeTemplate(preparation.content);
      lines.push(
        `准备文件：${preparation.path}；内容摘要 ${preparation.afterHash.slice(0, 12)}${content === undefined ? "" : `；可复用内容 ${JSON.stringify(content)}`}`,
      );
    }
  }
  for (const condition of claim.conditions) {
    if (condition.kind === "cwd") lines.push(`验收目录：${condition.path}`);
    else if (condition.kind === "file")
      lines.push(`验收文件：${condition.path}；摘要 ${condition.hash.slice(0, 12)}`);
    else if (condition.kind === "json")
      lines.push(
        `验收字段：${condition.path} ${JSON.stringify(condition.field)} = ${JSON.stringify(condition.value)}`,
      );
    else
      lines.push(`验收依赖：${condition.name}@${condition.version}；入口 ${condition.entryPath}`);
  }
  lines.push(
    claim.predicateId === "test-target-pass.v1"
      ? "验收事实：原失败测试全部通过，报告完整，无新增失败、跳过、TODO 或取消；进程正常退出 0，准备条件前后稳定。"
      : "验收事实：同一命令完整执行并正常退出 0；声明的准备条件满足且前后稳定。",
  );
  return [...lines.join("\n")].slice(0, 2000).join("");
}
