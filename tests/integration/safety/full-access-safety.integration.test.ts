import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import {
  analyzeHardlineBashCommand,
  classifyHardlineBashCommand,
  initializeBashParser,
  isHardlineBashCommand,
} from "@pico/runtime/bash-hardline";
import { analyzeHardlineCommand } from "@pico/runtime/approval-policy";
import {
  classifyHardlineCommand,
  isHardlineCommand,
} from "@pico/pico-host/global-approval-manager";
import {
  buildApprovalMiddleware,
  buildForegroundSafetyMiddleware,
} from "@pico/pico-host/agent-runtime";
import { evaluateWorkspaceToolCall } from "@pico/pico-host/workspace-sandbox";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import {
  resolveShell,
  sanitizeShellProcessEnvironment,
  shellCommandArgs,
} from "@pico/runtime/host-shell";

before(async () => {
  if (process.platform !== "win32") await initializeBashParser();
});

test("host shell argv 按方言生成且拒绝不支持的 shell", () => {
  const command = "printf safe";
  const expected = ["--noprofile", "--norc", "-c", command];
  assert.deepEqual(shellCommandArgs("/bin/bash", command), expected);
  assert.deepEqual(shellCommandArgs("C:\\Program Files\\Git\\bin\\bash.exe", command), expected);
  assert.deepEqual(shellCommandArgs("sh", command), expected);

  const powershellCommand = "Get-ChildItem";
  const powershellExpected = ["-NoProfile", "-NonInteractive", "-Command", powershellCommand];
  assert.deepEqual(
    shellCommandArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe", powershellCommand),
    powershellExpected,
  );
  assert.deepEqual(
    shellCommandArgs(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      powershellCommand,
    ),
    powershellExpected,
  );

  const unsupportedShells = ["C:\\Windows\\System32\\cmd.exe", "/bin/zsh", "C:\\tools\\fish.exe"];
  for (const shell of unsupportedShells) {
    assert.throws(
      () => shellCommandArgs(shell, "rd /s /q C:\\Windows\\System32"),
      /不支持的宿主 shell/u,
      shell,
    );
  }
});

// 以下 bash hardline 语义回归依赖宿主为 bash 方言,仅在 POSIX 运行;
// Windows(PowerShell 宿主)的对应行为由 tests/integration/windows/full-access-shell-hardline.test.ts 覆盖。
test(
  "hardline reasonKind 保留脱敏分类，兼容投影只返回明确 deny",
  { skip: process.platform === "win32" },
  () => {
    const cases = [
      ["source ./setup.sh", "source_or_dot", "unknown"],
      ["powershell -Command Get-ChildItem", "opaque_shell", "unknown"],
      ["$PICO_EXECUTABLE --version", "dynamic_executable", "unknown"],
      ["cp ./generated.txt /etc/pico", "protected_destination", "deny"],
      ["printf blocked > /etc/pico", "protected_redirect", "deny"],
      ["git push --force origin main", "destructive_git", "deny"],
      ["shutdown now", "destructive_system", "deny"],
      ["python -c 'import os; os.system(\"rm -rf /\")'", "protected_destination", "deny"],
    ] as const;

    for (const [command, reasonKind, kind] of cases) {
      assert.deepEqual(
        analyzeHardlineBashCommand(command, process.cwd()),
        { kind, reasonKind },
        command,
      );
      assert.equal(
        classifyHardlineBashCommand(command, process.cwd()),
        kind === "deny" ? reasonKind : undefined,
        command,
      );
      assert.equal(isHardlineBashCommand(command, process.cwd()), kind === "deny", command);
      assert.equal(
        classifyHardlineCommand("bash", JSON.stringify({ command }), process.cwd()),
        kind === "deny" ? reasonKind : undefined,
        command,
      );
    }
    assert.equal(classifyHardlineBashCommand("printf safe", process.cwd()), undefined);
    assert.equal(isHardlineBashCommand("printf safe", process.cwd()), false);
  },
);

test(
  "Hardline 按 find 动作检查目标并允许只读循环和解释器打印普通关键词",
  { skip: process.platform === "win32" },
  async () => {
    const workDir = process.cwd();
    const roots = WorkspaceRoots.createSync(workDir);
    const safety = buildForegroundSafetyMiddleware(workDir, { collaborationMode: "agent" }, roots);
    const commands = [
      `for p in packages/*/src apps/desktop/src; do echo "=== $p ==="; find "$p" -maxdepth 2 -type f | sort | sed -n '1,120p'; done`,
      'p=packages/core/src; find "$p" -maxdepth 2 -type f',
      'find -- "./$p" -type f',
      'find "./$(echo src)" -type f',
      'find "./$p" -name "$PATTERN" -print',
      'sudo find "./$p" -type f -print',
      "find /etc -name '-delete' -print",
      "find /etc -exec printf '%s' rm \\;",
      "find . -exec echo -fprint /etc/pico \\;",
      'find "./$p" -fprint ./files.txt',
      "find . -exec printf %s + -fprint /etc/pico \\;",
      "find /etc -fprintf ./files.txt '%p\\n'",
      "find /etc -fls ./files.txt",
      `python -c 'print("shutdown reboot")'`,
      `node -e 'console.log("shutdown reboot")'`,
      `perl -e 'print "shutdown reboot"'`,
      `ruby -e 'puts "shutdown reboot"'`,
    ];
    for (const command of commands) {
      const call = toolCall(command);
      assert.equal(classifyHardlineBashCommand(command, workDir), undefined, command);
      assert.equal(isHardlineBashCommand(command, workDir), false, command);
      assert.equal((await safety(call)).allowed, true, command);
    }
  },
);

test(
  "Hardline 沿嵌套执行和目录上下文区分明确 deny 与 unknown",
  { skip: process.platform === "win32" },
  async () => {
    const workDir = process.cwd();
    const roots = WorkspaceRoots.createSync(workDir);
    const safety = buildForegroundSafetyMiddleware(workDir, { collaborationMode: "agent" }, roots);
    const cases = [
      ['p=-fprint; find "$p" /etc/pico', "protected_destination"],
      ['cd /etc; p=-delete; find "$p"', "protected_destination"],
      ['p=./safe; p=-fprint; find "$p" /etc/pico', "protected_destination"],
      ["find . -maxdepth 0 -exec mv ./safe + /etc \\;", "protected_destination"],
      ["find -- /etc -delete", "protected_destination"],
      ["find /etc -name '-delete' -delete", "protected_destination"],
      ["find . -fprint /etc/pico", "protected_destination"],
      ["find . -fprint0 /etc/pico", "protected_destination"],
      ["find . -fprintf /etc/pico '%p'", "protected_destination"],
      ["find . -fls /etc/pico", "protected_destination"],
      ["find /etc -exec rm -f {} +", "protected_destination"],
      ["find . -exec git push --force origin main \\;", "destructive_git"],
      ["find . -exec shutdown now \\;", "destructive_system"],
      ["cd /etc; printf blocked > ./pico", "protected_redirect"],
      ["env -C / sh -c 'printf blocked > etc/pico'", "protected_redirect"],
      [`python -c 'import os; os.system("rm -rf /")'`, "protected_destination"],
      ["shutdown now", "destructive_system"],
      ["reboot", "destructive_system"],
    ] as const;
    for (const [command, reasonKind] of cases) {
      const call = toolCall(command);
      assert.equal(classifyHardlineBashCommand(command, workDir), reasonKind, command);
      assert.equal(isHardlineBashCommand(command, workDir), true, command);
      assert.equal(classifyHardlineCommand("bash", call.arguments, workDir), reasonKind, command);
      assert.equal((await safety(call)).allowed, false, command);
      assert.equal(evaluateWorkspaceToolCall(call, workDir, roots).allowed, false, command);
    }
    assert.equal(classifyHardlineBashCommand("find -delete", "/"), "protected_destination");
    const unknown = [
      'find "./$p" -delete',
      'find "$(echo -fprint)" /etc/pico',
      'find "`echo -fprint`" /etc/pico',
      'find "$p" /etc/pico; p=./safe',
      'if false; then p=./safe; fi; find "$p" /etc/pico',
      '(p=./safe); find "$p" /etc/pico',
      'p=./safe; printf -v p %s -fprint; find "$p" /etc/pico',
      'find /etc -exec echo {} "$END" -delete',
      "find /etc -exec echo {} $ARGS",
      "find -D $DEBUG_FLAGS .",
      'find . -fprint "$OUTPUT"',
      'find . -type f "$ACTION"',
      "find $p -type f",
      'find "$p" -name $PATTERN',
      "find . -fprintf ./files.txt $FORMAT",
      "find . -exec source ./setup.sh \\;",
      "find . -exec env BASH_ENV=./evil bash -c 'printf safe' \\;",
      "printf target | xargs rm",
      "BASH_ENV=./evil bash -c 'printf safe'",
    ];
    for (const command of unknown) await assertUnknownPermitted(command, workDir);
    assert.equal(
      isHardlineBashCommand('for p in packages/*; do p=-delete; find "$p"; done', workDir),
      false,
    );
  },
);

test(
  "hardline 拒绝按 reasonKind 返回固定脱敏替代提示且不放宽语义",
  { skip: process.platform === "win32" },
  async () => {
    const workDir = process.cwd();
    const roots = WorkspaceRoots.createSync(workDir);
    const safety = buildForegroundSafetyMiddleware(workDir, { collaborationMode: "agent" }, roots);
    const cases = [
      {
        command: "printf blocked > /etc/PICO_REDIRECT_INPUT_CANARY",
        canary: "PICO_REDIRECT_INPUT_CANARY",
        reasonKind: "protected_redirect",
        reason:
          "Hardline 高危命令不可审批绕过,系统直接拒绝。 请改用 write_file/edit_file 在工作区内写入，且不要通过 Bash 重定向写入受保护目标。",
      },
      {
        command: "cp ./artifact /etc/PICO_DESTINATION_INPUT_CANARY",
        canary: "PICO_DESTINATION_INPUT_CANARY",
        reasonKind: "protected_destination",
        reason:
          "Hardline 高危命令不可审批绕过,系统直接拒绝。 请将写入、安装或权限变更目标改为工作区内的本地前缀（例如 ./.local），且不要修改受保护目录。",
      },
    ] as const;

    for (const { command, canary, reasonKind, reason } of cases) {
      const call = toolCall(command);
      assert.equal(classifyHardlineCommand("bash", call.arguments, workDir), reasonKind, command);
      assert.equal(isHardlineCommand("bash", call.arguments, workDir), true, command);

      const decision = await safety(call);
      assert.equal(decision.allowed, false, command);
      assert.equal(decision.reason, reason, command);
      assert.equal(decision.reason?.includes(canary), false, command);
      assert.equal(decision.reason?.includes(command), false, command);
    }

    const safeCall = toolCall("printf safe > ./pico-safe-output");
    assert.equal(classifyHardlineCommand("bash", safeCall.arguments, workDir), undefined);
    assert.equal((await safety(safeCall)).allowed, true);
    await assertUnknownPermitted("$PICO_DYNAMIC_INPUT_CANARY --version", workDir);
  },
);

test(
  "FULL_ACCESS hardline 拒绝受保护目标的 shell 展开与非 -rf 破坏路径",
  { skip: process.platform === "win32" },
  async () => {
    const workDir = process.cwd();
    const dangerous = [
      "rm -rf /etc{,}",
      "rm -rf /u?r",
      "rm -rf /u[s]r",
      "rm -rf /et*",
      'rm -rf "/e"t*',
      "rm -rf {/etc,./tmp}",
      "rm -rf /tmp/../et*",
      "rm -rf ./../etc",
      "rm -rf C:/Temp/../../Wind*",
      "rm -rf /home",
      "rm -rf /Users",
      "rm -rf C:/Users",
      "rm -rf /c/Users",
      "opts=-rf; target=/etc; rm $opts $target",
      "rm --recurs --forc /etc",
      "rm -r ~",
      "rm -r /etc",
      "rm -f ~/.bashrc",
      "rm /etc/passwd",
      "rm /e[t]c/passwd",
      "rm /et{c,}/passwd",
      "rm /private/etc/passwd",
      "rm /private/var/db/index",
      "rm -rf /private/tmp",
      "rm -rf /private/tmp/*",
      "cp ./generated.txt /private/{etc,var}/pico",
      "rm.exe /etc/passwd",
      "find /etc -delete",
      "find /tmp -delete",
      "find /private/tmp -delete",
      "find ./../etc -delete",
      "find /et* -delete",
      "sudo find /etc -delete",
      "find /etc -exec rm -f {} +",
      "find /tmp -exec rm -f {} +",
      "find / -exec rm {} +",
      "find /et* -exec shred {} +",
      "find /etc -execdir truncate -s 0 {} +",
      "find /etc -exec mv {} /tmp/pico-backup +",
      "find /etc -exec sudo -u root rm -f {} +",
      "find /etc -exec env LC_ALL=C unlink {} +",
      "find /etc -exec chmod 000 {} +",
      "find /etc -exec chown root {} +",
      "find /etc -exec cp ./generated.txt {} +",
      "find /etc -exec sed -i -e 's/root/disabled/' {} +",
      "find /etc -exec tee {} +",
      "find /etc -exec dd if=/dev/zero of={} +",
      "find /etc -exec install ./generated.txt {} +",
      "find /etc -exec ln -s ./generated.txt {} +",
      "find /dev -exec wipefs --all {} +",
      "find /etc -exec sudo OWNER=root chmod 000 {} +",
      "find /etc -execdir sed -i 's/root/disabled/' ./relative \\;",
      "find /etc -execdir cp /tmp/pico-source ./relative \\;",
      "find . -exec cp /tmp/pico-source /etc/passwd \\;",
      "mkfs.ext4 -F /dev/sda",
      "mkfs -t ext4 /dev/sda",
      "mkfs.ext4 /d?v/sda",
      "mkfs.ext4 /de[v]/sda",
      "mkfs.ext4 /de{v,ad}/sda",
      "sudo mkfs.xfs -f /dev/sdb",
      "mkfs.ext4 -F /etc/passwd",
      "mke2fs /dev/sda",
      "newfs_apfs /dev/disk0",
      "dd of=/dev/sda if=/dev/zero",
      "dd if=/dev/zero status=progress of=/dev/sda",
      "dd if=/dev/zero of=/d?v/sda",
      "sudo dd if=/dev/zero of=/dev/disk0",
      "dd if=/dev/zero of=/etc/passwd",
      "dd if=/dev/zero > /dev/sda",
      "dd.exe if=/dev/zero of=/dev/sda",
      "git push origin main --force",
      "git push --force origin main",
      "git push origin +HEAD:main",
      "git -C . push --force origin main",
      "sudo git -C . push origin +HEAD:main",
      "FORCE=--force; git push origin main $FORCE",
      "git push --force-with-lease origin main",
      'cmd=git; "$cmd" push --force origin main',
      "git push origin --delete main",
      "git push origin -d main",
      "git push origin :main",
      "git push --mirror origin",
      "git push --prune origin",
      "git push --del origin main",
      "git push --mir origin",
      "git push --pru origin",
      "git.exe push --force origin main",
      'cmd=git-push; "$cmd" --force origin main',
      "shutdown -h now",
      "sudo poweroff",
      "reboot",
      "halt",
      "systemctl reboot",
      "systemctl start reboot.target",
      "systemctl isolate poweroff.target",
      "loginctl poweroff",
      "wipefs --all /dev/sda",
      "wipefs --al /dev/sda",
      "wipefs -o 0 /dev/sda",
      "chmod -R 000 /etc",
      "chmod 000 /etc/passwd",
      "chown -R root:root /home",
      "chgrp wheel /etc/passwd",
      "truncate -s 0 /etc/passwd",
      "truncate.exe --size=0 C:/Windows/System32/config/system",
      "unlink /etc/passwd",
      "rmdir /etc/ssh",
      "shred -n 1 /etc/passwd",
      "cp ./generated.txt /etc/passwd",
      "cp -t /etc ./generated.txt",
      "cp --target-direct=/etc ./generated.txt",
      "cp -s /etc/passwd ./pico-link && printf x > ./pico-link",
      "cp --link /etc/passwd ./pico-link && printf x > ./pico-link",
      "cp -a /etc/localtime ./pico-link && printf x > ./pico-link",
      "cp -P /etc/localtime ./pico-link && printf x > ./pico-link",
      "cp -d /etc/localtime ./pico-link && printf x > ./pico-link",
      "cp --archive /etc/localtime ./pico-link && printf x > ./pico-link",
      "cp --no-dereference /etc/localtime ./pico-link && printf x > ./pico-link",
      "sudo cp ./generated.txt /etc/passwd",
      "mv /etc/hosts ./backup",
      "mv ./generated.txt /etc/generated.txt",
      "mv --target-direct=/etc ./generated.txt",
      "install ./generated.txt /etc/generated.txt",
      "install -d /etc/pico",
      "install --director /etc/pico",
      "install -dm755 /etc/pico",
      "install --strip ./generated.txt /etc/generated.txt",
      "tee /etc/passwd",
      "sed -i 's/root/disabled/' /etc/passwd",
      "sed --in-plac 's/root/disabled/' /etc/passwd",
      "opts=-i; sed $opts 's/root/disabled/' /etc/passwd",
      "ln -s ./generated.txt /etc/pico-link",
      "ln --target-direct=/etc ./generated.txt",
      "ln -sf /etc/passwd ./pico-link && printf x > ./pico-link",
      "ln /etc/passwd ./pico-link && printf x > ./pico-link",
      "env -C /etc rm passwd",
      "env --chdir=/etc truncate -s 0 passwd",
      "sudo -D /etc rm -f passwd",
      "sudo --chdir=/etc sed -i 's/root/disabled/' passwd",
      "sudo -R / rm -f etc/passwd",
      "chroot / rm -f etc/passwd",
      "cd /etc && rm -f passwd",
      "cd /etc && (cd /tmp); rm -f passwd",
      "cd /etc && cd /tmp | true; rm -f passwd",
      "cd /etc; cd /tmp & wait; rm -f passwd",
      "cd /etc && false && cd /tmp; rm -f passwd",
      "cd /etc; (cd /tmp); (rm -f passwd)",
      "(cd /etc; rm -f passwd)",
      "{ cd /etc; rm -f passwd; } | true",
      "builtin cd /etc && rm -f passwd",
      "command cd /etc && truncate -s 0 passwd",
      "cd /etc; cd /definitely-pico-missing; rm -f passwd",
      "cd /etc; pushd /definitely-pico-missing; rm -f passwd",
      "cd /tmp; time cd /etc; rm -f passwd",
      "cd /tmp; time -p cd /etc; rm -f passwd",
      "time cd /etc; rm -f passwd",
      "time -p cd /etc; rm -f passwd",
      "cd /etc; truncate -s 0 passwd",
      "(cd /etc && unlink passwd)",
      "cd / && cp /tmp/pico-source etc/passwd",
      "cd /etc && sh -c 'rm -f passwd'",
      "cd /etc && echo $(rm -f passwd)",
      "cd /etc && echo `truncate -s 0 passwd`",
      "cd /etc && find . -delete",
      ": > /etc/passwd",
      "> /dev/sda",
      "printf x >/etc/passwd",
      "printf x >> /etc/passwd",
      "printf x >|/etc/passwd",
      "printf x &>/etc/passwd",
      "printf x >/tmp/pico.log>/etc/passwd",
      "cd /etc && printf x > passwd",
      "(cd /etc; : > passwd)",
      "printf '/etc/passwd\\0' | xargs -0 rm -f /etc/passwd",
    ];
    // 未绑定的 argv、目标、stdin、启动文件与脚本只返回 unknown。
    // official grammar 未支持的 extglob 必须返回 unknown，不以手写扫描补 deny。
    const unknown = [
      // case 分支状态尚未建模；后续相对路径的 cwd 必须保持 unknown。
      "cd /etc; case x in y) cd /tmp;; esac; rm -f passwd",
      "shopt -s extglob; rm /@(etc)/passwd",
      "rm /private/e@(tc)/passwd",
      "shopt -s extglob; find /@(etc) -delete",
      "shopt -s extglob; chmod 000 /@(etc)/passwd",
      "shopt -s extglob; printf x > /@(etc)/passwd",
      "printf x > /private/v@(ar)/pico",
      'set -- -rf /etc; rm "$@"',
      'find "$HOME" -delete',
      'find "$ROOT" -delete',
      "find -files0-from targets.txt -delete",
      "find -files0-from - -delete",
      'find "$ROOT" -exec unlink {} \\;',
      'find /etc -okdir "$DELETE_CMD" {} +',
      "git push origin main $(printf -- --force)",
      "$(printf git) push --force origin main",
      "env -S 'git push --force origin main'",
      "env --split-string='git push --force origin main'",
      "sudo env -S 'git push --force origin main'",
      "cp $ARGS",
      "install $ARGS",
      "ln $ARGS",
      "printf '/etc/passwd\\0' | xargs -0 rm -f",
      "printf '/etc/passwd\\0' | xargs -0 unlink",
      "printf '/etc/passwd\\0' | xargs -0 truncate -s 0",
      "printf '/etc/passwd\\0' | xargs -0 chmod 000",
      "printf '/etc/passwd\\0' | xargs -0 chown root",
      "printf '/etc/passwd\\0' | xargs -0 sed -i 's/root/disabled/'",
      "printf '/etc/passwd\\0' | xargs -0 tee",
      "printf '/etc/passwd\\0' | xargs -0 shred",
      "printf '/etc/passwd\\0' | xargs -0 cp ./generated.txt",
      "printf '/etc/passwd\\0' | xargs -0 mv ./generated.txt",
      "printf '/etc/passwd\\0' | xargs -0 install ./generated.txt",
      "printf '/etc/passwd\\0' | xargs -0 ln -s ./generated.txt",
      "printf 'of=/etc/passwd\\0' | xargs -0 dd if=/dev/zero",
      "printf '/dev/sda\\0' | xargs -0 wipefs --all",
      "find /etc -print0 | xargs -0 rm -f",
      "find /etc -print0 | xargs -0 chmod 000",
      "printf '/etc/passwd\\n' | xargs --replace rm -f {}",
      "printf '/etc/passwd\\n' | xargs --eof rm -f",
      "printf '/etc/passwd\\n' | xargs --max-lines rm -f",
      "printf '/etc/passwd\\n' | xargs --max-args rm -f",
      "printf '/etc/passwd\\n' | xargs --max-procs rm -f",
      "printf '/etc/passwd\\n' | xargs -R 1 rm -f",
      "printf '/etc/passwd\\n' | xargs -S 255 rm -f",
      "printf '/etc/passwd\\n' | xargs --process-slot-var SLOT rm -f",
      'cd "$TARGET"; rm -f passwd',
      "if true; then cd /tmp; fi; rm -f passwd",
      "eval 'cd /etc'; unlink passwd",
      "eval 'cd /etc && false && cd /tmp'; rm -f passwd",
      "eval 'cd /etc; if false; then cd /tmp; fi'; rm -f passwd",
      "cd > ./pico.log; rm -f .bashrc",
      "pushd +1; rm -f passwd",
      'printf x > "$TARGET"',
    ];
    for (const command of unknown) await assertUnknownPermitted(command, workDir);
    for (const command of ["false && cd /tmp; rm -f passwd"])
      assert.equal(analyzeHardlineBashCommand(command, workDir).kind, "no_match", command);

    for (const command of dangerous) {
      assert.equal(analyzeHardlineBashCommand(command, workDir).kind, "deny", command);
      assert.equal(isHardlineBashCommand(command, workDir), true, command);
    }

    const ordinary = [
      "rm -rf ./dist*",
      "rm -rf packages/{generated,cache}",
      'rm -rf "/et*"',
      "rm -rf /et\\*",
      "rm -rf /tmp/pico-*",
      "rm -r ./dist",
      "rm -f ./config.json",
      "rm ./generated.txt",
      "rm /tmp/pico-*",
      "rm /private/tmp/pico-*",
      "shopt -s extglob; rm /tmp/@(pico-a|pico-b)",
      "rm '/e[t]c/passwd'",
      "find . -delete",
      "find /tmp/pico-cache -delete",
      "find /tmp/pico-cache -exec rm -f {} +",
      "find /Users/alice/project -delete",
      'find . -name "$PATTERN" -delete',
      "find . -exec rm ./tmp {} +",
      "find /etc -exec echo rm {} +",
      "find /etc -exec sudo echo rm {} +",
      "find /etc -exec cp {} ./backup +",
      "find /etc -exec install {} ./backup +",
      "find /etc -exec sed -n '1p' {} +",
      "find /etc -exec dd if={} of=./backup +",
      "find /etc -exec chmod 644 ./generated.txt +",
      "find /etc -exec rm ./generated.txt +",
      "shopt -s extglob; find /tmp/@(pico-a|pico-b) -delete",
      "mkfs.ext4 ./disk.img",
      "dd if=/dev/zero of=./disk.img",
      "wipefs /dev/sda",
      "wipefs --output TYPE /dev/sda",
      "wipefs --all ./disk.img",
      "chmod 644 ./generated.txt",
      "shopt -s extglob; chmod 644 /tmp/@(pico-a|pico-b)",
      "chown user:group ./generated.txt",
      "truncate -s 0 ./generated.txt",
      "truncate --reference /etc/passwd ./generated.txt",
      'truncate --reference "$REFERENCE" ./generated.txt',
      "truncate -s 0 /private/tmp/pico-file",
      "unlink ./generated.txt",
      "rmdir ./generated-dir",
      "shred -n 1 ./generated.txt",
      "shred --random-source /etc/urandom ./generated.txt",
      "cp /etc/hosts ./backup",
      "cp -L /etc/localtime ./backup",
      'cp -- "$SOURCE" ./backup',
      'cp -S "$SUFFIX" /etc/hosts ./backup',
      "cp.exe /etc/hosts ./backup",
      "sudo cp /etc/hosts ./backup",
      "mv ./generated.txt ./backup",
      "install /etc/hosts ./backup",
      "install -m 644 /etc/hosts ./backup",
      "tee ./generated.txt",
      "sed -n '1p' /etc/passwd",
      'sed "$SCRIPT" ./generated.txt',
      "sed -i -e '/etc/p' ./generated.txt",
      "sed -i -f /etc/pico.sed ./generated.txt",
      "ln -s ./generated.txt ./hosts-link",
      "printf 'pico\\0' | xargs -0 echo",
      "printf 'pico\\0' | xargs -0 cat",
      "env -C /tmp rm pico-file",
      "env -C ./tmp rm pico-file",
      "sudo -D /tmp truncate -s 0 pico-file",
      "chroot /tmp/pico-root rm etc/passwd",
      "cd /etc; echo passwd",
      "cd /etc; rm -f /tmp/pico-file",
      "cd /tmp && rm -f pico-file",
      "cd ./subdir && rm -f generated",
      "cd /tmp && cp /etc/hosts backup",
      "cd /tmp && printf x > pico-file",
      "{ cd /tmp; }; rm -f pico-file",
      "(cd /etc); rm -f ./generated.txt",
      "cd /tmp | true",
      "cd /tmp & wait",
      "{ cd /tmp; } | true",
      "eval 'printf ok'; rm -f ./generated.txt",
      ": > ./generated.txt",
      "printf x >/tmp/pico.log",
      "printf x >|/tmp/pico.log",
      "printf x > '/@(etc)/passwd'",
      "printf x 2>&1",
      "echo '>' /etc/passwd",
      "echo reboot shutdown poweroff halt",
      "echo.exe /etc/passwd",
      "systemctl status",
      "systemctl start multi-user.target",
      "git push origin main",
      "git -C . push origin feature",
      "git.exe push origin main",
      "env git push origin main",
      'printf "%s\\n" "mkfs.ext4 -F /dev/sda"',
      'printf "%s\\n" "dd of=/dev/sda if=/dev/zero"',
      'printf "%s\\n" "git push origin main --force"',
    ];

    for (const command of ordinary) {
      assert.equal(isHardlineBashCommand(command, workDir), false, command);
    }

    assert.equal(isHardlineBashCommand("rm -f etc/passwd", "/"), true);
    assert.equal(isHardlineBashCommand("rm -f Windows/System32/config/system", "C:/"), true);
    assert.equal(analyzeHardlineBashCommand("rm -f ./generated.txt").kind, "unknown");
    assert.equal(isHardlineBashCommand("rm -f ./generated.txt"), false);
  },
);

test(
  "FULL_ACCESS hardline 覆盖 rm 等价参数、系统目标与 shell 组合",
  { skip: process.platform === "win32" },
  async () => {
    const workDir = process.cwd();
    const dangerous = [
      "rm -rf -- /",
      "rm --force --recursive /",
      "rm --recursive --force -- '/etc/ssh'",
      "rm -R -f '~'",
      'printf ok && "rm" "-fr" "/usr"',
      "echo ok; /bin/rm --recursive --force /boot",
      "bash -c 'rm --force --recursive -- /'",
      "echo $(rm -rf /)",
      "rm $FLAGS /",
      "rm $(printf %s -rf) /",
      "exec rm -rf /",
      "busybox rm --force --recursive /etc",
      "sudo bash -lc 'rm --force --recursive /'",
      "zsh -ocorrect -c 'rm -rf /'",
      "zsh -focorrect -c 'rm -rf /'",
      "bash -c -o noglob 'rm -rf /'",
      "bash -c -O extglob 'rm -rf /'",
      "bash -c +n 'rm -rf /'",
      "bash -c -n +n 'rm -rf /'",
      "bash -c -- 'rm -rf /'",
      "bash -c - 'rm -rf /'",
      "bash -n +n -c 'rm -rf /'",
      "bash -o noexec +o noexec -c 'rm -rf /'",
      "env -iC / bash -c 'rm -f etc/passwd'",
      `python3 -c "import os; os.system('rm -rf /')"`,
      `python3 -W ignore -c "import os; os.system('rm -rf /')"`,
      `python3 -X dev -c "import os; os.system('rm -rf /')"`,
      `python3.14t -W ignore -c "import os; os.system('rm -rf /')"`,
      `python3 -qW ignore -c "import os; os.system('rm -rf /')"`,
      `python3 --check-hash-based-pycs default -c "import os; os.system('rm -rf /')"`,
      `node -e "require('node:child_process').execSync('rm -rf /')"`,
      `node --title pico -e "require('node:child_process').execSync('rm -rf /')"`,
      `node -r ./bootstrap.js -e "require('node:child_process').execSync('rm -rf /')"`,
      `node --conditions development -e "require('node:child_process').execSync('rm -rf /')"`,
      `node --input-type module -e "require('node:child_process').execSync('rm -rf /')"`,
      `node --inspect-port 0 -e "require('node:child_process').execSync('rm -rf /')"`,
      `perl -e "system('rm -rf /')"`,
      `perl -I ./lib -e "system('rm -rf /')"`,
      `perl -wI ./lib -e "system('rm -rf /')"`,
      `ruby -e "system('rm -rf /')"`,
      `ruby -I ./lib -e "system('rm -rf /')"`,
      `ruby3.1 -I ./lib -e "system('rm -rf /')"`,
      `ruby -wI ./lib -e "system('rm -rf /')"`,
      "{ rm -rf /; }",
      "(rm -rf /)",
      "if true; then rm -rf /; fi",
      "! rm -rf /",
      "while true; do rm -rf /; done",
      "until false; do rm -rf /; done",
      "if false; then :; elif true; then rm -rf /; fi",
      "if false; then :; else rm -rf /; fi",
      "case x in x) rm -rf /;; esac",
      "coproc rm -rf /",
      "rm -rf /Users/alice/*",
      "rm -rf /home/alice/{*,.*}",
      "rm -rf C:/Users/Alice/*",
      "rm -rf /c/Users/Alice/{*,.*}",
    ];
    // 未绑定的 argv、目标、stdin、启动文件与脚本只返回 unknown。
    const unknown = [
      'rm "--force" "--recursive" "$HOME"',
      "/bin/[b]ash -c 'rm -rf /'",
      "bash --rcfile ./evil -ic 'printf safe'",
      "bash --init-file ./evil -ic 'printf safe'",
      "HOME=./home bash --noprofile -ci 'printf safe'",
      "bash -cl 'printf safe'",
      "HOME=./home bash --noprofile -c -i 'printf safe'",
      "bash --noprofile -c -l 'printf safe'",
      "bash -c -o",
      "bash -c -O",
      "bash -c --",
      "bash -c -",
      "BASH_ENV=./evil bash -c 'printf safe'",
      "env BASH_ENV=./evil bash -c 'printf safe'",
      "export BASH_ENV=./evil; bash -c 'printf safe'",
      "eval 'export BASH_ENV=./evil'; bash -c 'printf safe'",
      "ENV=./evil sh -c 'printf safe'",
      "ZDOTDIR=./zdot zsh -c 'printf safe'",
      "HOME=./home bash --noprofile -ic 'printf safe'",
      "env 'BASH_FUNC_pico%%=() { printf marker; }' bash -c pico",
      "printf '%s\\n' 'rm -rf /' | sh",
      "printf '%s\\n' 'rm -rf /' | bash -s",
      "printf '%s\\n' 'rm -rf /' | ash",
      "sh ./destructive-script.sh",
      "ash ./destructive-script.sh",
      "sh ./destructive-script.sh -c 'printf safe'",
      "bash -s",
      "source ./destructive-script.sh",
      ". ./destructive-script.sh",
      "env sh ./destructive-script.sh",
      "busybox sh ./destructive-script.sh",
      "busybox ash ./destructive-script.sh",
      "command sh ./destructive-script.sh",
      "timeout 1 sh ./destructive-script.sh",
      "stdbuf -oL sh ./destructive-script.sh",
      "ionice -c2 sh ./destructive-script.sh",
      "printf '%s\\n' 'rm -rf /' | stdbuf -oL sh",
      "printf '%s\\n' 'rm -rf /' | ionice -c2 sh",
      "csh ./destructive-script.csh",
      "tcsh ./destructive-script.csh",
      "fish ./destructive-script.fish",
      "pwsh -File ./destructive-script.ps1",
      "powershell.exe -File ./destructive-script.ps1",
      "cmd.exe /d /s /c destructive-script.cmd",
      "env pwsh -Command 'Write-Output safe'",
      'rm -rf "$UNKNOWN_TARGET"',
      "rm -rf '/etc",
    ];
    for (const command of unknown) await assertUnknownPermitted(command, workDir);

    for (const command of dangerous) {
      assert.equal(
        analyzeHardlineCommand("bash", bashArgs(command), workDir).kind,
        "deny",
        command,
      );
      assert.equal(isHardlineCommand("bash", bashArgs(command), workDir), true, command);
    }

    const ordinaryWorkspaceDeletes = [
      "rm -rf ./dist",
      "rm --recursive --force -- './tmp/cache'",
      "rm -R -f packages/generated",
      "rm -rf /tmp/pico-cache",
      "rm -rf /Users/alice/project/dist",
      "rm -rf /home/alice/project/dist",
      "rm -rf C:/Users/Alice/project/dist",
      `rm --recursive --force -- ${JSON.stringify(`${workDir}/tmp/generated`)}`,
      "printf '%s\\n' 'rm -rf /'",
      "bash --version",
      "command -v sh",
      "command -V sh",
      "sh -c 'printf ok'",
      "ash -c 'printf ok'",
      "busybox ash -c 'printf ok'",
      "ash --version",
      "pwsh --version",
      "zsh -ocorrect -c 'printf ok'",
      "zsh -focorrect -c 'printf ok'",
      "bash -c 'printf ok' --rcfile ./script-argument",
      "BASH_ENV=./evil printf safe",
      "env BASH_ENV=./evil printf safe",
      "time -f BASH_ENV=./evil bash -c 'printf ok'",
      "env bash -c 'printf ok'",
      "env -iC /tmp sh -c 'printf ok'",
      "timeout 1 sh -c 'printf ok'",
      "stdbuf -oL sh -c 'printf ok'",
      "stdbuf -oeL sh -c 'printf ok'",
      "ionice -c2 ash -c 'printf ok'",
      "ionice -tc2 ash -c 'printf ok'",
      "printf 'printf marker\\n' | bash -n",
      "bash -n -c 'rm -rf /'",
      "bash -cn 'rm -rf /'",
      "bash -c -n 'rm -rf /'",
      "bash -c -o noexec 'rm -rf /'",
      `python3 -c "print('rm -rf ./dist')"`,
      `python3 ./ordinary.py -c "rm -rf /"`,
      `python3 -W ignore ./ordinary.py -c "rm -rf /"`,
      `node ./ordinary.js -e "rm -rf /"`,
      `node --title pico ./ordinary.js -e "rm -rf /"`,
      `perl -I ./lib ./ordinary.pl -e "rm -rf /"`,
      `ruby3.1 -I ./lib ./ordinary.rb -e "rm -rf /"`,
      '"then" rm -rf /',
      'echo "(rm -rf /)"',
    ];
    for (const command of ordinaryWorkspaceDeletes) {
      assert.equal(isHardlineCommand("bash", bashArgs(command), workDir), false, command);
    }

    assert.equal(isHardlineCommand("write_file", bashArgs("rm -rf /")), false);

    const roots = WorkspaceRoots.createSync(workDir);
    const hardlineCall = toolCall("rm --recursive --force -- /");
    const ordinaryCall = toolCall("rm --recursive --force -- ./dist");
    const sandboxDecision = evaluateWorkspaceToolCall(hardlineCall, workDir, roots);
    assert.equal(sandboxDecision.allowed, false);
    assert.match(sandboxDecision.reason ?? "", /Hardline/u);
    assert.equal(evaluateWorkspaceToolCall(ordinaryCall, workDir, roots).allowed, true);

    const relativeSystemCall = toolCall("rm -f etc/passwd");
    assert.equal(evaluateWorkspaceToolCall(relativeSystemCall, "/", roots).allowed, false);
    assert.equal(analyzeHardlineCommand("bash", ordinaryCall.arguments).kind, "unknown");
    assert.equal(isHardlineCommand("bash", ordinaryCall.arguments), false);

    const foregroundSafety = buildForegroundSafetyMiddleware(
      workDir,
      { collaborationMode: "agent" },
      roots,
    );
    assert.equal((await foregroundSafety(hardlineCall)).allowed, false);
    assert.equal((await foregroundSafety(ordinaryCall)).allowed, true);
    const rootForegroundSafety = buildForegroundSafetyMiddleware(
      "/",
      { collaborationMode: "agent" },
      roots,
    );
    assert.equal((await rootForegroundSafety(relativeSystemCall)).allowed, false);
  },
);

test(
  "FULL_ACCESS hardline 不把隐藏工作区误判为整个用户目录通配目标",
  { skip: process.platform === "win32" },
  () => {
    const hiddenWorkspace = "/Users/alice/.pico/temporary-workspace";
    const ordinaryWorkspaceMutations = [
      "rm pico-smoke.txt",
      "rm ./.hidden-result",
      "mv pico-smoke.txt ./.local/trash/",
    ];
    for (const command of ordinaryWorkspaceMutations) {
      assert.equal(isHardlineBashCommand(command, hiddenWorkspace), false, command);
    }

    const wholeProfileGlobs = [
      "rm -rf /Users/alice/*",
      "rm -rf /Users/alice/.*",
      "rm -rf /Users/alice/?*",
      "rm -rf /Users/alice/[a-z]*",
      "rm -rf /Users/alice/{*,.*}",
    ];
    for (const command of wholeProfileGlobs) {
      assert.equal(isHardlineBashCommand(command, hiddenWorkspace), true, command);
    }
  },
);

test(
  "FULL_ACCESS 对无法绑定的 POSIX Shell stdin 执行入口按 unknown 放行",
  { skip: process.platform === "win32" },
  async () => {
    const script = "printf 'stdin-shell-ran\\n'\n";
    const execution = spawnSync("/bin/sh", [], { encoding: "utf8", input: script });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "stdin-shell-ran\n");

    const visibleInvocation = `printf '%s' ${JSON.stringify(script)} | sh`;
    await assertUnknownPermitted(visibleInvocation, process.cwd());
  },
);

test(
  "Bash host shell ignores ambient profile and exported-function code",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-shell-startup-safety-"));
    const home = join(root, "home");
    const profileMarker = join(root, "profile-marker");
    const environmentMarker = join(root, "environment-marker");
    const functionMarker = join(root, "function-marker");
    const startupScript = join(root, "startup.sh");
    await mkdir(home);
    context.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(home, ".bash_profile"),
      `printf profile > ${JSON.stringify(profileMarker)}\n`,
    );
    await writeFile(startupScript, `printf environment > ${JSON.stringify(environmentMarker)}\n`);

    const environment = sanitizeShellProcessEnvironment({
      ...process.env,
      HOME: home,
      BASH_ENV: startupScript,
      ENV: startupScript,
      "BASH_FUNC_pico_startup_probe%%": `() { printf function > ${JSON.stringify(
        functionMarker,
      )}; }`,
    });
    const shell = resolveShell();
    const execution = spawnSync(
      shell,
      shellCommandArgs(shell, "pico_startup_probe || printf fallback"),
      { cwd: root, encoding: "utf8", env: environment },
    );

    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "fallback");
    await assert.rejects(access(profileMarker));
    await assert.rejects(access(environmentMarker));
    await assert.rejects(access(functionMarker));
  },
);

function bashArgs(command: string): string {
  return JSON.stringify({ command });
}

function toolCall(command: string) {
  return { id: command, name: "bash", arguments: bashArgs(command) };
}

/** 只检查真实权限链；这些不确定或高风险示例绝不派发到 Shell。 */
async function assertUnknownPermitted(command: string, workDir: string): Promise<void> {
  const call = toolCall(command);
  assert.equal(analyzeHardlineBashCommand(command, workDir).kind, "unknown", command);
  assert.equal(analyzeHardlineCommand("bash", call.arguments, workDir).kind, "unknown", command);
  assert.equal(classifyHardlineBashCommand(command, workDir), undefined, command);
  assert.equal(isHardlineBashCommand(command, workDir), false, command);
  assert.equal(classifyHardlineCommand("bash", call.arguments, workDir), undefined, command);
  assert.equal(isHardlineCommand("bash", call.arguments, workDir), false, command);
  const permission = buildApprovalMiddleware(
    () => assert.fail("FULL_ACCESS unknown 不得发起人工审批"),
    workDir,
    undefined,
    undefined,
    {
      sessionId: "full-access-unknown-regression",
      collaborationMode: "agent",
      permissionMode: "full-access",
    },
    WorkspaceRoots.createSync(workDir),
  );
  assert.equal((await permission(call)).allowed, true, command);
}
