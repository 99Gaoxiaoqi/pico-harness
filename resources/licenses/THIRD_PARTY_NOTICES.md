# Third-party notices

## Bubblewrap

Linux distributions of Pico include Bubblewrap 0.11.2 as a separate executable.

- Upstream: https://github.com/containers/bubblewrap
- Source release: https://github.com/containers/bubblewrap/releases/tag/v0.11.2
- License: GNU Library General Public License, version 2

The packaged `resources/licenses/bubblewrap/` directory contains the exact source archive used for
the build, its SHA-256 checksum, and the upstream `COPYING` file. Pico invokes Bubblewrap as a
separate process and does not incorporate its source into Pico.

## Apache Maka (incubating)

The atomic memory contracts and SQLite implementation are adapted from Apache Maka (incubating),
revision `c4eacc19c6e26bebd270f7a1cd3a81017c0fe5c9`.

- Upstream: https://github.com/maka-agent/maka-agent
- License: Apache License, Version 2.0
- Included source notices: `resources/licenses/maka/NOTICE`
- Complete upstream license file: `resources/licenses/maka/LICENSE`

The upstream license file is retained verbatim, including its third-party appendix.
That appendix describes the upstream distribution; it is not a list of components
shipped by Pico. Retaining it does not establish that every listed component is
used here. The applicable adaptations identified in Pico are recorded below.

Pico adapts the storage driver and event/provider boundaries, and adds workspace migration,
settings, recall, desktop management, and permanent item deletion with source suppression.
The adapted memory sources are `packages/core/src/atomic-memory-contracts.ts`,
`packages/storage/src/sqlite/atomic-memory-schema.ts`, and
`packages/storage/src/sqlite/sqlite-memory-item-store.ts`. Original license headers
are retained in these files.

The subagent preset normalization in `packages/protocol/src/subagent-settings.ts` is adapted from Maka
`packages/core/src/subagent-settings.ts`, revision `584652137`. Pico retains its validation,
trimming, exact-ID deduplication, and limits, and uses shared Pico protocol types.

The durable research contracts, event projection and workflow prompts in
`packages/core/src/deep-research.ts` are adapted from Maka's `deep-research-run.ts`
and `deep-research.ts`, revision `777a2363c141d2ca4cc212eb5c8a4b6b4bb3e63f`.
Pico adds a canonical SQLite ledger with atomic preview artifacts, session-bound tools,
Unicode-bounded reads and a bounded client progress projection. The original Apache
license header is retained; the license and NOTICE are included above.

The context compaction summary format, structural validation, bounded repair,
usage-based trigger and archive resource behavior are adapted from the local Maka
revision `5846521372d2dd0d3d2d33dc7784dd046dc3f7c8` (Apache-2.0), principally `history-compact-summarizer.ts`,
`history-compact-summary-validation.ts`, `ai-sdk-compaction.ts`, and the
`tool-result-archive-*` modules and `archive-read-tool.ts` (including the resource
operations in Pico's `tool-result-archive-resource.ts`). The adapted Pico sources are
`packages/runtime/src/full-compactor.ts`,
`packages/runtime/src/history-compact-summary-validation.ts`,
`packages/runtime/src/active-tool-result-working-set.ts`,
`packages/runtime/src/tool-result-projections.ts`,
`packages/runtime/src/tool-result-archive.ts`,
`packages/runtime/src/tool-result-archive-resource.ts`, and
`packages/pico-host/src/archive-read-tool.ts`. Pico retains its canonical inline event storage,
1 MiB ingress limit, provider interfaces and session-scoped `archive_read` / `read_file` tools.
Source headers, the Maka NOTICE and Apache license are retained as described above.

The RuntimeHost mechanism in `packages/runtime-host/` was initially adapted from
Maka's host pattern in Pico commit `a6617200`. This covers the NDJSON transport,
control endpoint and registration, lock-based election, protocol frames, host
kernel, and connection/connect-or-spawn skeleton. Pico adds its own composition
factory, business operations, event delivery, and lifecycle behavior. This records
the original mechanism source, not blanket ownership of every file in the package.

The retry policy in `packages/runtime/src/provider-retry.ts` references Maka's
`provider-error-classification.ts` and `ai-sdk-turn.ts` at revision
`5846521372d2dd0d3d2d33dc7784dd046dc3f7c8` for the ten-attempt budget and bounded
exponential backoff with jitter. Pico implements its own transport-error boundary
and effective-progress timeout behavior.

The model pricing snapshot has a separate data origin and MIT notice in
`resources/licenses/models-dev.txt`.
