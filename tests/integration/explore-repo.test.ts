/**
 * explore_repo 工具的纯逻辑测试。
 * 测试导出的辅助函数：deriveQueries / scoreStructure / capSnippet / buildEvidence。
 * 不需要持久化 Session，不受沙箱 fsync 限制。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveQueries,
  scoreStructure,
  capSnippet,
  buildEvidence,
  type Candidate,
} from "../../src/tools/explore-repo.js";

// ============================================================
// deriveQueries
// ============================================================

test("deriveQueries: 从英文 objective 派生搜索词", () => {
  const queries = deriveQueries("find the authentication logic in this project");
  assert.ok(queries.includes("authentication"));
  assert.ok(queries.includes("logic"));
  assert.ok(!queries.includes("the"), "停用词应被过滤");
  assert.ok(!queries.includes("project"), "停用词应被过滤");
});

test("deriveQueries: 从中文 objective 派生搜索词", () => {
  const queries = deriveQueries("找到项目的用户认证逻辑");
  // 中文按非字母数字切分，"认证" 和 "逻辑" 应被保留
  assert.ok(queries.length > 0);
  assert.ok(!queries.includes("的"), "中文停用词应被过滤");
  assert.ok(!queries.includes("了"), "中文停用词应被过滤");
});

test("deriveQueries: 显式 queries 优先于派生", () => {
  const queries = deriveQueries("some objective", ["auth", "login", "session"]);
  assert.deepEqual(queries, ["auth", "login", "session"]);
});

test("deriveQueries: 无法切分时用 objective 前 80 字符", () => {
  const queries = deriveQueries("abc");
  assert.equal(queries.length, 1);
  assert.equal(queries[0], "abc");
});

// ============================================================
// scoreStructure
// ============================================================

test("scoreStructure: package.json 得 manifest 分", () => {
  const result = scoreStructure("package.json");
  assert.ok(result.score >= 12);
  assert.ok(result.reasons.includes("project manifest"));
});

test("scoreStructure: README.md 得 documentation 分", () => {
  const result = scoreStructure("README.md");
  assert.ok(result.score >= 10);
  assert.ok(result.reasons.includes("project documentation"));
});

test("scoreStructure: src/index.ts 得 entrypoint + source 分", () => {
  const result = scoreStructure("src/index.ts");
  assert.ok(result.reasons.includes("project entrypoint"));
  assert.ok(result.reasons.includes("project source surface"));
  assert.ok(result.score >= 10); // 8 + 2
});

test("scoreStructure: Java Application.java 得 entrypoint 分", () => {
  const result = scoreStructure("src/main/java/com/example/Application.java");
  assert.ok(result.reasons.includes("project entrypoint"));
  assert.ok(result.reasons.includes("project source surface"));
});

test("scoreStructure: pom.xml 得 manifest 分（Java 支持）", () => {
  const result = scoreStructure("pom.xml");
  assert.ok(result.reasons.includes("project manifest"));
});

test("scoreStructure: test 文件得 test surface 分", () => {
  const result = scoreStructure("src/auth/session.test.ts");
  assert.ok(result.reasons.includes("project test surface"));
});

test("scoreStructure: 普通文件不得结构分", () => {
  const result = scoreStructure("src/utils/helpers.ts");
  assert.ok(result.reasons.includes("project source surface"));
  assert.ok(!result.reasons.includes("project manifest"));
  assert.ok(!result.reasons.includes("project entrypoint"));
  assert.equal(result.score, 2); // 只有 source surface +2
});

// ============================================================
// capSnippet
// ============================================================

test("capSnippet: 短行原样返回（压空白后）", () => {
  assert.equal(capSnippet("hello world"), "hello world");
});

test("capSnippet: 多空白压缩为单空格", () => {
  assert.equal(capSnippet("hello    \t   world"), "hello world");
});

test("capSnippet: 超长行截断到 220 字符", () => {
  const long = "x".repeat(300);
  const result = capSnippet(long);
  assert.equal(result.length, 220);
});

test("capSnippet: emoji 不被截断成半个", () => {
  const emojiLine = "🔒".repeat(300); // 300 个 emoji 超过 220 码点限制
  const result = capSnippet(emojiLine);
  const codePoints = Array.from(result);
  assert.equal(codePoints.length, 220); // 截到 220 个码点
  // 确认没有半个代理对
  for (const cp of codePoints) {
    assert.ok(cp.length <= 2, "每个码点应是完整 emoji");
  }
});

// ============================================================
// buildEvidence
// ============================================================

test("buildEvidence: 空候选返回空数组", () => {
  assert.deepEqual(buildEvidence([]), []);
});

test("buildEvidence: 优先内容命中", () => {
  const candidates: Candidate[] = [
    {
      filePath: "src/auth.ts",
      symbols: [],
      score: 10,
      reasons: ["content match"],
      matches: [{ path: "src/auth.ts", line: 42, query: "auth", snippet: "const auth = ..." }],
    },
  ];
  const evidence = buildEvidence(candidates);
  // match 锚点 + candidate 锚点（同一文件两者各有，去重键不同）
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]!.line, 42);
  assert.match(evidence[0]!.label, /内容命中/);
});

test("buildEvidence: 补候选文件作为锚点", () => {
  const candidates: Candidate[] = [
    {
      filePath: "package.json",
      symbols: [],
      score: 12,
      reasons: ["project manifest"],
      matches: [],
    },
  ];
  const evidence = buildEvidence(candidates);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.path, "package.json");
  assert.match(evidence[0]!.label, /项目配置/);
});

test("buildEvidence: 封顶 10 个", () => {
  const candidates: Candidate[] = Array.from({ length: 15 }, (_, i) => ({
    filePath: `src/file${i}.ts`,
    symbols: [],
    score: 5,
    reasons: ["project source surface"],
    matches: [],
  }));
  const evidence = buildEvidence(candidates);
  assert.equal(evidence.length, 10);
});
