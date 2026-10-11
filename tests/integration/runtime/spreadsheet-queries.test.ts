import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { querySpreadsheet } from "../../../packages/pico-host/src/input/spreadsheet-query.js";
import {
  DOCUMENT_QUERY_MAX_CHARS,
  type DocumentQuery,
} from "../../../packages/pico-host/src/input/document-query-contract.js";

async function fixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("销售");
  sheet.addRows([
    ["地区", "商品", "金额", "启用"],
    ["华东", "Widget", 10, true],
    [{ richText: [{ text: "华东" }] }, "WIDGET", { formula: "C2*2", result: 20 }, true],
    ["华西", "其他", null, true],
    ["华西", "其他", "30", true],
    ["华东", "其他", { formula: "C2*3" }, true],
    ["华西", "其他", 50, false],
    ["华东", "其他", { formula: "0", result: 0 }, true],
    ["华西", "其他", { error: "#VALUE!" }, true],
    ["华西", "其他", { formula: "FALSE()", result: false }, true],
    ["华西", "其他", new Date("2026-01-01T00:00:00Z"), true],
  ]);
  sheet.getRow(3).hidden = true;
  sheet.getCell("Z2000").value = "late marker";
  sheet.mergeCells("E2:F2");
  sheet.getCell("E2").value = 500;
  const notes = workbook.addWorksheet("Notes");
  notes.getCell("A1").value = "Widget widget";
  notes.getCell("B3").value = "end widget";
  notes.getCell("C4").value = "literal [a.*] marker";
  notes.getCell("D5").value = "İ Unicode CASE";
  notes.getCell("A6").value = "long-data ".repeat(2000);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("Excel queries preserve locations, paginate complete reads/searches and audit filtered grouped statistics", async () => {
  const bytes = await fixture();
  const run = (query: DocumentQuery) => querySpreadsheet(bytes, "销售.xlsx", query);
  const inspected = await run({ action: "inspect" });
  assert.deepEqual(inspected.manifest?.sheets, [
    { name: "销售", rows: 2000, columns: 26 },
    { name: "Notes", rows: 6, columns: 4 },
  ]);
  assert.match(inspected.text, /有界预览/u);
  assert.ok(inspected.text.length <= DOCUMENT_QUERY_MAX_CHARS);

  const read = await run({ action: "read", sheet: "销售", range: "B4:D4" });
  assert.match(read.text, /"销售"!B4 = "其他"\n"销售"!C4 = ""\n"销售"!D4 = "true"/u);
  assert.match((await run({ action: "read", range: "Z2000" })).text, /Z2000 = "late marker"/u);
  assert.match((await run({ action: "read", range: "C6" })).text, /公式缓存缺失/u);
  assert.match((await run({ action: "read", range: "E2:F2" })).text, /E2 = "500"\n"销售"!F2 = ""/u);
  const boundedRead = await run({
    action: "read",
    sheet: "Notes",
    range: "A6",
    limit: DOCUMENT_QUERY_MAX_CHARS,
  });
  assert.ok(boundedRead.text.length <= DOCUMENT_QUERY_MAX_CHARS);
  assert.ok(boundedRead.nextOffset !== undefined);
  const full = await run({ action: "read", range: "A1:D3" });
  let offset = 0;
  let combined = "";
  for (;;) {
    const part = await run({ action: "read", range: "A1:D3", offset, limit: 47 });
    combined += part.text.slice(part.text.indexOf("\n") + 1);
    assert.equal(part.total, full.total);
    if (part.nextOffset === undefined) break;
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  }
  assert.equal(combined, full.text.slice(full.text.indexOf("\n") + 1));
  assert.equal(combined.length, full.total);
  const first = await run({ action: "search", query: "wIdGeT", limit: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 2);
  assert.match(first.text, /"销售"!B2/u);
  const second = await run({
    action: "search",
    query: "wIdGeT",
    offset: first.nextOffset,
    limit: 2,
  });
  assert.equal(second.total, 5);
  assert.equal(second.nextOffset, 4);
  assert.match(second.text, /"Notes"!A1；单元格字符 offset=0/u);
  assert.match(second.text, /"Notes"!A1；单元格字符 offset=7/u);
  const last = await run({
    action: "search",
    query: "wIdGeT",
    offset: second.nextOffset,
    limit: 2,
  });
  assert.equal(last.nextOffset, undefined);
  assert.match(last.text, /"Notes"!B3/u);
  assert.equal((await run({ action: "search", query: "[a.*]" })).total, 1);
  assert.match((await run({ action: "search", query: "case" })).text, /offset=10/u);
  assert.equal((await run({ action: "search", query: "widget", sheet: "Notes" })).total, 3);
  assert.match((await run({ action: "search", query: "late marker" })).text, /Z2000/u);
  const boundedSearch = await run({ action: "search", query: "long-data", limit: 100 });
  assert.equal(boundedSearch.total, 2000);
  assert.ok(boundedSearch.text.length <= DOCUMENT_QUERY_MAX_CHARS);
  assert.ok(boundedSearch.nextOffset! > 0 && boundedSearch.nextOffset! < 100);
  const boundedSearchNext = await run({
    action: "search",
    query: "long-data",
    limit: 1,
    offset: boundedSearch.nextOffset!,
  });
  assert.match(boundedSearchNext.text, new RegExp(`匹配 ${boundedSearch.nextOffset}：`));

  const base = {
    action: "analyze",
    sheet: "销售",
    range: "A1:D11",
    column: "C",
    filters: [{ column: "D", operator: "eq", value: true }],
  } as const;
  const result = await run({ ...base, operation: "sum", groupBy: "A" });
  const report = JSON.parse(result.text);
  assert.equal(report.range, "A1:D11");
  assert.equal(report.dataRange, "A2:D11");
  assert.equal(report.totalRows, 10);
  assert.equal(report.matchedRows, 9);
  assert.equal(report.numericValues, 3);
  assert.equal(report.emptyValues, 1);
  assert.equal(report.nonNumericValues, 4);
  assert.equal(report.formulaCacheMissing, 1);
  assert.equal(report.formulaCacheUsed, 3);
  assert.equal(report.completeNumericCoverage, false);
  assert.equal(report.result, 30);
  assert.deepEqual(
    report.groups.map((group: { key: string; result: number }) => [group.key, group.result]),
    [
      ["华东", 30],
      ["华西", 0],
    ],
  );
  assert.match(result.warnings!.join("\n"), /缓存可能过期/u);
  assert.match(result.warnings!.join("\n"), /不代表完整数值合计/u);
  for (const [operation, expected] of [
    ["average", 10],
    ["min", 0],
    ["max", 20],
    ["count", 3],
  ] as const) {
    assert.equal(JSON.parse((await run({ ...base, operation })).text).result, expected);
  }
  assert.equal(
    JSON.parse(
      (await run({ action: "analyze", range: "A1:D11", operation: "count", filters: base.filters }))
        .text,
    ).result,
    9,
  );
  assert.equal(
    JSON.parse(
      (
        await run({
          action: "analyze",
          range: "C2:C2",
          header: false,
          operation: "sum",
          column: "C",
        })
      ).text,
    ).result,
    10,
  );
  assert.equal(
    JSON.parse(
      (
        await run({
          action: "analyze",
          range: "C4:C5",
          header: false,
          operation: "average",
          column: "C",
        })
      ).text,
    ).result,
    null,
  );
});

test("Excel analysis rejects unsafe sizes and unavailable filter caches instead of silently dropping data", async () => {
  const bytes = await fixture();
  const run = (query: DocumentQuery) => querySpreadsheet(bytes, "销售.xlsx", query);
  await assert.rejects(
    run({ action: "analyze", range: "A1:XFD1048576", operation: "count" }),
    /超过 200000/u,
  );
  await assert.rejects(run({ action: "read", range: "D4:A1" }), /顺序无效/u);
  await assert.rejects(
    run({ action: "analyze", range: "A1:C11", operation: "sum", column: "D" }),
    /不在所选范围/u,
  );
  await assert.rejects(
    run({
      action: "analyze",
      range: "A1:D11",
      operation: "count",
      filters: [{ column: "C", operator: "gt", value: 0 }],
    }),
    /C6.*公式缓存缺失/u,
  );
  await assert.rejects(
    run({ action: "analyze", range: "A1:D11", operation: "count", groupBy: "C" }),
    /C6.*公式缓存缺失/u,
  );
  await assert.rejects(run({ action: "search", query: "" }), /不能为空/u);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Groups");
  for (let row = 1; row <= 101; row++) sheet.getCell(`A${row}`).value = `group-${row}`;
  const manyGroups = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    querySpreadsheet(manyGroups, "groups.xlsx", {
      action: "analyze",
      range: "A1:A101",
      header: false,
      operation: "count",
      groupBy: "A",
    }),
    /超过 100 组/u,
  );
  for (let row = 1; row <= 90; row++)
    sheet.getCell(`A${row}`).value = "long-group".repeat(30) + row;
  await assert.rejects(
    querySpreadsheet(Buffer.from(await workbook.xlsx.writeBuffer()), "groups.xlsx", {
      action: "analyze",
      range: "A1:A90",
      header: false,
      operation: "count",
      groupBy: "A",
    }),
    /超过输出上限/u,
  );
});
