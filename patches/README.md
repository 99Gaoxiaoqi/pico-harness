# Astryx 0.6.2

`ChatLayout` forwards a new optional `autoScroll` prop (default `true`) to
`useChatStreamScroll.enabled`. Pico passes `false` from the first mount and owns
the scroll container, the 96px following threshold and the scroll button.

`ChatComposerInput` handles clipboard files only when an `onFiles` consumer is
registered. Without one, mixed file/text clipboard data follows the normal plain
text insertion path. The Electron regression first reproduced dropped text with
an image and `text/plain` in the same clipboard event. Plain-text paste uses
Chromium's native `insertText` editing command (with the original Range fallback)
to preserve the undo/redo history. The regression reproduced paste surviving undo
while prior typed text was removed; it now verifies paste undo/redo and selection
replacement. The input serializer also excludes Chromium's terminal caret-only
line break, preserves DIV/P line boundaries and whitespace-only drafts. Controlled
value restoration adds that caret-only line break when the draft ends in a newline.
The Electron regression covers complete Shift+Enter events, consecutive blank
lines, restored trailing lines and multiline paste.

These patches change only the source, shipped JavaScript and public declaration.
It does not change Astryx's scrolling algorithm or layout. `postinstall` applies
it with `patch-package --error-on-fail`; dependency updates must explicitly
revalidate the patch and the Electron scroll integration scenario.

Remove each patch when the published component provides the equivalent behavior.

# Temporary dependency security patches

These are private, version-pinned patches applied by the same
`patch-package --error-on-fail` postinstall step. They are not official patched
releases. Dependency upgrades must explicitly revalidate or remove them; a failed
patch application must stop installation. Audit exceptions must match the exact
advisory and installed version, verify patched file hashes, and expire rather than
silently suppress other findings.

The former braces and node-forge patches are gone: braces is no longer reported
by `npm audit`, and node-forge 1.4.4 is a published release outside the advisory
range.

## query-string 7.1.3 and decode-uri-component 0.5.1

`query-string+7.1.3.patch` is a local compatibility adaptation for the security
override to [decode-uri-component 0.5.1](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.1).
The decoder exposes an ESM-only default export. query-string's CommonJS consumer
selects that default when present and keeps support for a CommonJS function.
No query parsing, encoding, array or null handling changes. This relies on the
repository's supported Node versions with synchronous `require(esm)` support.

The integration test confirms that query-string actually resolves decoder 0.5.1
and exercises Chinese text, emoji, encoded plus signs, spaces, empty/null values,
round trips, malformed escapes and `decode: false`. Remove this adaptation after
upgrading to a query-string version compatible with the supported secure decoder
and revalidating its consumers.

Run the focused verification with:

```sh
node --import tsx --test tests/integration/security/query-string-decoder.integration.test.ts
```
