import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("query-string CommonJS consumers use decoder 0.5 with Unicode, plus signs and malformed escapes", () => {
  assert.equal(require("query-string/package.json").version, "7.1.3");
  const queryStringRequire = createRequire(require.resolve("query-string"));
  const decoderPath = queryStringRequire.resolve("decode-uri-component");
  assert.equal(
    JSON.parse(readFileSync(join(dirname(decoderPath), "package.json"), "utf8")).version,
    "0.5.1",
  );
  const query = require("query-string");
  const parsed = query.parse("q=%E4%B8%AD%E6%96%87%F0%9F%9A%80&space=a+b&plus=%2B&empty=&flag");
  assert.deepEqual({ ...parsed }, { q: "中文🚀", space: "a b", plus: "+", empty: "", flag: null });
  assert.deepEqual({ ...query.parse(query.stringify(parsed)) }, { ...parsed });
  assert.deepEqual(
    { ...query.parse("q=%E4%B8%AD%ZZ&bad=%&utf8=%E0%A4%A") },
    {
      q: "中%ZZ",
      bad: "%",
      utf8: "%E0%A4%A",
    },
  );
  assert.deepEqual({ ...query.parse("q=%2B+a", { decode: false }) }, { q: "%2B+a" });
});
