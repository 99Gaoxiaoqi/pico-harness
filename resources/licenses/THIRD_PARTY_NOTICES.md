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
- Full license: `resources/licenses/maka/LICENSE`

Pico adapts the storage driver and event/provider boundaries, and adds workspace migration,
settings, recall, desktop management, and permanent item deletion with source suppression.
Original license headers are retained in the adapted source files.

The subagent preset normalization in `src/input/subagent-settings.ts` is adapted from Maka
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
revision `584652137` (Apache-2.0), principally `history-compact-summarizer.ts`,
`history-compact-summary-validation.ts`, `ai-sdk-compaction.ts`, and the
`tool-result-archive-*` modules and `archive-read-tool.ts` (including the resource
operations in Pico's `tool-result-archive-resource.ts`). Pico retains its canonical inline event storage,
1 MiB ingress limit, provider interfaces and session-scoped `archive_read` / `read_file` tools.
Source headers, the Maka NOTICE and Apache license are retained as described above.
