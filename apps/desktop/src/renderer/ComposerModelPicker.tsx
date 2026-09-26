import { AlertTriangle, Check, Cpu, LoaderCircle, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
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

/** Composer-only model menu; Astryx owns positioning, dismissal and keyboard navigation. */
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
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const selected = document.querySelector<HTMLElement>(
        `[data-pico-model-picker="${id}"] [role="menuitemradio"][aria-checked="true"]`,
      );
      selected?.focus({ preventScroll: true });
      selected?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, open]);
  async function pick(next: string) {
    if (locked) return;
    setOpen(false);
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
      <Button
        label="配置模型"
        variant="ghost"
        className="composer-model-trigger pico-page-control"
        onClick={onConfigure}
        isDisabled={locked}
        tooltip="添加模型厂商"
      >
        <Settings aria-hidden="true" />
        <span>配置模型</span>
      </Button>
    );
  return (
    <DropdownMenu
      isMenuOpen={open}
      onOpenChange={(next) => setOpen(next && !locked)}
      className="composer-model-menu pico-composer-model-menu"
      data-pico-model-picker={id}
      placement="above"
      alignment="start"
      menuWidth={292}
      hasChevron={false}
      presentation="popover"
      button={{
        label: `选择模型：${label}`,
        children: (
          <>
            {pending ? (
              <LoaderCircle className="composer-model-loading" aria-hidden="true" />
            ) : (
              <Mark source={currentGroup?.icon} />
            )}
            <span>{label}</span>
          </>
        ),
        className: "composer-model-trigger pico-page-control",
        variant: "ghost",
        isDisabled: locked,
        tooltip: disabled
          ? "任务执行中，结束后可切换模型"
          : pending
            ? "正在切换模型…"
            : `切换模型 · ${label}`,
      }}
    >
      {hasHistory && (
        <p className="composer-model-notice">
          <AlertTriangle aria-hidden="true" />
          <span>切换模型可能需要重建提示缓存，下一次回复可能更慢或成本更高。</span>
        </p>
      )}
      <DropdownMenuRadioGroup value={value} label="选择模型" onChange={(next) => void pick(next)}>
        {value && !current && (
          <DropdownMenuRadioItem
            value={value}
            className="composer-model-item"
            label={<strong>{label}</strong>}
            description="当前模型 · 暂不在可选列表中"
            icon={<Mark />}
            endContent={<Check className="composer-model-check" aria-hidden="true" />}
            isDisabled={locked}
          />
        )}
        {groups.map(([key, group]) => (
          <div role="group" aria-label={group.heading} key={key}>
            <div className="composer-model-heading" aria-hidden="true">
              {group.heading}
            </div>
            {group.choices.map((choice) => (
              <DropdownMenuRadioItem
                key={choice.id}
                value={choice.id}
                className="composer-model-item"
                label={<strong>{choice.label}</strong>}
                description={
                  choice.label !== choice.model ? <small>{choice.model}</small> : undefined
                }
                icon={<Mark source={group.icon} />}
                endContent={
                  choice.id === value ? (
                    <Check className="composer-model-check" aria-hidden="true" />
                  ) : undefined
                }
                isDisabled={locked}
              />
            ))}
          </div>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
