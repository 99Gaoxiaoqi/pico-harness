# Astryx 0.6.2

`ChatLayout` forwards a new optional `autoScroll` prop (default `true`) to
`useChatStreamScroll.enabled`. Pico passes `false` from the first mount and owns
the scroll container, the 96px following threshold and the scroll button.

`ChatComposerInput` handles clipboard files only when an `onFiles` consumer is
registered. Without one, mixed file/text clipboard data follows the normal plain
text insertion path. The Electron regression first reproduced dropped text with
an image and `text/plain` in the same clipboard event.

These patches change only the source, shipped JavaScript and public declaration.
It does not change Astryx's scrolling algorithm or layout. `postinstall` applies
it with `patch-package --error-on-fail`; dependency updates must explicitly
revalidate the patch and the Electron scroll integration scenario.

Remove each patch when the published component provides the equivalent behavior.
