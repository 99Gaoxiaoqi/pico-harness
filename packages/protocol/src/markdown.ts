/**
 * Cross-surface Markdown safety policy.
 *
 * The Desktop renderer runs in a browser while the TUI runs in Node, so the
 * policy deliberately has no platform dependencies. Individual renderers may
 * perform additional terminal-specific sanitization (for example stripping
 * VT sequences) before calling this function, but both surfaces must agree on
 * which printable text and link schemes are allowed.
 */
export function sanitizeMarkdownText(value: string): string {
  return Array.from(value.replace(/\r\n?/gu, "\n"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        (codePoint >= 32 && (codePoint < 127 || codePoint > 159))
      );
    })
    .join("");
}

/**
 * Links are rendered as inert text unless their scheme is explicitly safe.
 * Hash links stay local to the current document; network links are still
 * opened with the renderer's own noopener policy.
 */
export function isSafeMarkdownHref(value: string): boolean {
  return /^(?:https?:|mailto:|#)/iu.test(value.trim());
}
