/** Browser DOM actions run here so every CDP step shares the same authorization fence. */
export interface BrowserDebuggerPort {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type BrowserElementAction =
  | { readonly kind: "click" }
  | { readonly kind: "type"; readonly text: string; readonly clear: boolean };

export async function executeBrowserElementAction(
  debuggerPort: BrowserDebuggerPort,
  selector: string,
  action: BrowserElementAction,
  assertAuthorized: () => void,
): Promise<string> {
  const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    assertAuthorized();
    const result = await debuggerPort.sendCommand(method, params);
    assertAuthorized();
    return result;
  };
  assertAuthorized();
  const attachedHere = !debuggerPort.isAttached();
  if (attachedHere) debuggerPort.attach("1.3");
  try {
    const document = await send("DOM.getDocument", { depth: 0 });
    const rootNodeId = readNodeId(document);
    const match = await send("DOM.querySelector", { nodeId: rootNodeId, selector });
    const nodeId = readNodeId(match);
    if (nodeId === 0) throw new Error(`网页中找不到元素: ${selector}`);
    if (action.kind === "click") {
      await send("DOM.scrollIntoViewIfNeeded", { nodeId });
      const quad = readQuad(await send("DOM.getBoxModel", { nodeId }));
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } else {
      await send("DOM.focus", { nodeId });
      if (action.clear) {
        const modifier = process.platform === "darwin" ? 4 : 2;
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          modifiers: modifier,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          modifiers: modifier,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Backspace",
          code: "Backspace",
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
        });
      }
      if (action.text.length > 0) await send("Input.insertText", { text: action.text });
    }
    return readNodeName(await send("DOM.describeNode", { nodeId }));
  } finally {
    if (attachedHere && debuggerPort.isAttached()) debuggerPort.detach();
  }
}

function readNodeId(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("浏览器 DOM 响应无效");
  const direct = (value as { nodeId?: unknown }).nodeId;
  if (typeof direct === "number" && Number.isSafeInteger(direct)) return direct;
  const root = (value as { root?: { nodeId?: unknown } }).root?.nodeId;
  if (typeof root === "number" && Number.isSafeInteger(root)) return root;
  throw new Error("浏览器 DOM 节点响应无效");
}

function readNodeName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const nodeName = (value as { node?: { nodeName?: unknown } }).node?.nodeName;
  return typeof nodeName === "string" ? nodeName.toLowerCase() : "";
}

function readQuad(
  value: unknown,
): readonly [number, number, number, number, number, number, number, number] {
  if (!value || typeof value !== "object") throw new Error("网页元素当前不可见");
  const model = (value as { model?: { border?: unknown } }).model;
  const border = model?.border;
  if (!Array.isArray(border) || border.length !== 8 || !border.every(Number.isFinite)) {
    throw new Error("网页元素当前不可见或没有可点击区域");
  }
  return border as [number, number, number, number, number, number, number, number];
}
