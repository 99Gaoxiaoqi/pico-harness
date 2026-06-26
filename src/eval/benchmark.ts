import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "../engine/session.js";
// 跨平台 shell:setupScript/validateScript 多为 POSIX 写法(printf/$()/test),
// 在 Windows 上必须走 Git Bash 才能正确执行。
import { execAsync, execOptions } from "../os/shell.js";

export interface BenchmarkUsage {
  promptTokens: number;
  completionTokens: number;
  costCNY: number;
}

export interface BenchmarkCaseContext {
  case: BenchmarkCase;
  workDir: string;
  session: Session;
  signal?: AbortSignal;
}

export type BenchmarkCaseHook = (context: BenchmarkCaseContext) => Promise<void> | void;

export interface BenchmarkValidationResult {
  passed: boolean;
  message?: string;
}

export type BenchmarkCaseValidator = (
  context: BenchmarkCaseContext,
) => Promise<BenchmarkValidationResult | boolean> | BenchmarkValidationResult | boolean;

export interface BenchmarkCase {
  id: string;
  name: string;
  prompt: string;
  /** 可选:在 case 工作区内执行的靶机初始化脚本 */
  setupScript?: string;
  /** 可选:在 setupScript 后执行的程序化初始化 hook */
  setup?: BenchmarkCaseHook;
  /** 可选:在 Agent 运行后执行的硬性验收脚本,exit 0 才算通过 */
  validateScript?: string;
  /** 可选:validateScript 通过后继续执行的程序化验收 hook */
  validate?: BenchmarkCaseValidator;
}

export type BenchmarkAgentRunner = (
  prompt: string,
  context: BenchmarkCaseContext,
) => Promise<void> | void;

export interface BenchmarkRunnerOptions {
  rootDir: string;
  cases: readonly BenchmarkCase[];
  runAgent: BenchmarkAgentRunner;
  now?: () => number;
  signal?: AbortSignal;
}

export interface BenchmarkCaseResult {
  id: string;
  name: string;
  prompt: string;
  workDir: string;
  passed: boolean;
  durationMs: number;
  usage: BenchmarkUsage;
  message?: string;
  error?: string;
}

export interface BenchmarkRunResult {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  usage: BenchmarkUsage;
  cases: readonly BenchmarkCaseResult[];
}

const EMPTY_USAGE: BenchmarkUsage = {
  promptTokens: 0,
  completionTokens: 0,
  costCNY: 0,
};

export class BenchmarkRunner {
  private readonly rootDir: string;
  private readonly cases: readonly BenchmarkCase[];
  private readonly runAgent: BenchmarkAgentRunner;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;

  constructor(options: BenchmarkRunnerOptions) {
    this.rootDir = options.rootDir;
    this.cases = options.cases;
    this.runAgent = options.runAgent;
    this.now = options.now ?? Date.now;
    this.signal = options.signal;
  }

  async run(): Promise<BenchmarkRunResult> {
    const results: BenchmarkCaseResult[] = [];

    await mkdir(this.rootDir, { recursive: true });

    for (const testCase of this.cases) {
      this.signal?.throwIfAborted();
      results.push(await this.runCase(testCase));
    }

    return summarizeResults(results);
  }

  private async runCase(testCase: BenchmarkCase): Promise<BenchmarkCaseResult> {
    const id = sanitizeCaseId(testCase.id);
    const workDir = join(this.rootDir, id);
    const session = new Session(`bench:${id}`, workDir);
    const context: BenchmarkCaseContext = {
      case: testCase,
      workDir,
      session,
      signal: this.signal,
    };
    const startedAt = this.now();
    let passed: boolean;
    let message: string | undefined;
    let error: string | undefined;

    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    try {
      if (testCase.setupScript) {
        await runShell(testCase.setupScript, workDir, "靶机 Setup 脚本执行失败");
      }
      await testCase.setup?.(context);
      this.signal?.throwIfAborted();

      await this.runAgent(testCase.prompt, context);
      this.signal?.throwIfAborted();

      if (testCase.validateScript) {
        await runShell(testCase.validateScript, workDir, "验证脚本执行失败");
      }

      const validation = normalizeValidation(await testCase.validate?.(context));
      passed = validation.passed;
      message = validation.message;
    } catch (caught) {
      passed = false;
      error = formatError(caught);
    }

    return {
      id,
      name: testCase.name,
      prompt: testCase.prompt,
      workDir,
      passed,
      durationMs: this.now() - startedAt,
      usage: snapshotUsage(session),
      ...(message !== undefined ? { message } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

async function runShell(script: string, cwd: string, failurePrefix: string): Promise<void> {
  try {
    await execAsync(
      script,
      execOptions({
        cwd,
        maxBuffer: 1024 * 1024,
      }),
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join("\n").trim();
    const detail = output || e.message || String(err);
    throw new Error(`${failurePrefix}: ${detail}`, { cause: err });
  }
}

function normalizeValidation(
  validation: BenchmarkValidationResult | boolean | undefined,
): BenchmarkValidationResult {
  if (validation === undefined) {
    return { passed: true };
  }
  if (typeof validation === "boolean") {
    return { passed: validation };
  }
  return validation;
}

function summarizeResults(results: readonly BenchmarkCaseResult[]): BenchmarkRunResult {
  const passed = results.filter((result) => result.passed).length;
  const total = results.length;
  const usage = results.reduce((current, result) => addUsage(current, result.usage), {
    ...EMPTY_USAGE,
  });

  return {
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    usage,
    cases: results,
  };
}

function addUsage(left: BenchmarkUsage, right: BenchmarkUsage): BenchmarkUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    costCNY: roundMetric(left.costCNY + right.costCNY),
  };
}

function snapshotUsage(session: Session): BenchmarkUsage {
  return {
    promptTokens: session.totalPromptTokens,
    completionTokens: session.totalCompletionTokens,
    costCNY: roundMetric(session.totalCostCNY),
  };
}

function sanitizeCaseId(id: string): string {
  const sanitized = id.trim().replaceAll(/[^a-zA-Z0-9_-]/gu, "-");

  if (sanitized === "") {
    throw new Error("Benchmark case id cannot be empty.");
  }

  return sanitized;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}
