import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { JsonObject, RuntimeBrowserAgentCommand } from "@pico/protocol";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DesktopBridge, DesktopBrowserState } from "../../preload/contract.js";

export interface BrowserWorkbarPanelProps {
  readonly bridge: DesktopBridge;
  readonly sessionId: string;
  readonly active: boolean;
}

export function BrowserWorkbarPanel({ bridge, sessionId, active }: BrowserWorkbarPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const consume = useCallback((next: DesktopBrowserState | null): void => {
    setState(next);
    if (next) setAddress(next.url);
  }, []);

  useEffect(
    () =>
      bridge.browser.onState((next) => {
        if (next.sessionId === sessionId) consume(next);
      }),
    [bridge, consume, sessionId],
  );

  useEffect(() => {
    let disposed = false;
    void bridge.browser.getState(sessionId).then((result) => {
      if (!disposed && result.ok) consume(result.value);
    });
    return () => {
      disposed = true;
    };
  }, [bridge, consume, sessionId]);

  useEffect(() => {
    let disposed = false;
    let generation: number | undefined;
    let observer: ResizeObserver | undefined;
    let sync: (() => void) | undefined;
    void bridge.browser.acquireViewport(sessionId).then((result) => {
      if (!result.ok) {
        if (!disposed) setMessage(result.error.message);
        return;
      }
      generation = result.value;
      if (disposed) {
        void bridge.browser.setViewport({ sessionId, rect: null, generation });
        return;
      }
      if (!active) {
        void bridge.browser.setViewport({ sessionId, rect: null, generation });
        return;
      }
      void bridge.browser.setActiveSession(sessionId);
      const viewport = viewportRef.current;
      if (!viewport) return;
      sync = (): void => {
        const rect = viewport.getBoundingClientRect();
        void bridge.browser.setViewport({
          sessionId,
          generation: result.value,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      };
      observer = new ResizeObserver(sync);
      observer.observe(viewport);
      window.addEventListener("resize", sync);
      window.addEventListener("scroll", sync, true);
      sync();
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      if (sync) {
        window.removeEventListener("resize", sync);
        window.removeEventListener("scroll", sync, true);
      }
      if (generation !== undefined) {
        void bridge.browser.setViewport({ sessionId, rect: null, generation });
      }
    };
  }, [active, bridge, sessionId]);

  useEffect(() => {
    if (!active || !state?.visible) return;
    let disposed = false;
    let leaseId: string | undefined;
    const generation = state.generation;

    const executeCommand = async (command: RuntimeBrowserAgentCommand): Promise<JsonObject> => {
      switch (command.action) {
        case "navigate": {
          const url = command.input["url"];
          if (typeof url !== "string") throw new Error("browser_navigate 缺少 url");
          const result = await bridge.browser.navigate(sessionId, url);
          if (!result.ok) throw new Error(result.error.message);
          consume(result.value);
          return browserStateResult(result.value);
        }
        case "back":
        case "forward":
        case "reload": {
          const result = await bridge.browser[command.action](sessionId);
          if (!result.ok) throw new Error(result.error.message);
          consume(result.value);
          return browserStateResult(result.value);
        }
        case "get_state": {
          const result = await bridge.browser.getState(sessionId);
          if (!result.ok) throw new Error(result.error.message);
          if (!result.value?.visible) throw new Error("浏览器面板当前不可见");
          consume(result.value);
          return browserStateResult(result.value);
        }
        case "click": {
          const selector = command.input["selector"];
          if (typeof selector !== "string") throw new Error("browser_click 缺少 selector");
          const result = await bridge.browser.click(sessionId, selector);
          if (!result.ok) throw new Error(result.error.message);
          consume(result.value.state);
          return {
            selector: result.value.selector,
            tagName: result.value.tagName,
            state: browserStateResult(result.value.state),
          };
        }
        case "type": {
          const selector = command.input["selector"];
          const text = command.input["text"];
          const clear = command.input["clear"];
          if (typeof selector !== "string" || typeof text !== "string") {
            throw new Error("browser_type 缺少 selector 或 text");
          }
          const result = await bridge.browser.type(
            sessionId,
            selector,
            text,
            typeof clear === "boolean" ? clear : true,
          );
          if (!result.ok) throw new Error(result.error.message);
          consume(result.value.state);
          return {
            selector: result.value.selector,
            tagName: result.value.tagName,
            state: browserStateResult(result.value.state),
          };
        }
      }
    };

    const run = async (): Promise<void> => {
      let expiresAt = 0;
      while (!disposed) {
        try {
          if (!leaseId || expiresAt - Date.now() < 3_000) {
            const lease = await bridge.runtime["browser.agent.lease"]({
              sessionId,
              visible: true,
              generation,
              ...(leaseId ? { leaseId } : {}),
            });
            if (!lease.ok) throw new Error(lease.error.message);
            leaseId = lease.value.leaseId;
            expiresAt = lease.value.expiresAt;
          }
          const next = await bridge.runtime["browser.agent.next"]({
            sessionId,
            leaseId,
            waitMs: 1_000,
          });
          if (!next.ok) throw new Error(next.error.message);
          const command = next.value.command;
          if (!command || disposed) continue;
          let resolution:
            | { readonly ok: true; readonly result: JsonObject }
            | { readonly ok: false; readonly error: string };
          try {
            const result = await executeCommand(command);
            if (disposed) continue;
            resolution = { ok: true, result };
          } catch (error) {
            if (disposed) continue;
            resolution = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          const settled = await bridge.runtime["browser.agent.resolve"]({
            sessionId,
            leaseId,
            commandId: command.commandId,
            ...resolution,
          });
          if (!settled.ok) throw new Error(settled.error.message);
        } catch (error) {
          if (!disposed) {
            setMessage(error instanceof Error ? error.message : String(error));
            window.setTimeout(() => {
              if (!disposed) void run();
            }, 1_000);
            return;
          }
        }
      }
    };

    void run();
    return () => {
      disposed = true;
      if (leaseId) {
        void bridge.runtime["browser.agent.lease"]({
          sessionId,
          visible: false,
          generation,
          leaseId,
        });
      }
    };
  }, [active, bridge, consume, sessionId, state?.visible]);

  const perform = useCallback(
    async (
      operation: () => Promise<{
        readonly ok: boolean;
        readonly value?: DesktopBrowserState;
        readonly error?: { readonly message: string };
      }>,
    ) => {
      setMessage(null);
      const result = await operation();
      if (result.ok) consume(result.value ?? null);
      else setMessage(result.error?.message ?? "浏览器操作失败");
    },
    [consume],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const target = address.trim();
      if (!target) return;
      void perform(() => bridge.browser.navigate(sessionId, target));
    },
    [address, bridge, perform, sessionId],
  );

  return (
    <section className="workbar-browser" aria-label="浏览器">
      <form className="workbar-browser__toolbar" onSubmit={submit}>
        <button
          type="button"
          aria-label="后退"
          disabled={!state?.canGoBack}
          onClick={() => void perform(() => bridge.browser.back(sessionId))}
        >
          <ArrowLeft aria-hidden="true" size={15} />
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!state?.canGoForward}
          onClick={() => void perform(() => bridge.browser.forward(sessionId))}
        >
          <ArrowRight aria-hidden="true" size={15} />
        </button>
        <button
          type="button"
          aria-label={state?.loading ? "停止加载" : "重新加载"}
          onClick={() =>
            void perform(() =>
              state?.loading ? bridge.browser.stop(sessionId) : bridge.browser.reload(sessionId),
            )
          }
        >
          {state?.loading ? (
            <LoaderCircle className="workbar-browser__spinner" aria-hidden="true" size={15} />
          ) : (
            <RefreshCw aria-hidden="true" size={15} />
          )}
        </button>
        <label className="workbar-browser__address">
          <Globe2 aria-hidden="true" size={14} />
          <span className="sr-only">地址</span>
          <input
            name="workbar-browser-address"
            inputMode="url"
            autoComplete="off"
            value={address}
            placeholder="输入网址或域名…"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <button
          type="button"
          aria-label="关闭当前页面"
          disabled={!state?.hasPage}
          onClick={() => {
            void perform(() => bridge.browser.clearPage(sessionId));
          }}
        >
          <X aria-hidden="true" size={15} />
        </button>
      </form>
      {message && (
        <p className="workbar-browser__error" role="alert">
          {message}
        </p>
      )}
      <div
        ref={viewportRef}
        className="workbar-browser__viewport"
        data-empty={!state?.hasPage || undefined}
        aria-label="网页内容区域"
      >
        {!state?.hasPage && (
          <div className="workbar-browser__empty">
            <Globe2 aria-hidden="true" size={24} />
            <strong>打开网页</strong>
            <span>在地址栏输入域名，页面会在当前任务中保持。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function browserStateResult(state: DesktopBrowserState): JsonObject {
  return {
    sessionId: state.sessionId,
    url: state.url,
    title: state.title,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.loading,
    secure: state.secure,
    hasPage: state.hasPage,
    visible: state.visible,
    generation: state.generation,
  };
}
