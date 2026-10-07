import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalTheme } from "./palette";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

const term = new Terminal({
  disableStdin: true,
  cursorBlink: true,
  fontSize: 13,
  theme: terminalTheme,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
const send = (value: unknown) => window.ReactNativeWebView.postMessage(JSON.stringify(value));
term.onData((data) => send({ type: "input", data }));
term.onResize((size) => send({ type: "resize", ...size }));

type Output = { data: string; reset?: boolean; id?: number };
const maxQueuedCharacters = 128 * 1024;
let outputs: Output[] = [];
let queuedCharacters = 0;
let writing = false;
let lastOutputId = 0;
function drain() {
  if (writing) return;
  const output = outputs.shift();
  if (!output) return;
  queuedCharacters -= output.data.length;
  writing = true;
  if (output.reset) term.reset();
  term.write(output.data, () => {
    writing = false;
    send({ type: "written", id: output.id });
    drain();
  });
}
function enqueue(output: Output) {
  if (typeof output.id === "number") {
    if (output.id <= lastOutputId) return;
    lastOutputId = output.id;
  }
  if (output.reset) {
    outputs = [];
    queuedCharacters = 0;
  }
  if (queuedCharacters + output.data.length > maxQueuedCharacters) {
    send({ type: "overflow" });
    return;
  }
  outputs.push(output);
  queuedCharacters += output.data.length;
  drain();
}
function applyTheme(theme: ITheme) {
  term.options.theme = theme;
  document.documentElement.style.setProperty(
    "--terminal-bg",
    theme.background ?? terminalTheme.background,
  );
  document.documentElement.style.setProperty(
    "--terminal-fg",
    theme.foreground ?? terminalTheme.foreground,
  );
}
function receive(event: MessageEvent) {
  try {
    const message = JSON.parse(event.data);
    if (message.type === "output" && typeof message.data === "string") enqueue(message);
    if (message.type === "theme" && message.theme) applyTheme(message.theme);
    if (message.type === "key") term.input(message.data, true);
    if (message.type === "readonly") term.options.disableStdin = message.value === true;
    if (message.type === "focus") term.focus();
  } catch {
    // Ignore malformed bridge messages; terminal input is never replayed.
  }
}
window.addEventListener("message", receive);
document.addEventListener("message", receive as EventListener);
new ResizeObserver(() => fit.fit()).observe(document.body);
fit.fit();
send({ type: "ready" });
