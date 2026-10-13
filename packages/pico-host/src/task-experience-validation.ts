import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type {
  Message,
  ExperienceApplicability,
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceReuse,
  TaskExperienceTask,
} from "@pico/core";

type Verdict = Pick<TaskExperienceReuse, "adoption" | "validation" | "sources">;
const unknown = (): Verdict => ({ adoption: "unknown", validation: "unknown", sources: [] });
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Method conditions are assigned from canonical tool arguments, not model assertions. */
export function spreadsheetExperienceApplicability(
  observations: readonly TaskExperienceObservation[],
): ExperienceApplicability["spreadsheet"] | undefined {
  return observations.some(
    (observation) =>
      observation.toolName === "document" &&
      observation.status === "succeeded" &&
      observation.arguments?.action === "analyze" &&
      observation.arguments.operation === "sum" &&
      observation.arguments.header === false &&
      typeof observation.arguments.range === "string" &&
      typeof observation.arguments.column === "string",
  )
    ? { operation: "sum", header: false, dataKind: "finite-numbers" }
    : undefined;
}

/** Pre-injection applicability checks current bytes, without inheriting historical file identity. */
export async function spreadsheetInputHasFiniteNumbers(
  bytes: Buffer,
  options: { readonly range?: string; readonly sheet?: string } = {},
): Promise<boolean> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    if (options.range) {
      const range =
        /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/iu.exec(
          options.range,
        );
      const column = (name: string) =>
        [...name.toUpperCase()].reduce(
          (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
          0,
        );
      if (!range) return false;
      const top = Number(range[2]),
        bottom = Number(range[4] ?? range[2]),
        left = column(range[1]!),
        right = column(range[3] ?? range[1]!);
      if (
        top > bottom ||
        left > right ||
        bottom > 1048576 ||
        right > 16384 ||
        (bottom - top + 1) * (right - left + 1) > 200000
      )
        return false;
      const sheet =
        options.sheet === undefined
          ? workbook.worksheets[0]
          : workbook.worksheets.find((sheet) => sheet.name === options.sheet);
      if (!sheet) return false;
      for (let row = top; row <= bottom; row++)
        for (let col = left; col <= right; col++) {
          const cell = sheet.findRow(row)?.findCell(col);
          if (
            !cell ||
            cell.isMerged ||
            typeof cell.value !== "number" ||
            !Number.isFinite(cell.value)
          )
            return false;
        }
      return true;
    }
    let count = 0;
    let invalid = false;
    for (const sheet of workbook.worksheets)
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (
            ++count > 200000 ||
            cell.isMerged ||
            typeof cell.value !== "number" ||
            !Number.isFinite(cell.value)
          )
            invalid = true;
        }),
      );
    return count > 0 && !invalid;
  } catch {
    return false;
  }
}

/** Independent validation deliberately does not call the production spreadsheet query implementation. */
export async function validateSpreadsheetTaskExperience(input: {
  readonly candidate: TaskExperienceCandidate;
  readonly task: TaskExperienceTask;
  readonly observation: TaskExperienceObservation;
  readonly canonicalArguments?: Readonly<Record<string, unknown>>;
  readonly canonicalResult?: string;
  readonly artifactBytes?: Buffer;
  readonly artifactDigest?: string;
  /** Host resolves this from the canonical user input bound by task.goalSource. */
  readonly currentArtifactId?: string;
  readonly now: number;
}): Promise<Verdict> {
  const { candidate, task, observation } = input;
  if (
    candidate.review !== "approved" ||
    !candidate.enabled ||
    !candidate.applicability.spreadsheet ||
    observation.taskId !== task.taskId ||
    observation.taskVersion !== task.taskVersion ||
    task.workspaceKey !== candidate.workspaceKey ||
    observation.source.sessionId !== task.sessionId ||
    observation.kind !== "tool-result" ||
    observation.toolName !== "document" ||
    observation.status !== "succeeded"
  )
    return unknown();
  const args = input.canonicalArguments;
  if (!args || args.action !== "analyze") return unknown();
  const target = spreadsheetTargetFromGoal(task.goal);
  if (!target || !input.currentArtifactId || typeof args.artifact_id !== "string") return unknown();
  const artifactRef = (id: string) =>
    id.startsWith("pico://artifact/") ? id : `pico://artifact/${encodeURIComponent(id)}`;
  if (artifactRef(args.artifact_id) !== artifactRef(input.currentArtifactId)) return unknown();
  if (
    args.operation !== "sum" ||
    args.header !== false ||
    typeof args.sheet !== "string" ||
    typeof args.range !== "string" ||
    typeof args.column !== "string" ||
    args.groupBy !== undefined ||
    (Array.isArray(args.filters) && args.filters.length > 0) ||
    (args.filters !== undefined && !Array.isArray(args.filters))
  )
    return { adoption: "not_applied", validation: "unknown", sources: [observation.source] };
  const range = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6}):\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/iu.exec(
    args.range,
  );
  const column = (name: string) =>
    [...name.toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  if (!range || !/^[A-Z]{1,3}$/iu.test(args.column)) return unknown();
  const start = Number(range[2]),
    end = Number(range[4]),
    left = column(range[1]!),
    right = column(range[3]!),
    metric = column(args.column);
  if (
    start > end ||
    left > right ||
    end > 1048576 ||
    right > 16384 ||
    metric < left ||
    metric > right ||
    (end - start + 1) * (right - left + 1) > 200000
  )
    return unknown();
  let document: Record<string, unknown> | undefined;
  let result: Record<string, unknown> | undefined;
  try {
    document = object(JSON.parse(input.canonicalResult ?? ""));
    result = object(JSON.parse(typeof document?.text === "string" ? document.text : ""));
  } catch {
    return unknown();
  }
  const source = object(document?.source);
  if (
    !source ||
    source.action !== "analyze" ||
    document?.kind !== "spreadsheet" ||
    !input.artifactBytes ||
    !input.artifactDigest ||
    typeof source.digest !== "string"
  )
    return unknown();
  if (typeof args.artifact_id !== "string") return unknown();
  const artifactId = args.artifact_id.startsWith("pico://artifact/")
    ? args.artifact_id.slice("pico://artifact/".length)
    : encodeURIComponent(args.artifact_id);
  if (source.ref !== `pico://artifact/${artifactId}`) return unknown();
  if (
    source.digest !== input.artifactDigest ||
    createHash("sha256").update(input.artifactBytes).digest("hex") !== input.artifactDigest
  )
    return { adoption: "observed", validation: "stale", sources: [observation.source] };
  const normalizedRange = `${range[1]!.toUpperCase()}${start}:${range[3]!.toUpperCase()}${end}`;
  if (
    args.sheet !== target.sheet ||
    normalizedRange !== target.range ||
    args.column.toUpperCase() !== target.column
  )
    return { adoption: "not_applied", validation: "unknown", sources: [observation.source] };
  const rows = end - start + 1;
  if (
    !result ||
    result.sheet !== args.sheet ||
    result.range !== normalizedRange ||
    result.dataRange !== normalizedRange ||
    result.column !== args.column.toUpperCase() ||
    result.operation !== "sum" ||
    result.header !== false ||
    result.groupBy !== null ||
    !Array.isArray(result.filters) ||
    result.filters.length ||
    result.groups !== undefined ||
    result.completeNumericCoverage !== true ||
    result.totalRows !== rows ||
    result.matchedRows !== rows ||
    result.numericValues !== rows ||
    result.emptyValues !== 0 ||
    result.nonNumericValues !== 0 ||
    result.formulaCacheMissing !== 0 ||
    result.formulaCacheUsed !== 0 ||
    result.filterAndGroupFormulaCacheUsed !== 0 ||
    typeof result.result !== "number" ||
    !Number.isFinite(result.result)
  )
    return unknown();
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      input.artifactBytes as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets.find((sheet) => sheet.name === args.sheet);
    if (!sheet) return unknown();
    let sum = 0;
    for (let row = start; row <= end; row++) {
      for (let cellColumn = left; cellColumn <= right; cellColumn++) {
        const cell = sheet.findRow(row)?.findCell(cellColumn);
        if (
          !cell ||
          cell.isMerged ||
          typeof cell.value !== "number" ||
          !Number.isFinite(cell.value)
        )
          return unknown();
      }
      const value = sheet.findRow(row)?.findCell(metric)?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) return unknown();
      sum += value;
      if (!Number.isFinite(sum)) return unknown();
    }
    return {
      adoption: "observed",
      validation: sum === result.result ? "pass" : "fail",
      sources: [observation.source],
    };
  } catch {
    return unknown();
  }
}

/** A narrow explicit goal syntax: absent/ambiguous user scope cannot be filled by tool arguments. */
export function spreadsheetTargetFromGoal(
  goal: string,
): { sheet: string; range: string; column: string } | undefined {
  if (!/(?:\bsum\b|求和|总和|合计|总计|加总|相加)/iu.test(goal)) return undefined;
  const ranges = [
    ...goal.matchAll(/\$?([A-Z]{1,3})\$?([1-9]\d{0,6})\s*:\s*\$?([A-Z]{1,3})\$?([1-9]\d{0,6})/giu),
  ].map(
    (match) =>
      `${match[1]!.toUpperCase()}${Number(match[2])}:${match[3]!.toUpperCase()}${Number(match[4])}`,
  );
  if (new Set(ranges).size !== 1) return undefined;
  const columns = [
    ...goal.matchAll(
      /(?:\bcolumn\s*[:=：]?\s*\$?([A-Z]{1,3})\b|\b([A-Z]{1,3})\s*列|列\s*[:=：]?\s*([A-Z]{1,3})\b)/giu,
    ),
  ].map((match) => (match[1] ?? match[2] ?? match[3])!.toUpperCase());
  // A single-column user range already fixes the metric column independently of the tool.
  if (!columns.length) {
    const singleColumn = /^([A-Z]{1,3})\d+:([A-Z]{1,3})\d+$/u.exec(ranges[0]!);
    if (singleColumn && singleColumn[1] === singleColumn[2]) columns.push(singleColumn[1]!);
  }
  if (new Set(columns).size !== 1) return undefined;
  const qualified =
    /(?:'([^'\n]{1,128})'|"([^"\n]{1,128})"|([\p{L}_][\p{L}\p{N}_.-]{0,127}))!\s*\$?[A-Z]{1,3}\$?[1-9]\d{0,6}/u.exec(
      goal,
    );
  let sheet = qualified?.[1] ?? qualified?.[2] ?? qualified?.[3];
  if (!sheet) {
    const named =
      /(?:\b(?:sheet|worksheet)\s*[:=：]\s*|工作表\s*[:=：]?\s*)(?:'([^'\n]{1,128})'|"([^"\n]{1,128})"|([\p{L}_][\p{L}\p{N}_.-]{0,127}))/iu.exec(
        goal,
      );
    sheet = named?.[1] ?? named?.[2] ?? named?.[3];
  }
  if (!sheet) {
    const sheets = [...goal.matchAll(/\b(Sheet[A-Z0-9_.-]+)\b/giu)].map((match) => match[1]!);
    if (new Set(sheets).size !== 1) return undefined;
    sheet = sheets[0];
  }
  return sheet ? { sheet, range: ranges[0]!, column: columns[0]! } : undefined;
}

/** Attachment preview prose cannot authorize another artifact. Host markup escapes file names/content. */
export function taskInputArtifactIds(message: Message): readonly string[] {
  if (message.role !== "user") return [];
  const marker = message.content.lastIndexOf("<uploaded-attachments>");
  const refs = marker >= 0
    ? [...message.content.slice(marker).matchAll(/<attachment\b[^>]*\breference="pico:\/\/artifact\/([^"<>]+)"[^>]*>/gu)].map(match => match[1]!)
    : [...(typeof message.providerData?.displayText === "string" ? message.providerData.displayText : message.content).matchAll(/pico:\/\/artifact\/([^\s"<>\])]+)/gu)].map(match => match[1]!);
  return [...new Set(refs.flatMap(ref => { try { return [decodeURIComponent(ref)]; } catch { return []; } }))].slice(0,20);
}
