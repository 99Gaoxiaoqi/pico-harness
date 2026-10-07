import type { ITheme } from "@xterm/xterm";

/** Resolve inherited tokens through CSS so light-dark(), aliases and overrides work. */
export function readTerminalTheme(container: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  container.append(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const color = (token: string) => {
    probe.style.color = token;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${red}, ${green}, ${blue}, ${alpha! / 255})`;
  };
  try {
    const background = color("var(--surface-raised)");
    const foreground = color("var(--ink)");
    const red = color("var(--color-text-red, var(--danger))");
    const green = color("var(--color-text-green, var(--ink))");
    const yellow = color("var(--color-text-yellow, var(--warning))");
    const blue = color("var(--color-text-blue, var(--accent))");
    const magenta = color("var(--color-text-purple, var(--accent))");
    const cyan = color("var(--color-text-cyan, var(--accent))");
    return {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: color("var(--accent-soft)"),
      selectionInactiveBackground: color("var(--surface-strong)"),
      selectionForeground: foreground,
      black: foreground,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white: color("var(--ink-secondary)"),
      brightBlack: color("var(--ink-tertiary)"),
      brightRed: red,
      brightGreen: green,
      brightYellow: yellow,
      brightBlue: blue,
      brightMagenta: magenta,
      brightCyan: cyan,
      brightWhite: foreground,
    };
  } finally {
    probe.remove();
  }
}
