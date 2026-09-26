import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "apps/desktop/src/renderer/astryx-theme");
const temporary = mkdtempSync(join(tmpdir(), "pico-theme-"));
const check = process.argv.includes("--check");
try {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("@astryxdesign/cli")),
      "theme",
      "build",
      "src/renderer/astryx-theme/picoTheme.ts",
      "--out",
      join(temporary, "pico.css"),
    ],
    { cwd: join(root, "apps/desktop"), stdio: "inherit" },
  );
  for (const name of ["pico.css", "pico.js", "pico.d.ts"]) {
    let source = readFileSync(join(temporary, name), "utf8")
      .replace(/^ \* Generated: .*\n/m, "")
      .replace(/^ \* Command: .*$/m, " * Command: npm run astryx:theme")
      .replace(/^\/\/\/ <reference path="\.\/pico\.variants\.d\.ts" \/>\n/m, "");
    if (name.endsWith(".css")) {
      // Built themes skip runtime injection. Only remove the generator's prose
      // reset, leaving existing Pico headings, lists and message spacing intact.
      const start = source.indexOf("@layer reset {");
      if (start < 0)
        throw new Error("Astryx theme output no longer contains the expected prose reset");
      let depth = 0;
      let end = source.indexOf("{", start);
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        if (source[end] === "}" && --depth === 0) break;
      }
      if (depth !== 0) throw new Error("Unbalanced Astryx theme reset");
      source = source.slice(0, start) + source.slice(end + 1);
    }
    const target = join(directory, name);
    if (check) {
      if (readFileSync(target, "utf8") !== source) throw new Error(`Stale theme artifact: ${name}`);
    } else writeFileSync(target, source);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
