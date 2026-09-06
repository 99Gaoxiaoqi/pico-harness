import { AlertTriangle, Check, Cpu, LoaderCircle, Settings } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ModelRouteView, ProviderView } from "./model.js";
import { providerPresets } from "./provider-presets.js";

const marks = import.meta.glob<string>("./assets/provider-brands/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

function providerPresentation(id: string, providers: readonly ProviderView[]) {
  const provider = providers.find((item) => item.id === id);
  const preset =
    providerPresets.find((item) => item.id === id) ??
    (provider &&
      providerPresets.find(
        (item) =>
          item.baseURL &&
          item.baseURL.replace(/\/+$/u, "") === provider.baseURL.replace(/\/+$/u, "") &&
          item.auth === provider.auth,
      ));
  return {
    heading: preset && id === preset.id ? preset.name : id || "模型",
    icon: preset ? marks[`./assets/provider-brands/${preset.icon ?? preset.id}.svg`] : undefined,
  };
}

function Mark({ source }: { source?: string | undefined }) {
  return source ? (
    <img className="composer-model-mark" src={source} alt="" aria-hidden="true" />
  ) : (
    <Cpu className="composer-model-mark" aria-hidden="true" />
  );
}

/** Composer-only menu. Native popovers provide top-layer clipping, Escape and light dismissal. */
export function ComposerModelPicker({
  routes,
  providers,
  value,
  currentLabel,
  disabled = false,
  hasHistory = false,
  onChange,
  onConfigure,
}: {
  routes: readonly ModelRouteView[];
  providers: readonly ProviderView[];
  value?: string | undefined;
  currentLabel?: string | undefined;
  disabled?: boolean | undefined;
  hasHistory?: boolean | undefined;
  onChange: (id: string) => void | Promise<void>;
  onConfigure: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ value: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const locked = disabled || pending;
  const groups = useMemo(() => {
    const result = new Map<
      string,
      {
        heading: string;
        icon?: string | undefined;
        choices: { id: string; label: string; model: string }[];
      }
    >();
    for (const route of routes) {
      const separator = route.id.indexOf("/");
      const providerId = separator < 0 ? "" : route.id.slice(0, separator);
      const model = separator < 0 ? route.id : route.id.slice(separator + 1);
      const group = result.get(providerId) ?? {
        ...providerPresentation(providerId, providers),
        choices: [],
      };
      group.choices.push({
        id: route.id,
        model,
        label: route.label.endsWith(` · ${providerId}`)
          ? route.label.slice(0, -` · ${providerId}`.length)
          : route.label,
      });
      result.set(providerId, group);
    }
    return [...result.entries()];
  }, [routes, providers]);
  const currentGroup = groups.find(([, group]) =>
    group.choices.some((choice) => choice.id === value),
  )?.[1];
  const current = currentGroup?.choices.find((choice) => choice.id === value);
  const label =
    current?.label ?? currentLabel ?? (value ? value.slice(value.indexOf("/") + 1) : "选择模型");
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled)',
    ) ?? []),
  ];
  const close = (restoreFocus = true) => {
    menu.current?.hidePopover();
    if (restoreFocus) trigger.current?.focus();
  };
  const position = () => {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = Math.min(292, window.innerWidth - 24);
    Object.assign(menu.current.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      bottom: `${window.innerHeight - rect.top + 7}px`,
      maxHeight: `${Math.max(80, Math.min(328, rect.top - 19))}px`,
    });
  };
  useLayoutEffect(() => {
    if (!open) return;
    position();
    const selected =
      items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0];
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest" });
    window.addEventListener("resize", position);
    // Layout can move when the draft wraps or the sidebar is resized.
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current.closest("form") ?? trigger.current);
    return () => {
      window.removeEventListener("resize", position);
      observer.disconnect();
    };
  }, [open]);
  useEffect(() => {
    if (locked) menu.current?.hidePopover();
  }, [locked]);

  function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
    const choices = items();
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    let target: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") target = choices[(index + 1) % choices.length];
    else if (event.key === "ArrowUp")
      target = choices[(index - 1 + choices.length) % choices.length];
    else if (event.key === "Home") target = choices[0];
    else if (event.key === "End") target = choices.at(-1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    } else if (event.key === "Tab") {
      close();
      return;
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const now = Date.now();
      typeahead.current.value =
        (now - typeahead.current.time > 700 ? "" : typeahead.current.value) +
        event.key.toLocaleLowerCase();
      typeahead.current.time = now;
      target = [...choices.slice(index + 1), ...choices.slice(0, index + 1)].find((item) =>
        item.dataset.label?.toLocaleLowerCase().startsWith(typeahead.current.value),
      );
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }
  async function pick(next: string) {
    if (locked) return;
    close();
    if (next === value) return;
    setPending(true);
    try {
      await onChange(next);
    } catch {
      /* The App action owner displays switch failures. */
    } finally {
      setPending(false);
    }
  }

  if (!routes.length)
    return (
      <button
        type="button"
        className="composer-model-trigger"
        onClick={onConfigure}
        disabled={locked}
        title="添加模型厂商"
      >
        <Settings aria-hidden="true" />
        <span>配置模型</span>
      </button>
    );
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="composer-model-trigger"
        disabled={locked}
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`选择模型：${label}`}
        title={
          disabled
            ? "任务执行中，结束后可切换模型"
            : pending
              ? "正在切换模型…"
              : `切换模型 · ${label}`
        }
        onKeyDown={(event) => {
          if (!locked && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            menu.current?.showPopover();
          }
        }}
      >
        {pending ? (
          <LoaderCircle className="composer-model-loading" aria-hidden="true" />
        ) : (
          <Mark source={currentGroup?.icon} />
        )}
        <span>{label}</span>
      </button>
      <div
        id={id}
        ref={menu}
        popover="auto"
        role="menu"
        aria-label="选择模型"
        className="composer-model-menu"
        onBeforeToggle={(event) => {
          if (event.newState === "open") position();
        }}
        onToggle={(event) => setOpen(event.newState === "open")}
        onKeyDown={navigateMenu}
      >
        {hasHistory && (
          <p className="composer-model-notice">
            <AlertTriangle aria-hidden="true" />
            <span>切换模型可能需要重建提示缓存，下一次回复可能更慢或成本更高。</span>
          </p>
        )}
        {value && !current && (
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            tabIndex={-1}
            className="composer-model-item"
            data-label={label}
            disabled={locked}
            onClick={() => close()}
          >
            <Mark />
            <span>
              <strong>{label}</strong>
              <small>当前模型 · 暂不在可选列表中</small>
            </span>
            <Check aria-hidden="true" />
          </button>
        )}
        {groups.map(([key, group]) => (
          <div role="group" aria-label={group.heading} key={key}>
            <div className="composer-model-heading" aria-hidden="true">
              {group.heading}
            </div>
            {group.choices.map((choice) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={choice.id === value}
                tabIndex={-1}
                className="composer-model-item"
                key={choice.id}
                data-label={choice.label}
                disabled={locked}
                title={choice.model}
                onClick={() => void pick(choice.id)}
              >
                <Mark source={group.icon} />
                <span>
                  <strong>{choice.label}</strong>
                  {choice.label !== choice.model && <small>{choice.model}</small>}
                </span>
                {choice.id === value && (
                  <Check className="composer-model-check" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
