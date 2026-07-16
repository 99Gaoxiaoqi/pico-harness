import assert from "node:assert/strict";
import { test } from "node:test";
import { isHardlineBashCommand } from "../../src/approval/bash-hardline.js";
import { isHardlineCommand } from "../../src/approval/manager.js";
import { buildForegroundSafetyMiddleware } from "../../src/runtime/agent-runtime.js";
import { evaluateYoloToolCall } from "../../src/safety/yolo-sandbox.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";

test("YOLO hardline 拒绝受保护目标的 shell 展开与非 -rf 破坏路径", () => {
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
    "rm /private/tmp/system.sock",
    "rm.exe /etc/passwd",
    'find "$HOME" -delete',
    "find /etc -delete",
    "find ./../etc -delete",
    'find "$ROOT" -delete',
    "find /et* -delete",
    "sudo find /etc -delete",
    "find -files0-from targets.txt -delete",
    "find -files0-from - -delete",
    "find /etc -exec rm -f {} +",
    "find / -exec rm {} +",
    'find "$ROOT" -exec unlink {} \\;',
    "find /et* -exec shred {} +",
    "find /etc -execdir truncate -s 0 {} +",
    "find /etc -exec mv {} /tmp/pico-backup +",
    "find /etc -exec sudo -u root rm -f {} +",
    "find /etc -exec env LC_ALL=C unlink {} +",
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
    "sudo cp ./generated.txt /etc/passwd",
    "mv /etc/hosts ./backup",
    "mv ./generated.txt /etc/generated.txt",
    "install ./generated.txt /etc/generated.txt",
    "install -d /etc/pico",
    "tee /etc/passwd",
    "sed -i 's/root/disabled/' /etc/passwd",
    "ln -s ./generated.txt /etc/pico-link",
    ": > /etc/passwd",
    "> /dev/sda",
    "printf x >/etc/passwd",
    "printf x >> /etc/passwd",
    "printf x >|/etc/passwd",
    "printf x &>/etc/passwd",
    "printf x >/tmp/pico.log>/etc/passwd",
    'printf x > "$TARGET"',
    "shopt -s extglob; printf x > /@(etc)/passwd",
  ];

  for (const command of dangerous) {
    assert.equal(isHardlineBashCommand(command), true, command);
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
    "shopt -s extglob; rm /tmp/@(pico-a|pico-b)",
    "rm '/e[t]c/passwd'",
    "find . -delete",
    "find /tmp/pico-cache -delete",
    "find /Users/alice/project -delete",
    'find . -name "$PATTERN" -delete',
    "find . -exec rm ./tmp {} +",
    "find /etc -exec echo rm {} +",
    "find /etc -exec sudo echo rm {} +",
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
    "unlink ./generated.txt",
    "rmdir ./generated-dir",
    "shred -n 1 ./generated.txt",
    "shred --random-source /etc/urandom ./generated.txt",
    "cp /etc/hosts ./backup",
    "cp.exe /etc/hosts ./backup",
    "sudo cp /etc/hosts ./backup",
    "mv ./generated.txt ./backup",
    "install /etc/hosts ./backup",
    "install -m 644 /etc/hosts ./backup",
    "tee ./generated.txt",
    "sed -n '1p' /etc/passwd",
    "sed -i -e '/etc/p' ./generated.txt",
    "sed -i -f /etc/pico.sed ./generated.txt",
    "ln -s /etc/hosts ./hosts-link",
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
    assert.equal(isHardlineBashCommand(command), false, command);
  }
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
    assert.equal(isHardlineCommand("bash", bashArgs(command)), true, command);
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
    '"then" rm -rf /',
    'echo "(rm -rf /)"',
  ];
  for (const command of ordinaryWorkspaceDeletes) {
    assert.equal(isHardlineCommand("bash", bashArgs(command)), false, command);
  }

  assert.equal(isHardlineCommand("write_file", bashArgs("rm -rf /")), false);

  const roots = WorkspaceRoots.createSync(workDir);
  const hardlineCall = toolCall("rm --recursive --force -- /");
  const ordinaryCall = toolCall("rm --recursive --force -- ./dist");
  const sandboxDecision = evaluateYoloToolCall(hardlineCall, workDir, roots);
  assert.equal(sandboxDecision.allowed, false);
  assert.match(sandboxDecision.reason ?? "", /Hardline/u);
  assert.equal(evaluateYoloToolCall(ordinaryCall, workDir, roots).allowed, true);

  const foregroundSafety = buildForegroundSafetyMiddleware(workDir, { mode: "yolo" }, roots);
  assert.equal((await foregroundSafety(hardlineCall)).allowed, false);
  assert.equal((await foregroundSafety(ordinaryCall)).allowed, true);
});

function bashArgs(command: string): string {
  return JSON.stringify({ command });
}

function toolCall(command: string) {
  return { id: command, name: "bash", arguments: bashArgs(command) };
}
