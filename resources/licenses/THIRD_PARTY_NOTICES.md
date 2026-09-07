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
