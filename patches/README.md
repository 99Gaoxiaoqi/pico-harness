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
