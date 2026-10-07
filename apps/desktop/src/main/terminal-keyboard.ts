import type { Event, Input, WebContents } from "electron";

export function installTerminalKeyboardShortcuts(contents: WebContents) {
  let focused = false;
  // Use the concrete event signature; other application accelerators retain their behavior.
  const handler = (_event: Event, input: Input) => {
    contents.setIgnoreMenuShortcuts(
      focused && input.control && !input.meta && ["c", "v"].includes(input.key.toLowerCase()),
    );
  };
  contents.on("before-input-event", handler);
  return {
    clipboard(action: "copy" | "paste") {
      if (!focused || contents.isDestroyed()) return;
      if (action === "copy") contents.copy();
      else contents.paste();
    },
    setFocused(value: boolean) {
      focused = value;
      if (!value) contents.setIgnoreMenuShortcuts(false);
    },
    dispose() {
      contents.removeListener("before-input-event", handler);
      if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
    },
  };
}
