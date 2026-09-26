import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme, neutralIconRegistry } from "@astryxdesign/theme-neutral";

/** Pico owns the palette; Astryx supplies component behavior and theme slots. */
export const picoTheme = defineTheme({
  name: "pico",
  extends: neutralTheme,
  icons: neutralIconRegistry,
  typography: {
    body: {
      family: "-apple-system",
      fallbacks: 'ui-sans-serif, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    },
    code: { family: "SFMono-Regular", fallbacks: 'Consolas, "Liberation Mono", monospace' },
  },
  tokens: {
    "--color-background-body": "var(--canvas)",
    "--color-background-surface": "var(--surface)",
    "--color-background-card": "var(--surface-raised)",
    "--color-background-popover": "var(--surface-raised)",
    "--color-background-muted": "var(--surface-muted)",
    "--color-text-primary": "var(--ink)",
    "--color-text-secondary": "var(--ink-secondary)",
    "--color-icon-primary": "var(--ink)",
    "--color-icon-secondary": "var(--ink-secondary)",
    "--color-border": "var(--line)",
    "--color-border-emphasized": "var(--line-strong)",
    "--color-accent": "var(--accent)",
    "--color-accent-muted": "var(--accent-soft)",
    "--color-warning": "var(--warning)",
    "--color-warning-muted": "var(--warning-soft)",
    "--color-error": "var(--danger)",
    "--color-error-muted": "var(--danger-soft)",
    "--radius-inner": "var(--radius-sm)",
    "--radius-element": "var(--radius-md)",
    "--radius-container": "var(--radius-lg)",
    "--shadow-low": "var(--shadow-sm)",
    "--shadow-med": "var(--shadow-lg)",
    "--font-family-body": "var(--font-ui)",
    "--font-family-heading": "var(--font-ui)",
    "--font-family-code": "var(--font-mono)",
  },
});
