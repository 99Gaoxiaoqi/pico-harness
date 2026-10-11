import ExcelJS from "exceljs";
import {
  DOCUMENT_QUERY_MAX_CHARS,
  type DocumentManifest,
  type DocumentQuery,
  type DocumentQueryResult,
  type SpreadsheetFilter,
} from "./document-query-contract.js";

const MAX_RANGE_CELLS = 200_000;
const MAX_SEARCH_CELLS = 500_000;
const MAX_GROUPS = 100;
const FORMULA_WARNING = "公式仅使用文件中已保存的缓存值，缓存可能过期；不会重算公式。";
const VALUE_WARNING =
  "只聚合有限数值，计算采用 IEEE-754 双精度（可能存在浮点舍入）；文本（包括数字字符串）、日期、布尔值和错误值不转换为数字。合并单元格仅计左上角；包含隐藏行、隐藏列及被 Excel 自动筛选隐藏的行。";

type AnalyzeQuery = Extract<DocumentQuery, { action: "analyze" }>;
type Scalar = string | number | boolean | null;
interface CellData {
  value: Scalar;
  kind: string;
  text: string;
  formula: boolean;
  missingCache: boolean;
}
interface Selection {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
  address: string;
}
interface Aggregate {
  matchedRows: number;
  numericValues: number;
  emptyValues: number;
  nonNumericValues: number;
  formulaCacheMissing: number;
  formulaCacheUsed: number;
  sum: number;
  min: number | null;
  max: number | null;
}

function bounded(text: string): string {
  if (text.length > DOCUMENT_QUERY_MAX_CHARS)
    throw new Error("Excel 查询结果超过输出上限，请缩小范围、减少分组或缩短单元格内容。");
  return text;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function columnName(column: number): string {
  let result = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function columnNumber(column: string): number {
  if (!/^[A-Z]{1,3}$/iu.test(column)) throw new Error(`无效的 Excel 列：${quote(column)}。`);
  const result = [...column.toUpperCase()].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  );
  if (result > 16_384) throw new Error("Excel 列不能超过 XFD。");
  return result;
}

function selectRange(sheet: ExcelJS.Worksheet, requested?: string): Selection {
  const address =
    requested ?? `A1:${columnName(Math.max(1, sheet.columnCount))}${Math.max(1, sheet.rowCount)}`;
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/iu.exec(
    address,
  );
  if (!match) throw new Error("range 必须是单个 A1 单元格或矩形 A1:D20；工作表请用 sheet 指定。");
  const startColumn = columnNumber(match[1]!);
  const endColumn = columnNumber(match[3] ?? match[1]!);
  const startRow = Number(match[2]);
  const endRow = Number(match[4] ?? match[2]);
  if (endRow > 1_048_576 || startRow > endRow || startColumn > endColumn)
    throw new Error("Excel 范围越界或起止顺序无效。");
  if ((endRow - startRow + 1) * (endColumn - startColumn + 1) > MAX_RANGE_CELLS)
    throw new Error(`Excel 范围超过 ${MAX_RANGE_CELLS} 个单元格，请明确缩小 range；不会截断统计。`);
  return {
    startRow,
    endRow,
    startColumn,
    endColumn,
    address: `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`,
  };
}

function sheetFor(workbook: ExcelJS.Workbook, name?: string): ExcelJS.Worksheet {
  const sheet =
    name === undefined
      ? workbook.worksheets[0]
      : workbook.worksheets.find((candidate) => candidate.name === name);
  if (!sheet)
    throw new Error(
      name === undefined ? "Excel 文件没有工作表。" : `工作表不存在：${quote(name)}。`,
    );
  return sheet;
}

function cellData(cell?: ExcelJS.Cell): CellData {
  const empty = {
    value: null,
    kind: "empty",
    text: "",
    formula: false,
    missingCache: false,
  } as const;
  if (!cell || (cell.isMerged && cell.master.address !== cell.address)) return empty;
  let value = cell.value;
  let formula = "";
  let isFormula = false;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
    isFormula = true;
    formula =
      "formula" in value ? (value.formula ?? "[未记录公式]") : `共享公式 ${value.sharedFormula}`;
    // ExcelJS cell.value omits falsy formula results; cell.result preserves 0/false/"".
    const result = cell.result;
    if (result === undefined || result === null)
      return {
        value: null,
        kind: "missingFormulaCache",
        text: `=${formula} [公式缓存缺失]`,
        formula: true,
        missingCache: true,
      };
    value = result;
  }
  let normalized: Scalar;
  let kind: string;
  if (value === null || value === undefined || value === "") {
    normalized = null;
    kind = "empty";
  } else if (value instanceof Date) {
    normalized = Number.isFinite(value.getTime()) ? value.toISOString() : "[无效日期]";
    kind = "date";
  } else if (typeof value === "object") {
    normalized =
      "richText" in value
        ? value.richText.map((part) => part.text).join("")
        : "text" in value
          ? value.text
          : "error" in value
            ? `[错误 ${value.error}]`
            : "[不支持的单元格值]";
    kind = "error" in value ? "error" : "string";
  } else {
    normalized = value;
    kind = typeof value;
  }
  if (normalized === "") {
    normalized = null;
    kind = "empty";
  }
  const text = normalized === null ? "" : String(normalized);
  return {
    value: normalized,
    kind,
    text: isFormula ? `${text} [公式=${formula}]` : text,
    formula: isFormula,
    missingCache: false,
  };
}

// findRow/findCell preserve sparse sheets without allocating empty rows/cells.
function readCell(sheet: ExcelJS.Worksheet, row: number, column: number): CellData {
  return cellData(sheet.findRow(row)?.findCell(column));
}

function location(sheet: ExcelJS.Worksheet, address: string): string {
  return `${quote(sheet.name)}!${address}`;
}

function manifest(workbook: ExcelJS.Workbook, name: string): DocumentManifest {
  return {
    kind: "spreadsheet",
    name,
    sheets: workbook.worksheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
    })),
    warnings: [FORMULA_WARNING, VALUE_WARNING],
  };
}

function inspect(workbook: ExcelJS.Workbook, name: string): DocumentQueryResult {
  const info = manifest(workbook, name);
  let text = `Excel ${quote(name)}；共 ${workbook.worksheets.length} 张工作表。尺寸为最大行/列坐标（可能包括仅有格式的单元格）。\n`;
  for (const sheet of info.sheets!)
    text += `工作表 ${quote(sheet.name)}：${sheet.rows} 行 × ${sheet.columns} 列\n`;
  bounded(text + "\n预览受限；使用 read 指定 sheet/range 继续读取。\n");
  text += "\n有界预览（每表左上角最多 3 行 × 4 列，每格最多 120 字符；空洞保留）：\n";
  for (const sheet of workbook.worksheets) {
    for (let row = 1; row <= Math.min(3, sheet.rowCount); row++) {
      for (let column = 1; column <= Math.min(4, sheet.columnCount); column++) {
        const value = readCell(sheet, row, column).text;
        const line = `${location(sheet, `${columnName(column)}${row}`)} = ${quote(value.length > 120 ? value.slice(0, 119) + "…" : value)}\n`;
        if (text.length + line.length > DOCUMENT_QUERY_MAX_CHARS - 100)
          return {
            kind: "spreadsheet",
            text: bounded(text + "[预览已到输出上限；使用 read 指定 sheet/range 继续读取。]"),
            manifest: info,
          };
        text += line;
      }
    }
  }
  return { kind: "spreadsheet", text: bounded(text), manifest: info };
}

function offsetAndLimit(
  offset: number | undefined,
  limit: number | undefined,
  defaultLimit: number,
  maximum: number,
): { offset: number; limit: number } {
  if (!Number.isSafeInteger(offset ?? 0) || (offset ?? 0) < 0)
    throw new Error("offset 必须是非负整数。");
  if (
    !Number.isSafeInteger(limit ?? defaultLimit) ||
    (limit ?? defaultLimit) < 1 ||
    (limit ?? defaultLimit) > maximum
  )
    throw new Error(`limit 必须是 1 到 ${maximum} 的整数。`);
  return { offset: offset ?? 0, limit: limit ?? defaultLimit };
}

function read(
  workbook: ExcelJS.Workbook,
  query: Extract<DocumentQuery, { action: "read" }>,
): DocumentQueryResult {
  if (query.page !== undefined) throw new Error("Excel 不支持 page，请使用 sheet 和 range。");
  const sheet = sheetFor(workbook, query.sheet);
  const range = selectRange(sheet, query.range);
  const { offset, limit } = offsetAndLimit(
    query.offset,
    query.limit,
    12_000,
    DOCUMENT_QUERY_MAX_CHARS,
  );
  let total = 0;
  let body = "";
  for (let row = range.startRow; row <= range.endRow; row++) {
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      const line = `${location(sheet, `${columnName(column)}${row}`)} = ${quote(readCell(sheet, row, column).text)}\n`;
      if (total + line.length > offset && body.length < limit)
        body += line.slice(
          Math.max(0, offset - total),
          Math.max(0, offset - total) + limit - body.length,
        );
      total += line.length;
    }
  }
  if (offset > total) throw new Error(`offset 超出所选范围文本长度 ${total}。`);
  const heading = `工作表 ${quote(sheet.name)}；范围 ${range.address}；字符 offset=${offset}，total=${total}（UTF-16，含坐标标签及空单元格）。\n`;
  const available = DOCUMENT_QUERY_MAX_CHARS - heading.length;
  if (available < 1) throw new Error("Excel 工作表名称超过输出上限。");
  body = body.slice(0, available);
  const nextOffset = offset + body.length;
  return {
    kind: "spreadsheet",
    text: bounded(heading + body),
    total,
    ...(nextOffset < total ? { nextOffset } : {}),
    warnings: [FORMULA_WARNING, VALUE_WARNING],
  };
}

function search(
  workbook: ExcelJS.Workbook,
  query: Extract<DocumentQuery, { action: "search" }>,
): DocumentQueryResult {
  if (!query.query || query.query.length > 1_000)
    throw new Error("搜索词不能为空，且不能超过 1000 字符。");
  const { offset, limit } = offsetAndLimit(query.offset, query.limit, 20, 100);
  const sheets =
    query.sheet === undefined ? workbook.worksheets : [sheetFor(workbook, query.sheet)];
  const pattern = new RegExp(query.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  const heading = `Excel 字面量搜索 ${quote(query.query)}；不区分大小写，匹配不重叠；搜索单元格显示文本及公式。`;
  const budget = DOCUMENT_QUERY_MAX_CHARS - heading.length - 512;
  const matches: string[] = [];
  let total = 0;
  let scannedCells = 0;
  let outputChars = 0;
  let pageFull = false;
  for (const sheet of sheets) {
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (++scannedCells > MAX_SEARCH_CELLS)
          throw new Error(
            `Excel 搜索超过 ${MAX_SEARCH_CELLS} 个非空单元格，请指定较小的工作表；不会返回不完整匹配数。`,
          );
        const value = cellData(cell).text;
        pattern.lastIndex = 0;
        for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
          const found = match.index;
          if (total >= offset && matches.length < limit && !pageFull) {
            const excerpt = value.slice(
              Math.max(0, found - 60),
              Math.min(value.length, found + match[0].length + 100),
            );
            const line = `匹配 ${total}：${location(sheet, cell.address)}；单元格字符 offset=${found}；${quote(excerpt)}\n`;
            if (outputChars + line.length <= budget) {
              matches.push(line);
              outputChars += line.length;
            } else pageFull = true;
          }
          total++;
        }
      }),
    );
  }
  if (offset > total) throw new Error(`offset 超出匹配数 ${total}。`);
  const nextOffset = offset + matches.length;
  return {
    kind: "spreadsheet",
    text: bounded(
      heading +
        `已扫描 ${sheets.length} 张表、${scannedCells} 个非空单元格；总匹配 ${total}，返回 ${matches.length}，匹配 offset=${offset}。\n` +
        matches.join(""),
    ),
    total,
    ...(nextOffset < total ? { nextOffset } : {}),
    warnings: [FORMULA_WARNING],
  };
}

function emptyAggregate(): Aggregate {
  return {
    matchedRows: 0,
    numericValues: 0,
    emptyValues: 0,
    nonNumericValues: 0,
    formulaCacheMissing: 0,
    formulaCacheUsed: 0,
    sum: 0,
    min: null,
    max: null,
  };
}

function accumulate(
  aggregate: Aggregate,
  operation: AnalyzeQuery["operation"],
  data?: CellData,
): void {
  aggregate.matchedRows++;
  if (!data) return;
  if (data.missingCache) {
    aggregate.formulaCacheMissing++;
    return;
  }
  if (data.formula) aggregate.formulaCacheUsed++;
  if (data.value === null) {
    aggregate.emptyValues++;
    return;
  }
  if (typeof data.value !== "number" || !Number.isFinite(data.value)) {
    aggregate.nonNumericValues++;
    return;
  }
  aggregate.numericValues++;
  if (operation === "sum" || operation === "average") {
    aggregate.sum += data.value;
    if (!Number.isFinite(aggregate.sum))
      throw new Error("Excel 数值聚合溢出，无法可靠统计，请缩小范围。");
  }
  aggregate.min = aggregate.min === null ? data.value : Math.min(aggregate.min, data.value);
  aggregate.max = aggregate.max === null ? data.value : Math.max(aggregate.max, data.value);
}

function aggregateResult(aggregate: Aggregate, query: AnalyzeQuery): number | null {
  switch (query.operation) {
    case "sum":
      return aggregate.sum;
    case "average":
      return aggregate.numericValues ? aggregate.sum / aggregate.numericValues : null;
    case "min":
      return aggregate.min;
    case "max":
      return aggregate.max;
    case "count":
      return query.column === undefined ? aggregate.matchedRows : aggregate.numericValues;
  }
}

function audit(aggregate: Aggregate): Omit<Aggregate, "sum" | "min" | "max"> {
  const { sum: _sum, min: _min, max: _max, ...counts } = aggregate;
  return counts;
}

function matchesFilter(data: CellData, filter: SpreadsheetFilter): boolean {
  switch (filter.operator) {
    case "eq":
      return data.value === filter.value;
    case "ne":
      return data.value !== filter.value;
    case "contains":
      return (
        typeof data.value === "string" &&
        data.value.toLowerCase().includes(String(filter.value).toLowerCase())
      );
    case "gt":
      return typeof data.value === "number" && data.value > (filter.value as number);
    case "gte":
      return typeof data.value === "number" && data.value >= (filter.value as number);
    case "lt":
      return typeof data.value === "number" && data.value < (filter.value as number);
    case "lte":
      return typeof data.value === "number" && data.value <= (filter.value as number);
  }
}

function analyze(workbook: ExcelJS.Workbook, query: AnalyzeQuery): DocumentQueryResult {
  const sheet = sheetFor(workbook, query.sheet);
  const range = selectRange(sheet, query.range);
  const resolveColumn = (column: string): number => {
    const number = columnNumber(column);
    if (number < range.startColumn || number > range.endColumn)
      throw new Error(`列 ${column} 不在所选范围 ${range.address} 内。`);
    return number;
  };
  if (!query.column && query.operation !== "count")
    throw new Error(`${query.operation} 必须指定数值 column。`);
  const metricColumn = query.column === undefined ? undefined : resolveColumn(query.column);
  const groupColumn = query.groupBy === undefined ? undefined : resolveColumn(query.groupBy);
  if ((query.filters?.length ?? 0) > 20) throw new Error("Excel 筛选条件不能超过 20 个。");
  const filters = (query.filters ?? []).map((filter) => {
    if (
      ["gt", "gte", "lt", "lte"].includes(filter.operator) &&
      (typeof filter.value !== "number" || !Number.isFinite(filter.value))
    )
      throw new Error("大小比较筛选必须提供有限数值，不会隐式转换字符串。");
    if (typeof filter.value === "number" && !Number.isFinite(filter.value))
      throw new Error("筛选值必须是有限数值。");
    return { filter, column: resolveColumn(filter.column) };
  });
  const firstRow = range.startRow + (query.header === false ? 0 : 1);
  const totalRows = Math.max(0, range.endRow - firstRow + 1);
  const aggregate = emptyAggregate();
  const groups = new Map<string, { key: Scalar; type: string; aggregate: Aggregate }>();
  let filterAndGroupFormulaCacheUsed = 0;
  for (let row = firstRow; row <= range.endRow; row++) {
    const cachedCells = new Map<number, CellData>();
    const inputCell = (column: number): CellData => {
      let data = cachedCells.get(column);
      if (!data) {
        data = readCell(sheet, row, column);
        if (data.missingCache)
          throw new Error(
            `${location(sheet, `${columnName(column)}${row}`)} 的公式缓存缺失，无法可靠筛选或分组；请在 Excel 重算并保存后重试。`,
          );
        if (data.formula) filterAndGroupFormulaCacheUsed++;
        cachedCells.set(column, data);
      }
      return data;
    };
    if (!filters.every(({ filter, column }) => matchesFilter(inputCell(column), filter))) continue;
    const metric = metricColumn === undefined ? undefined : readCell(sheet, row, metricColumn);
    accumulate(aggregate, query.operation, metric);
    if (groupColumn !== undefined) {
      const group = inputCell(groupColumn);
      const key = JSON.stringify([group.kind, group.value]);
      let entry = groups.get(key);
      if (!entry) {
        if (groups.size >= MAX_GROUPS)
          throw new Error(`Excel 分组超过 ${MAX_GROUPS} 组，请缩小范围或增加筛选；不会截断统计。`);
        entry = { key: group.value, type: group.kind, aggregate: emptyAggregate() };
        groups.set(key, entry);
      }
      accumulate(entry.aggregate, query.operation, metric);
    }
  }
  const warnings = [FORMULA_WARNING, VALUE_WARNING];
  if (aggregate.formulaCacheMissing)
    warnings.push(
      `有 ${aggregate.formulaCacheMissing} 个匹配行的指标单元格缺少公式缓存；结果仅覆盖可用数值，不代表完整数值合计。`,
    );
  const output = {
    sheet: sheet.name,
    range: range.address,
    dataRange: totalRows
      ? `${columnName(range.startColumn)}${firstRow}:${columnName(range.endColumn)}${range.endRow}`
      : null,
    header: query.header !== false,
    operation: query.operation,
    column: query.column?.toUpperCase() ?? null,
    groupBy: query.groupBy?.toUpperCase() ?? null,
    filters: query.filters ?? [],
    semantics:
      "筛选为 AND；eq/ne 严格区分值类型及大小写，contains 不区分大小写，大小比较仅比较数值。count 无 column 时统计匹配行（含空行），有 column 时统计数值。空数值集的 sum/count 为 0，average/min/max 为 null。审计值分类和公式计数均针对匹配行的指标单元格，formulaCacheUsed 包含非数值缓存；筛选/分组缓存使用另计且每行按列去重。",
    totalRows,
    ...audit(aggregate),
    filterAndGroupFormulaCacheUsed,
    completeNumericCoverage: aggregate.formulaCacheMissing === 0,
    result: aggregateResult(aggregate, query),
    ...(groupColumn === undefined
      ? {}
      : {
          groups: [...groups.values()].map((group) => ({
            key: group.key,
            type: group.type,
            ...audit(group.aggregate),
            result: aggregateResult(group.aggregate, query),
          })),
        }),
    warnings,
  };
  return {
    kind: "spreadsheet",
    text: bounded(JSON.stringify(output, null, 2)),
    total: totalRows,
    warnings,
  };
}

/** The caller validates Office ZIP sizes and CRCs before loading the workbook. */
export async function querySpreadsheet(
  bytes: Buffer,
  name: string,
  query: DocumentQuery,
): Promise<DocumentQueryResult> {
  if (query.action === "view")
    throw new Error("Excel 不支持 view，请使用 inspect/read/search/analyze。");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  switch (query.action) {
    case "inspect":
      return inspect(workbook, name);
    case "read":
      return read(workbook, query);
    case "search":
      return search(workbook, query);
    case "analyze":
      return analyze(workbook, query);
  }
}
