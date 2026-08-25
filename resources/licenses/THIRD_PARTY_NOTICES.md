# Third-party notices

## Bubblewrap

Linux distributions of Pico include Bubblewrap 0.11.2 as a separate executable.

- Upstream: https://github.com/containers/bubblewrap
- Source release: https://github.com/containers/bubblewrap/releases/tag/v0.11.2
- License: GNU Library General Public License, version 2

The packaged `resources/licenses/bubblewrap/` directory contains the exact source archive used for
the build, its SHA-256 checksum, and the upstream `COPYING` file. Pico invokes Bubblewrap as a
separate process and does not incorporate its source into Pico.
