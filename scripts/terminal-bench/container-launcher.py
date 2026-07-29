from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


SECRET_ENV = "PICO_TB_PROVIDER_API_KEY"
REQUEST = Path("/logs/agent/headless-request.json")
RESULT = Path("/logs/agent/pico-result.json")
EXIT_CODE = Path("/logs/agent/pico-exit-code.txt")
STDERR = Path("/logs/agent/pico-stderr.log")
ENTRY = "/installed-agent/pico/dist/internal/headless-one-shot-main.js"


def atomic_replace(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_secret() -> bytes:
    header = sys.stdin.buffer.readline(10)
    if len(header) != 9 or header[-1:] != b"\n":
        raise RuntimeError("invalid secret frame")
    size = int(header[:8], 16)
    if size < 1 or size > 64 * 1024:
        raise RuntimeError("invalid secret size")
    value = sys.stdin.buffer.read(size)
    if len(value) != size or sys.stdin.buffer.read(1):
        raise RuntimeError("invalid secret payload")
    return value


def main() -> int:
    secret = read_secret().decode("utf-8")
    environment = os.environ.copy()
    environment[SECRET_ENV] = secret
    with REQUEST.open("rb") as request:
        completed = subprocess.run(
            ["node", ENTRY],
            stdin=request,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            check=False,
        )
    atomic_replace(RESULT, completed.stdout)
    atomic_replace(EXIT_CODE, f"{completed.returncode}\n".encode())
    atomic_replace(STDERR, completed.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
