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

## node-forge 1.4.0

`node-forge+1.4.0.patch` backports the nested AlgorithmIdentifier element-count
check from [forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152), fixed
at [ceba34402e329f0365134f23fe19898756527d65](https://github.com/digitalbazaar/forge/commit/ceba34402e329f0365134f23fe19898756527d65),
for [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
Our additional local guard rejects nonempty NULL parameters: the existing ASN.1
validator checks their tag and primitive form but does not check their contents.
DigestInfo must contain exactly AlgorithmIdentifier and a primitive OCTET STRING;
AlgorithmIdentifier must contain an OID and at most one empty, primitive NULL.

Only RSASSA-PKCS1-v1_5 verification changes. The existing hash whitelist, padding
checks, MD2/MD5 parameter requirement and legal SHA-256 omitted NULL behavior stay
in place; RSA-PSS is unchanged. The integration test creates a real Expo signing
certificate and manifest, independently verifies the manifest with Node crypto,
checks PSS and omitted NULL compatibility, and rejects deliberately signed
malformed DigestInfo values through both forge and Expo verification.

Remove this patch and its matching audit exception only after a published version
rejects both extra nested children and nonempty NULL values, passes these same
integration cases, and is outside the advisory's affected range. This patch is a
local mitigation, not a claim that every forge verification issue is fixed.

## braces 3.0.3

`braces+3.0.3.patch` backports only the five runtime-file security changes from
[braces PR #72](https://github.com/micromatch/braces/pull/72), fixed at
[28d440b5dd449dbf1fe6f3506cf94ecca4d02660](https://github.com/micromatch/braces/commit/28d440b5dd449dbf1fe6f3506cf94ecca4d02660)
against PR base `e53730e6f935498326c72d768889ac194eedc0e0`. It limits mixed brace and
parenthesis nesting to 100, applies the same cap to compile/expand/stringify AST
inputs, and rejects cyclic parent chains used during expansion. A stricter
`maxDepth` remains supported, including fractional limits; larger values cannot
raise the cap. The corrected stringify recursion preserves `escapeInvalid`.

The upstream head also contains older quote and comma changes unrelated to this
PR; those are not included. The integration test isolates dangerous inputs in a
child process with a timeout and verifies 100/101 depth boundaries, direct AST
depth, child/parent cycles, ordinary expansion and existing escaping behavior.
This patch adds no AST schema validation or new expansion-cardinality limit;
existing `maxLength` and `rangeLimit` protections remain necessary.

Remove this patch and its matching audit exception when a published release
contains these guards, passes the integration cases and is outside the matching
advisory's affected range.

## query-string 7.1.3 and decode-uri-component 0.5.0

`query-string+7.1.3.patch` is a local compatibility adaptation for the security
override to [decode-uri-component 0.5.0](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.0).
The decoder now exposes an ESM default export. query-string's CommonJS consumer
selects that default when present and keeps support for a CommonJS function.
No query parsing, encoding, array or null handling changes. This relies on the
repository's supported Node versions with synchronous `require(esm)` support.

The integration test confirms that query-string actually resolves decoder 0.5.0
and exercises Chinese text, emoji, encoded plus signs, spaces, empty/null values,
round trips, malformed escapes and `decode: false`. Remove this adaptation after
upgrading to a query-string version compatible with the supported secure decoder
and revalidating its consumers.

Run the focused verification with:

```sh
node --import tsx --test tests/integration/security/dependency-security-patches.integration.test.ts
```
