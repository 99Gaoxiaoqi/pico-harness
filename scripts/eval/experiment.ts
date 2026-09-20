import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ExperimentSpec {
  schemaVersion: 1;
  id: string;
  subjects: string[];
  scenarios: string[];
  repetitions: number;
  /** Include model, prompts, fixtures, scoring policy and implementation revision; never credentials. */
  config: Json;
}
export interface Cell {
  id: string;
  subject: string;
  scenario: string;
  repetition: number;
}
export interface Measurement {
  available: boolean;
  triggered: boolean;
  success: boolean;
  error: boolean;
  elapsedMs: number;
  tokens: number | null;
  cost: number | null;
}
export interface Attempt<T> {
  schemaVersion: 1;
  fingerprint: string;
  cell: Cell;
  measurement: Measurement;
  result: T;
}

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Non-finite spec number");
    if (value === undefined) throw new Error("Undefined spec value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}
function digest(value: Json): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function expandExperiment(spec: ExperimentSpec): Cell[] {
  if (
    spec.schemaVersion !== 1 ||
    !spec.id ||
    !Number.isSafeInteger(spec.repetitions) ||
    spec.repetitions < 1
  )
    throw new Error("Invalid experiment spec");
  for (const ids of [spec.subjects, spec.scenarios]) {
    if (
      !ids.length ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid or duplicate matrix ids");
  }
  return Array.from({ length: spec.repetitions }, (_, i) => i + 1).flatMap((repetition) =>
    spec.scenarios.flatMap((scenario) =>
      (repetition % 2 ? spec.subjects : [...spec.subjects].reverse()).map((subject) => ({
        id: digest([subject, scenario, repetition]),
        subject,
        scenario,
        repetition,
      })),
    ),
  );
}
function validateMeasurement(value: Measurement): void {
  if (
    !value ||
    [value.available, value.triggered, value.success, value.error].some(
      (x) => typeof x !== "boolean",
    ) ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    [value.tokens, value.cost].some(
      (x) => x !== null && (typeof x !== "number" || !Number.isFinite(x) || x < 0),
    )
  )
    throw new Error("Invalid measurement");
}

/** Completed failures are evidence too: resume only runs missing cells, never retries or replaces samples. */
export async function runExperiment<T>(input: {
  spec: ExperimentSpec;
  directory: string;
  signal?: AbortSignal;
  execute: (cell: Cell) => Promise<{ measurement: Measurement; result: T }>;
  shouldStop?: (attempts: readonly Attempt<T>[]) => boolean;
}): Promise<Attempt<T>[]> {
  const cells = expandExperiment(input.spec);
  const fingerprint = digest(input.spec as unknown as Json);
  await mkdir(input.directory, { recursive: true });
  const lockPath = join(input.directory, ".lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const manifestPath = join(input.directory, "spec.json");
    let saved: string | undefined;
    try {
      saved = await readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved !== undefined) {
      if (digest(JSON.parse(saved) as Json) !== fingerprint)
        throw new Error("Experiment spec/config mismatch; choose a new directory");
    } else {
      await writeFile(manifestPath, JSON.stringify(input.spec, null, 2) + "\n", { flag: "wx" });
    }
    const attemptDir = join(input.directory, "attempts");
    await mkdir(attemptDir, { recursive: true });
    const known = new Map(cells.map((cell) => [cell.id, cell]));
    const previous = new Map<string, Attempt<T>>();
    for (const name of await readdir(attemptDir)) {
      if (!name.endsWith(".json")) continue;
      const attempt = JSON.parse(await readFile(join(attemptDir, name), "utf8")) as Attempt<T>;
      const cell = known.get(attempt.cell?.id);
      if (
        attempt.schemaVersion !== 1 ||
        attempt.fingerprint !== fingerprint ||
        !cell ||
        name !== `${cell.id}.json` ||
        canonical(attempt.cell as unknown as Json) !== canonical(cell as unknown as Json)
      )
        throw new Error("Invalid persisted attempt");
      validateMeasurement(attempt.measurement);
      previous.set(cell.id, attempt);
    }
    const attempts: Attempt<T>[] = [];
    for (const cell of cells) {
      const existing = previous.get(cell.id);
      if (existing) {
        attempts.push(existing);
        continue;
      }
      if (input.signal?.aborted || input.shouldStop?.(attempts)) break;
      const output = await input.execute(cell);
      validateMeasurement(output.measurement);
      const attempt: Attempt<T> = { schemaVersion: 1, fingerprint, cell, ...output };
      const temporary = join(attemptDir, `${cell.id}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(attempt) + "\n", { flag: "wx" });
      await rename(temporary, join(attemptDir, `${cell.id}.json`));
      attempts.push(attempt);
    }
    return attempts;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

export function summarizeExperiment<T>(planned: number, attempts: readonly Attempt<T>[]) {
  const observed = attempts.length;
  const available = attempts.filter((a) => a.measurement.available).length;
  const triggered = attempts.filter((a) => a.measurement.triggered).length;
  const succeeded = attempts.filter((a) => a.measurement.success).length;
  const errors = attempts.filter((a) => a.measurement.error).length;
  const metric = (key: "tokens" | "cost") => {
    const measured = attempts.filter((a) => a.measurement[key] !== null);
    return {
      measured: measured.length,
      total:
        observed > 0 && measured.length === observed
          ? measured.reduce((sum, a) => sum + a.measurement[key]!, 0)
          : null,
    };
  };
  return {
    planned,
    observed,
    missing: planned - observed,
    available,
    unavailable: observed - available,
    triggered,
    succeeded,
    errors,
    // Trigger inference requires complete sampling and a response in every cell.
    triggerRate:
      observed === planned && available === observed && observed > 0 ? triggered / observed : null,
    successRate: observed ? succeeded / observed : null,
    errorRate: observed ? errors / observed : null,
    rateDenominator: observed,
    elapsedMs: {
      measured: observed,
      total: observed ? attempts.reduce((sum, a) => sum + a.measurement.elapsedMs, 0) : null,
      mean: observed
        ? attempts.reduce((sum, a) => sum + a.measurement.elapsedMs, 0) / observed
        : null,
    },
    tokens: metric("tokens"),
    cost: metric("cost"),
  };
}
