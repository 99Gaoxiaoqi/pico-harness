# Astryx 0.6.2

`ChatLayout` forwards a new optional `autoScroll` prop (default `true`) to
`useChatStreamScroll.enabled`. Pico passes `false` from the first mount and owns
the scroll container, the 96px following threshold and the scroll button.

This patch changes only the source, shipped JavaScript and public declaration.
It does not change Astryx's scrolling algorithm or layout. `postinstall` applies
it with `patch-package --error-on-fail`; dependency updates must explicitly
revalidate the patch and the Electron scroll integration scenario.

Remove it when the published component exposes an equivalent opt-out.
