import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const desktopRoot = resolve(process.cwd());
const packageRoot = join(desktopRoot, "out", `Pico-${process.platform}-${process.arch}`);
const resourcesRoot =
  process.platform === "darwin"
    ? join(packageRoot, "Pico.app", "Contents", "Resources")
    : join(packageRoot, "resources");
const unpackedModules = join(resourcesRoot, "app.asar.unpacked", "node_modules");

await access(join(resourcesRoot, "app.asar"));
const nativeBindings = await collectNativeBindings(unpackedModules);
for (const expected of ["better_sqlite3.node", "pty.node"]) {
  if (!nativeBindings.some((path) => path.endsWith(expected))) {
    throw new Error(`桌面安装包缺少原生 Runtime 依赖: ${expected}`);
  }
}
if (process.platform !== "win32") {
  await access(
    join(
      unpackedModules,
      "node-pty",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
    constants.X_OK,
  );
}

const executable =
  process.platform === "darwin"
    ? join(packageRoot, "Pico.app", "Contents", "MacOS", "Pico")
    : join(packageRoot, "Pico.exe");
const nativeSmokeSource = String.raw`
const root = process.argv[1];
const Database = require(root + "/app.asar/node_modules/better-sqlite3");
const database = new Database(":memory:");
database.exec("select 1");
database.close();
const pty = require(root + "/app.asar/node_modules/node-pty");
if (process.platform === "win32") {
  process.stdout.write(typeof pty.spawn === "function" ? "PICO_NATIVE_OK" : "");
} else {
  const terminal = pty.spawn("/bin/sh", ["-lc", "printf PICO_NATIVE_OK"], { cols: 80, rows: 24 });
  let output = "";
  terminal.onData((data) => (output += data));
  terminal.onExit(() => process.stdout.write(output));
}
`;
const { stdout } = await execFileAsync(executable, ["-e", nativeSmokeSource, resourcesRoot], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (stdout.trim() !== "PICO_NATIVE_OK") {
  throw new Error(`桌面安装包原生模块运行失败: ${JSON.stringify(stdout)}`);
}

process.stdout.write(`桌面安装包原生依赖验证通过（${nativeBindings.length} 个 binding）\n`);

async function collectNativeBindings(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectNativeBindings(path)));
    else if (entry.isFile() && entry.name.endsWith(".node")) paths.push(path);
  }
  return paths;
}
