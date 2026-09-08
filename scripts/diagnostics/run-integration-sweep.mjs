import { execFileSync } from "node:child_process";
import fs from "node:fs";

const LOG = ".scratch/integration-sweep.log";

const listFile = process.argv[2];
if (!listFile) {
  console.error("用法: node scripts/diagnostics/run-integration-sweep.mjs <测试清单文件>");
  process.exit(2);
}
const lines = fs
  .readFileSync(listFile, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);
if (!lines.every((l) => /\.test\.(tsx?|js)$/u.test(l))) {
  console.error(`入参 ${listFile} 不是测试清单(应每行一个 *.test.ts);拒绝运行以免覆写上次进度日志`);
  process.exit(2);
}
const discovered = execFileSync(process.execPath, ["scripts/run-integration-tests.mjs", "--list"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
const files = lines.map((file) => {
  if (file.includes("/") || file.includes("\\")) return file;
  const matches = discovered.filter((path) => path.endsWith(`/${file}`));
  if (matches.length !== 1) throw new Error(`测试名必须唯一且存在：${file}`);
  return matches[0];
});
// 保留上次进度:新日志写入前把旧的另存为 -prev.log(对抗审计事故教训)。
if (fs.existsSync(LOG)) {
  fs.copyFileSync(LOG, LOG.replace(/\.log$/u, "-prev.log"));
}
const out = [];
for (const f of files) {
  const t0 = Date.now();
  try {
    const r = execFileSync(
      "node",
      [
        "--import",
        "tsx",
        "--import",
        "./src/tui/preload-env.ts",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=1",
        f,
      ],
      {
        timeout: 300000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const pass = (r.match(/^# pass (\d+)/m) || [])[1];
    const fail = (r.match(/^# fail (\d+)/m) || [])[1];
    out.push(`PASS ${f} pass=${pass} fail=${fail} ${((Date.now() - t0) / 1000) | 0}s`);
  } catch (e) {
    const s = (e.stdout || "") + (e.stderr || "");
    const pass = (s.match(/^# pass (\d+)/m) || [])[1];
    const fail = (s.match(/^# fail (\d+)/m) || [])[1];
    out.push(
      `FAIL ${f} pass=${pass || "?"} fail=${fail || "?"} ${((Date.now() - t0) / 1000) | 0}s${e.killed ? " TIMEOUT" : ""}`,
    );
  }
  fs.writeFileSync(LOG, out.join("\n") + "\n");
}
console.log(out.join("\n"));
const fails = out.filter((l) => l.startsWith("FAIL"));
console.log(`\nTOTAL ${out.length} FAILS ${fails.length}`);
