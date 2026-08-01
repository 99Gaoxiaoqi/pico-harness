# Sealed xattr helper

`xattr-helper.c` has no dependencies beyond Linux xattr syscalls. Build the two
static binaries in a pinned Alpine toolchain, then verify their SHA-256 values:

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/src:ro" -v "$PWD/out:/out" alpine:3.21 \
  sh -c 'apk add --no-cache build-base && gcc -static -O2 -Wall -Wextra -Werror /src/xattr-helper.c -o /out/xattr-helper-linux-x64'
docker run --rm --platform linux/arm64 -v "$PWD:/src:ro" -v "$PWD/out:/out" alpine:3.21 \
  sh -c 'apk add --no-cache build-base && gcc -static -O2 -Wall -Wextra -Werror /src/xattr-helper.c -o /out/xattr-helper-linux-arm64'
shasum -a 256 out/xattr-helper-linux-x64 out/xattr-helper-linux-arm64
```

The bundle builder verifies the checked-in binary digests before copying them
into the bundle. Runtime accepts no unverified fallback: if the selected helper
is absent, non-executable, has the wrong architecture, or returns an error,
overwrite is rejected before a temporary inode is published.
