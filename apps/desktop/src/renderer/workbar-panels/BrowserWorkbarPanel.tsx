import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RefreshCw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  DesktopBridge,
  DesktopBrowserState,
} from "../../preload/contract.js";

export interface BrowserWorkbarPanelProps {
  readonly bridge: DesktopBridge;
  readonly sessionId: string;
  readonly active: boolean;
}

export function BrowserWorkbarPanel({ bridge, sessionId, active }: BrowserWorkbarPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const consume = useCallback((next: DesktopBrowserState | null): void => {
    setState(next);
    if (next?.url) setAddress(next.url);
  }, []);

  useEffect(() => bridge.browser.onState((next) => {
    if (next.sessionId === sessionId) consume(next);
  }), [bridge, consume, sessionId]);

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
    const generation = ++generationRef.current;
    if (!active) {
      void bridge.browser.setViewport({ sessionId, rect: null, generation });
      return;
    }
    void bridge.browser.setActiveSession(sessionId);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sync = (): void => {
      const rect = viewport.getBoundingClientRect();
      void bridge.browser.setViewport({
        sessionId,
        generation,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge.browser.setViewport({
        sessionId,
        rect: null,
        generation: ++generationRef.current,
      });
    };
  }, [active, bridge, sessionId]);

  const perform = useCallback(
    async (operation: () => Promise<{ readonly ok: boolean; readonly value?: DesktopBrowserState; readonly error?: { readonly message: string } }>) => {
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
            value={address}
            placeholder="输入网址或域名"
            spellCheck={false}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <button
          type="button"
          aria-label="关闭当前页面"
          disabled={!state}
          onClick={() => {
            void bridge.browser.close(sessionId).then((result) => {
              if (result.ok) consume(null);
              else setMessage(result.error.message);
            });
          }}
        >
          <X aria-hidden="true" size={15} />
        </button>
      </form>
      {message && <p className="workbar-browser__error" role="alert">{message}</p>}
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
