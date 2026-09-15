import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import xterm, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { createPreferredWorkbarTerminalProcessFactory } from "../../../packages/runtime-host/src/server/workbar-terminal-authority.js";
import { createTerminalOutputWriter } from "../../../apps/desktop/src/renderer/workbar-panels/terminal-output-writer.js";

const { Terminal } = xterm;

function lines(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)!.translateToString(true),
  );
}

test("terminal display interprets split zsh controls, redraws and bounded polling snapshots", async (context) => {
  const terminal = new Terminal({ cols: 100, rows: 12, allowProposedApi: true });
  context.after(() => terminal.dispose());
  const write = createTerminalOutputWriter(terminal);
  let text = "\x1b[?20";
  const snapshot = () => ({
    terminalId: "pty-1",
    sequence: 1,
    text,
    startOffset: 0,
    resetVersion: 1,
  });
  await write(snapshot());
  text += "04hpico% node -e \"console.log('CU_TERMINAL_OK')\"\x1b[?2004l\r\n";
  text += "\x1b[32mCU_TERMINAL_OK\x1b[0m\r\nprogress 90%\r\x1b[2Kdone\r\nabc\bX\r\n";
  await write(snapshot());
  await write(snapshot()); // An unchanged poll must not execute control sequences twice.
  const retained = text.slice(-8) + "old status\r\x1b[2Knew status";
  await write({ ...snapshot(), sequence: 2, text: retained, startOffset: text.length - 8 });
  assert.deepEqual(lines(terminal).filter(Boolean), [
    "pico% node -e \"console.log('CU_TERMINAL_OK')\"",
    "CU_TERMINAL_OK",
    "done",
    "abX",
    "new status",
  ]);
  assert.equal(terminal.buffer.active.getLine(1)!.getCell(0)!.isFgPalette(), true);
  assert.equal(terminal.buffer.active.getLine(1)!.getCell(0)!.getFgColor(), 2);
  await write({ ...snapshot(), text: "fresh session", resetVersion: 2 });
  assert.deepEqual(lines(terminal).filter(Boolean), ["fresh session"]);
});

test(
  "real zsh PTY command reaches the display once without raw control artifacts",
  { timeout: 15000 },
  async (context) => {
    if (process.platform !== "darwin") return context.skip("macOS zsh PTY regression");
    const terminal = new Terminal({ cols: 160, rows: 24, allowProposedApi: true });
    const write = createTerminalOutputWriter(terminal);
    const factory = createPreferredWorkbarTerminalProcessFactory();
    assert.equal(factory.capability, "pty");
    let text = "";
    let sequence = 0;
    let sent = false;
    let pending = Promise.resolve();
    const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
    const shell = await factory.spawn(
      {
        shell: "/bin/zsh",
        args: ["-f", "-i"],
        cwd: process.cwd(),
        cols: 160,
        rows: 24,
        env: { ...process.env, PS1: "pico> " },
      },
      {
        onExit: () => onExit(),
        onData: (chunk) => {
          text += chunk;
          pending = write({
            terminalId: "zsh",
            text,
            sequence: ++sequence,
            startOffset: 0,
            resetVersion: 1,
          });
          if (!sent && text.includes("pico>")) {
            sent = true;
            shell.write(
              `'${process.execPath.replaceAll("'", "'\\''")}' -e "console.log('CU_TERMINAL_OK')"; exit\r`,
            );
          }
        },
      },
    );
    context.after(() => {
      void shell.terminate("SIGKILL");
      terminal.dispose();
    });
    await exited;
    await pending;
    const rendered = lines(terminal);
    assert.equal(rendered.filter((line) => line === "CU_TERMINAL_OK").length, 1);
    assert.equal(rendered.join("\n").split("console.log").length - 1, 1);
    assert.equal(rendered.join("\n").includes("\x1b"), false);
    assert.doesNotMatch(rendered.join("\n"), /\[\?2004[hl]/u);
  },
);

test("conversation toast clears the global bottom inset so its height follows its content", async () => {
  const root = new URL("../../../apps/desktop/src/renderer/", import.meta.url);
  const [base, conversation] = await Promise.all([
    readFile(new URL("styles.css", root), "utf8"),
    readFile(new URL("conversation/conversation.css", root), "utf8"),
  ]);
  const baseRule = base.match(/\.toast\s*\{([^}]+)\}/u)?.[1] ?? "";
  const override =
    conversation.match(/\.workspace-frame--conversation\s+\.toast\s*\{([^}]+)\}/u)?.[1] ?? "";
  assert.match(baseRule, /position:\s*fixed/u);
  assert.match(baseRule, /bottom:\s*24px/u);
  assert.match(override, /top:\s*66px/u);
  assert.match(override, /bottom:\s*auto/u);
});
