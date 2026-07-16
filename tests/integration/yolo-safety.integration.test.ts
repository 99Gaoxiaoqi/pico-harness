import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isHardlineBashCommand } from "../../src/approval/bash-hardline.js";
import { isHardlineCommand } from "../../src/approval/manager.js";
import { buildForegroundSafetyMiddleware } from "../../src/runtime/agent-runtime.js";
import { evaluateYoloToolCall } from "../../src/safety/yolo-sandbox.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";
import {
  resolveShell,
  sanitizeShellProcessEnvironment,
  shellCommandArgs,
} from "../../src/os/shell.js";

test("YOLO hardline 拒绝受保护目标的 shell 展开与非 -rf 破坏路径", () => {
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
    'set -- -rf /etc; rm "$@"',
    "opts=-rf; target=/etc; rm $opts $target",
    "rm --recurs --forc /etc",
    "rm -r ~",
    "rm -r /etc",
    "rm -f ~/.bashrc",
    "rm /etc/passwd",
    "rm /e[t]c/passwd",
    "rm /et{c,}/passwd",
    "shopt -s extglob; rm /@(etc)/passwd",
    "rm /private/etc/passwd",
    "rm /private/var/db/index",
    "rm -rf /private/tmp",
    "rm -rf /private/tmp/*",
    "rm /private/e@(tc)/passwd",
    "cp ./generated.txt /private/{etc,var}/pico",
    "rm.exe /etc/passwd",
    'find "$HOME" -delete',
    "find /etc -delete",
    "find /tmp -delete",
    "find /private/tmp -delete",
    "find ./../etc -delete",
    'find "$ROOT" -delete',
    "find /et* -delete",
    "sudo find /etc -delete",
    "find -files0-from targets.txt -delete",
    "find -files0-from - -delete",
    "find /etc -exec rm -f {} +",
    "find /tmp -exec rm -f {} +",
    "find / -exec rm {} +",
    'find "$ROOT" -exec unlink {} \\;',
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
    'find /etc -okdir "$DELETE_CMD" {} +',
    "shopt -s extglob; find /@(etc) -delete",
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
    "git push origin main $(printf -- --force)",
    "git push --force-with-lease origin main",
    'cmd=git; "$cmd" push --force origin main',
    "$(printf git) push --force origin main",
    "env -S 'git push --force origin main'",
    "env --split-string='git push --force origin main'",
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
    "sudo env -S 'git push --force origin main'",
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
    "shopt -s extglob; chmod 000 /@(etc)/passwd",
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
    "cp $ARGS",
    "sudo cp ./generated.txt /etc/passwd",
    "mv /etc/hosts ./backup",
    "mv ./generated.txt /etc/generated.txt",
    "mv --target-direct=/etc ./generated.txt",
    "install ./generated.txt /etc/generated.txt",
    "install -d /etc/pico",
    "install --director /etc/pico",
    "install -dm755 /etc/pico",
    "install --strip ./generated.txt /etc/generated.txt",
    "install $ARGS",
    "tee /etc/passwd",
    "sed -i 's/root/disabled/' /etc/passwd",
    "sed --in-plac 's/root/disabled/' /etc/passwd",
    "opts=-i; sed $opts 's/root/disabled/' /etc/passwd",
    "ln -s ./generated.txt /etc/pico-link",
    "ln --target-direct=/etc ./generated.txt",
    "ln -sf /etc/passwd ./pico-link && printf x > ./pico-link",
    "ln /etc/passwd ./pico-link && printf x > ./pico-link",
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
    "false && cd /tmp; rm -f passwd",
    'cd "$TARGET"; rm -f passwd',
    "if true; then cd /tmp; fi; rm -f passwd",
    "cd /etc; (cd /tmp); (rm -f passwd)",
    "(cd /etc; rm -f passwd)",
    "{ cd /etc; rm -f passwd; } | true",
    "builtin cd /etc && rm -f passwd",
    "command cd /etc && truncate -s 0 passwd",
    "eval 'cd /etc'; unlink passwd",
    "eval 'cd /etc && false && cd /tmp'; rm -f passwd",
    "eval 'cd /etc; if false; then cd /tmp; fi'; rm -f passwd",
    "cd /etc; cd /definitely-pico-missing; rm -f passwd",
    "cd /etc; pushd /definitely-pico-missing; rm -f passwd",
    "cd /etc; case x in y) cd /tmp;; esac; rm -f passwd",
    "cd /tmp; time cd /etc; rm -f passwd",
    "cd /tmp; time -p cd /etc; rm -f passwd",
    "time cd /etc; rm -f passwd",
    "time -p cd /etc; rm -f passwd",
    "cd > ./pico.log; rm -f .bashrc",
    "pushd +1; rm -f passwd",
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
    'printf x > "$TARGET"',
    "shopt -s extglob; printf x > /@(etc)/passwd",
    "printf x > /private/v@(ar)/pico",
    "cd /etc && printf x > passwd",
    "(cd /etc; : > passwd)",
  ];

  for (const command of dangerous) {
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
  assert.equal(isHardlineBashCommand("rm -f ./generated.txt"), true);
});

test("YOLO hardline 覆盖 rm 等价参数、系统目标与 shell 组合", async () => {
  const workDir = process.cwd();
  const dangerous = [
    "rm -rf -- /",
    "rm --force --recursive /",
    "rm --recursive --force -- '/etc/ssh'",
    'rm "--force" "--recursive" "$HOME"',
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
    "/bin/[b]ash -c 'rm -rf /'",
    "zsh -ocorrect -c 'rm -rf /'",
    "zsh -focorrect -c 'rm -rf /'",
    "bash --rcfile ./evil -ic 'printf safe'",
    "bash --init-file ./evil -ic 'printf safe'",
    "HOME=./home bash --noprofile -ci 'printf safe'",
    "bash -cl 'printf safe'",
    "bash -n +n -c 'rm -rf /'",
    "bash -o noexec +o noexec -c 'rm -rf /'",
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
    "env -iC / bash -c 'rm -f etc/passwd'",
    "printf '%s\\n' 'rm -rf /' | stdbuf -oL sh",
    "printf '%s\\n' 'rm -rf /' | ionice -c2 sh",
    "csh ./destructive-script.csh",
    "tcsh ./destructive-script.csh",
    "fish ./destructive-script.fish",
    "pwsh -File ./destructive-script.ps1",
    "powershell.exe -File ./destructive-script.ps1",
    "cmd.exe /d /s /c destructive-script.cmd",
    "env pwsh -Command 'Write-Output safe'",
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
    'rm -rf "$UNKNOWN_TARGET"',
    "rm -rf '/etc",
  ];

  for (const command of dangerous) {
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
  const sandboxDecision = evaluateYoloToolCall(hardlineCall, workDir, roots);
  assert.equal(sandboxDecision.allowed, false);
  assert.match(sandboxDecision.reason ?? "", /Hardline/u);
  assert.equal(evaluateYoloToolCall(ordinaryCall, workDir, roots).allowed, true);

  const relativeSystemCall = toolCall("rm -f etc/passwd");
  assert.equal(evaluateYoloToolCall(relativeSystemCall, "/", roots).allowed, false);
  assert.equal(isHardlineCommand("bash", ordinaryCall.arguments), true);

  const foregroundSafety = buildForegroundSafetyMiddleware(workDir, { mode: "yolo" }, roots);
  assert.equal((await foregroundSafety(hardlineCall)).allowed, false);
  assert.equal((await foregroundSafety(ordinaryCall)).allowed, true);
  const rootForegroundSafety = buildForegroundSafetyMiddleware("/", { mode: "yolo" }, roots);
  assert.equal((await rootForegroundSafety(relativeSystemCall)).allowed, false);
});

test(
  "YOLO hardline 对真实 POSIX Shell stdin 执行入口 fail-closed",
  { skip: process.platform === "win32" },
  () => {
    const script = "printf 'stdin-shell-ran\\n'\n";
    const execution = spawnSync("/bin/sh", [], { encoding: "utf8", input: script });
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "stdin-shell-ran\n");

    const visibleInvocation = `printf '%s' ${JSON.stringify(script)} | sh`;
    assert.equal(isHardlineBashCommand(visibleInvocation, process.cwd()), true);
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
