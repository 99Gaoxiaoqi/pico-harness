import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { analyzeHardlineBashCommand, initializeBashParser } from "@pico/runtime/bash-hardline";
import {
  analyzePowerShellHardlineCommand,
  classifyPowerShellHardlineCommand,
} from "@pico/runtime/powershell-safety";
import {
  buildForegroundSafetyMiddleware,
  buildPermissionMiddleware,
} from "@pico/pico-host/agent-runtime";
import { BashTool } from "@pico/pico-host/bash-tool";
import { ToolRegistry } from "@pico/pico-host/tool-registry";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

before(async () => {
  if (process.platform !== "win32") await initializeBashParser();
});

const ORIGINAL_COMMAND = [
  "node - <<'NODE'",
  "const fs=require('fs'), path=require('path');",
  "for (const base of ['packages','apps']) {",
  " for (const name of fs.readdirSync(base).sort()) {",
  " const p=path.join(base,name,'package.json');",
  " if (!fs.existsSync(p)) continue;",
  " const j=JSON.parse(fs.readFileSync(p,'utf8'));",
  " console.log(`\\n[${j.name}] ${path.dirname(p)}`);",
  " console.log(' deps:', Object.keys(j.dependencies||{}).join(', ')||'-');",
  " console.log(' exports:', Object.keys(j.exports||{}).join(', ')||'-');",
  " }",
  "}",
  "NODE",
  "printf '\\n--- package source dirs ---\\n'",
  'for d in packages/*; do [ -d "$d" ] || continue; echo "[$d]"; find "$d" -maxdepth 2 -type d -not -path \'*/node_modules*\' | sort | sed -n \'1,80p\'; done',
  "printf '\\n--- executable entry files ---\\n'",
  "find src apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer apps/mobile/app packages/cli/src packages/pico-host/src packages/runtime/src packages/storage/src packages/protocol/src packages/runtime-host/src -maxdepth 2 -type f 2>/dev/null | sort | sed -n '1,360p'",
].join("\n");

test(
  "完整 Node heredoc 与目录循环通过 Registry→BashTool 执行且 full-access 无审批",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-original-hardline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    for (const path of [
      "src/entry.ts",
      "apps/desktop/src/main/main.ts",
      "apps/desktop/src/preload/preload.ts",
      "apps/desktop/src/renderer/view.ts",
      "apps/mobile/app/index.ts",
      "packages/cli/src/main.ts",
      "packages/pico-host/src/host.ts",
      "packages/runtime/src/runtime.ts",
      "packages/storage/src/storage.ts",
      "packages/protocol/src/protocol.ts",
      "packages/runtime-host/src/entry.ts",
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "// fixture\n");
    }
    await writeFile(
      join(root, "packages/runtime/package.json"),
      JSON.stringify({
        name: "@fixture/runtime",
        dependencies: { "fixture-dep": "1" },
        exports: { ".": "./src/runtime.ts" },
      }),
    );
    await writeFile(
      join(root, "apps/desktop/package.json"),
      JSON.stringify({ name: "@fixture/desktop" }),
    );
    assert.equal(analyzeHardlineBashCommand(ORIGINAL_COMMAND, root).kind, "unknown");
    const registry = new ToolRegistry();
    const roots = await WorkspaceRoots.create(root);
    registry.register(new BashTool(root));
    registry.useSafety(buildForegroundSafetyMiddleware(root, undefined, roots));
    let approvals = 0;
    registry.usePermission(
      buildPermissionMiddleware(
        () => {
          approvals++;
          throw new Error("full-access 不应请求审批");
        },
        root,
        undefined,
        undefined,
        { sessionId: "original-command", permissionMode: "full-access", additionalDirectories: [] },
        roots,
      ),
    );
    const result = await registry.execute({
      id: "original",
      name: "bash",
      arguments: JSON.stringify({ command: ORIGINAL_COMMAND, boundary_intent: "current" }),
    });
    assert.equal(result.isError, false, result.output);
    assert.doesNotMatch(result.output, /Hardline|执行被系统拦截/u);
    assert.match(result.output, /\[@fixture\/runtime\] packages\/runtime/u);
    assert.match(result.output, /deps: fixture-dep/u);
    assert.match(result.output, /exports: \./u);
    assert.match(result.output, /--- package source dirs ---/u);
    assert.match(result.output, /packages\/runtime\/src/u);
    assert.match(result.output, /--- executable entry files ---/u);
    assert.match(result.output, /apps\/desktop\/src\/main\/main.ts/u);
    assert.match(result.output, /src\/entry.ts/u);
    // Run only safe counterparts through the same real Registry/BashTool chain.
    const proofCommand = [
      String.raw`printf '<%s>\n' $'rm\0foo'`,
      "unset X",
      "cat <<EOF",
      String.raw`\\$(printf HEREDOC_SUB >&2)`,
      "${X:-`printf DEFAULT_SUB >&2`}",
      "EOF",
      'for i in 1 2; do printf "%s/passwd\\n" "$PWD"; cd /etc; done',
    ].join("\n");
    const proof = await registry.execute({
      id: "safe-adversarial-proof",
      name: "bash",
      arguments: JSON.stringify({ command: proofCommand, boundary_intent: "current" }),
    });
    assert.equal(proof.isError, false, proof.output);
    assert.match(proof.output, /<rm>/u);
    assert.match(proof.output, /HEREDOC_SUB/u);
    assert.match(proof.output, /DEFAULT_SUB/u);
    assert.match(proof.output, /\/etc\/passwd/u);
    assert.equal(approvals, 0);
  },
);

test(
  "Bash AST 数据边界、变量作用域和聚合优先级保留确定红线",
  { skip: process.platform === "win32" },
  () => {
    const cwd = "/tmp/pico-parser-fixture";
    const kind = (command: string) => analyzeHardlineBashCommand(command, cwd).kind;
    for (const command of [
      "cat <<'EOF'\n`rm -rf /` ${bad} rm -rf / shutdown\nEOF",
      'cat <<"EOF"\n$(rm -rf /) ${bad}\nEOF',
      "cat <<-'EOF'\n\t`rm -rf /`\n\tEOF",
      "cat <<'A' <<'B'\nrm -rf /\nA\n`shutdown`\nB",
      "cat <<A <<B <<C\nfirst\nA\nsecond\nB\nthird\nC",
      "cat <<-'A' <<-'B'\n\tfirst\n\tA\n\t`rm -rf /`\n\tB",
      "cat <<EOF\n${DATA}\nEOF",
      "p=/etc; rm -rf '$p'",
      "p=/etc; rm -rf \\$p",
      "p=/etc; rm -rf $'$p'",
      "p=./safe; echo ok; printf '%s' ok; node --version; find \"$p\" -type f",
      "{ cd /etc; echo ok; } > local.txt",
      'p=./safe; (p=/etc); rm -f "$p"',
      "cat <<'EOF'\n\\\\$(rm -rf /)\n${X:-`rm -rf /`}\nEOF",
      "for i in 1; do rm -f passwd; cd /etc; done",
      "for i in 1 2; do (cd /etc); rm -f passwd; done",
      "/usr/bin/time -o ./timing /usr/bin/printf ok",
      "/usr/bin/time -o /dev/null /usr/bin/printf ok",
      "cd /etc; printf safe >&2",
      'n=2; cd /etc; printf safe >&"$n"',
      // A continued physical delimiter is data until the next logical delimiter.
      "cat <<A <<'B'\nx\\\nA\nB\nrm -rf /etc\nA\nsafe\nB",
      "cat <<A\nx\\\nA\nrm -rf /etc\nA",
    ])
      assert.equal(kind(command), "no_match", command);
    for (const command of [
      "node - <<'NODE'\nconsole.log(`rm -rf / ${1}`)\nNODE",
      "python - <<'PY'\nprint('shutdown reboot')\nPY",
      "node -e 'console.log(process.argv[1])' 'rm -rf /'",
      "python -c 'print(1)' 'rm -rf /'",
      "cat <<-EOF\ndata\n EOF",
      "bash /tmp/safe-script.sh <<'EOF'\nrm -rf /etc\nEOF",
      'p=/etc; printf -v p %s ./safe; rm -f "$p"',
      'p=/etc; printf -vp %s ./safe; rm -f "$p"',
      'p=/etc; command printf -v p %s ./safe; rm -f "$p"',
      'p=/etc; builtin unset p; rm -f "$p"',
      "p=/etc; printf '%n' p; rm -f \"$p\"",
      "p=/etc; read -r 'p[0]'; rm -f \"$p\"",
      "p=/etc; printf -v 'p[0]' %s ./safe; rm -f \"$p\"",
      'p=/etc; ((p=0)); rm -f "$p"',
      'p=/etc; let p=0; rm -f "$p"',
      'p=/tmp; p+=/etc; rm -f "$p"',
      'p=/etc; if test -d ./safe; then p=./safe; fi; rm -f "$p"',
      'for p in packages/*; do p=$OTHER; find "$p" -type f; done',
      'cd "$DIR"; rm -f ./safe',
      'printf x > "$OUT"',
      "source ./setup; rm -f ./safe",
      'p=./safe; for n in 1 2; do rm -f "$p/passwd"; printf -vp %s /etc; done',
      'p=./safe; for n in 1 2; do rm -f "$p/passwd"; command printf -vp %s /etc; done',
      String.raw`printf '%s' $'\U00110000'`,
      String.raw`printf '%s' $'\Uffffffff'`,
      String.raw`printf '%s' $'\u002f'`,
      "f() { printf '%s' ':(){ :|:&; }'; }",
      "f() { cat <<'EOF'\n:(){ :|:&; }\nEOF\n}",
      "while true; do cd subdir; printf ok; done",
      "for i in 1 2; do rm -f passwd; cd /etc; break; done",
      "while true; do rm -f passwd; cd /etc; break; done",
      "for i in 1 2; do rm -f passwd; cd /etc; command break; done",
      "for i in 1 2; do continue; cd /etc; rm -f passwd; done",
      "cat <<'EOF' \"$(printf '%s'\n printf safe)\"\ndata\nEOF",
    ])
      assert.equal(kind(command), "unknown", command);
    for (const command of [
      "cat <<EOF\n$(rm -rf /)\nEOF",
      "cat <<EOF\n`rm -rf /`\nEOF",
      'cat <<EOF\n$(printf "%s" ")"; rm -rf /etc)\nEOF',
      'cat <<EOF\n`echo "\\`rm -rf /etc\\`"`\nEOF',
      "cat <<'A' <<'B' > /etc/passwd\nfirst\nA\nsecond\nB",
      "echo ok > /et\\\nc/passwd",
      'echo ok > "/et"\\\nc/passwd',
      "bash -s <<'EOF'\nrm -rf /etc\nEOF",
      "rm > ./out /etc/passwd",
      "cat <<A <<'B'\n$(rm -rf /)\nA\n`shutdown`\nB",
      "cat <<A <<'B'\n`rm -rf /`\nA\necho data\nB",
      "bash <<-'EOF'\nrm -rf /et\\\n\tc\nEOF",
      'p=/etc; echo "$(rm -f "$p/passwd")"',
      "source ./setup; rm -rf /",
      "p=/etc; printf '%s' ok; rm -f \"$p/passwd\"",
      'p=./safe; (p=/etc; rm -f "$p")',
      "(echo ok) > /etc/passwd",
      "for p in a; do echo ok; done > /etc/passwd",
      "for p in $(rm -rf /); do echo ok; done",
      "case x in x) rm -rf /;; esac",
      "find /etc -name $PATTERN -delete",
      "find /tmp -fprintf ./log $FORMAT -fprint /etc/passwd",
      "cd /etc && printf x > passwd",
      "bash -lc 'rm -rf /'",
      String.raw`$'rm\0foo' -rf /etc`,
      String.raw`rm -rf $'/\x00safe'`,
      String.raw`p=$'/\0safe'; rm -rf "$p"`,
      "cat <<EOF\n\\\\$(rm -rf /)\nEOF",
      "cat <<EOF\n\\\\`rm -rf /`\nEOF",
      "unset X; cat <<EOF\n${X:-`rm -rf /`}\nEOF",
      "unset X; cat <<EOF\n${X:-'`rm -rf /`'}\nEOF",
      "cat <<'EOF' \"$(rm -rf /)\"\ndata\nEOF",
      "for i in 1 2; do rm -f passwd; cd /etc; done",
      "while true; do rm -f passwd; cd /etc; done",
      "for i in 1 2; do rm -f passwd; (break); cd /etc; done",
      "for i in 1 2; do rm -f passwd; (continue); cd /etc; done",
      "for i in 1 2; do rm -f passwd; printf ok | break; cd /etc; done",
      'p=./safe; for n in 1 2; do rm -f "$p/passwd"; p=/etc; done',
      "for p in " + "./safe ".repeat(17) + '/etc; do rm -f "$p/passwd"; done',
      "/usr/bin/time -o /etc/passwd /usr/bin/printf ok",
      "/usr/bin/time -o/etc/passwd /usr/bin/printf ok",
      "/usr/bin/time --output=/etc/passwd /usr/bin/printf ok",
      ":(){ :|:& };:",
      "cd /etc; printf safe >2",
    ])
      assert.equal(kind(command), "deny", command);
  },
);

test(
  "分析超限和语法错误属于 unknown，PowerShell 兼容投影仅返回 deny",
  { skip: process.platform === "win32" },
  () => {
    for (const command of [
      "echo 'unterminated",
      `echo '${"a".repeat(65536)}'`,
      Array.from({ length: 1500 }, () => "echo ok").join("; "),
    ]) {
      assert.equal(analyzeHardlineBashCommand(command, "/tmp/fixture").kind, "unknown");
    }
    let nested = "echo ok";
    for (let depth = 0; depth < 9; depth++) nested = `bash -c '${nested.replaceAll("'", "'\\''")}'`;
    assert.equal(analyzeHardlineBashCommand(nested, "/tmp/fixture").kind, "unknown");
    for (const command of [
      "Invoke-Expression $script",
      "Add-Type -TypeDefinition $source",
      "pwsh -EncodedCommand ZQ==",
      "& $Executable",
      "Remove-Item $Target",
    ]) {
      assert.equal(analyzePowerShellHardlineCommand(command).kind, "unknown", command);
      assert.equal(classifyPowerShellHardlineCommand(command), undefined, command);
    }
    for (const command of [
      "Stop-Computer",
      "Format-Volume -DriveLetter C",
      "Remove-Item -Recurse C:\\Windows\\System32",
      "git push --force origin main",
    ]) {
      assert.equal(analyzePowerShellHardlineCommand(command).kind, "deny", command);
      assert.notEqual(classifyPowerShellHardlineCommand(command), undefined, command);
    }
    assert.equal(analyzePowerShellHardlineCommand("Get-ChildItem").kind, "no_match");
  },
);
