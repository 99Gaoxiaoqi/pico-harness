import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden =
  /^(?:node:|electron(?:\/|$)|@pico\/(?:pico-host|runtime-host|runtime|storage|cli|remote-gateway)(?:\/|$))/;
const errors = [];
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith("."))
      return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : [];
  });
}
for (const file of files(resolve(root, "apps/mobile"))) {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const inspect = (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      if (forbidden.test(name) || name === "@pico/protocol" || name === "@pico/protocol/runtime")
        errors.push(`${relative(root, file)}: 禁止移动端导入 ${name}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
}
// Bundling the complete shared entry graph for browsers rejects transitive Node built-ins.
const output = await build({
  absWorkingDir: root,
  entryPoints: [
    "packages/protocol/src/mobile.ts",
    "packages/protocol/src/remote.ts",
    "packages/remote-client/src/index.ts",
    "packages/transcript-replica/src/index.ts",
  ],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  outdir: ".mobile-boundary-check",
  metafile: true,
  logLevel: "silent",
});
for (const path of Object.keys(output.metafile.inputs)) {
  if (/node_modules\/(?!@pico\/)/.test(path)) continue;
  const source = readFileSync(resolve(root, path), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const inspect = (node) => {
    if (
      ts.isIdentifier(node) &&
      ["Buffer", "process", "__dirname", "__filename", "require"].includes(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !ts.isPropertyAssignment(node.parent) &&
      !ts.isTypeQueryNode(node.parent)
    ) {
      errors.push(`${path}: 共享移动代码引用 Node 全局 ${node.text}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(ast);
}
if (errors.length) {
  console.error([...new Set(errors)].join("\n"));
  process.exitCode = 1;
} else console.log("移动端直接依赖与共享协议/客户端/投影的浏览器依赖图检查通过。");
