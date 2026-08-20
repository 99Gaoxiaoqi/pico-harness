import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = fs
  .readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((f) => (f.includes("/") || f.includes("\\") ? f : `tests/integration/${f}`));
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
        "--test-concurrency=1",
        f,
      ],
      { timeout: 300000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
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
  fs.writeFileSync(".scratch/integration-sweep.log", out.join("\n") + "\n");
}
console.log(out.join("\n"));
const fails = out.filter((l) => l.startsWith("FAIL"));
console.log(`\nTOTAL ${out.length} FAILS ${fails.length}`);
