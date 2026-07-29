from __future__ import annotations

import fcntl
import inspect
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

_PROJECT_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")


def install_project_registration(
    docker_environment: type[Any],
    registry_path: Path,
    run_id: str,
) -> None:
    original_init = docker_environment.__init__
    signature = inspect.signature(original_init)

    def registered_init(instance: Any, *args: Any, **kwargs: Any) -> None:
        bound = signature.bind(instance, *args, **kwargs)
        session_id = bound.arguments.get("session_id")
        if not isinstance(session_id, str):
            raise RuntimeError("Harbor Docker environment session ID is unavailable")
        register_compose_project(registry_path, run_id, sanitize_project(session_id))
        original_init(instance, *args, **kwargs)

    docker_environment.__init__ = registered_init


def register_compose_project(path: Path, run_id: str, compose_project: str) -> None:
    if not _PROJECT_PATTERN.fullmatch(compose_project):
        raise RuntimeError("Harbor Compose project name is invalid")
    record = json.dumps(
        {
            "schemaVersion": 1,
            "runId": run_id,
            "composeProject": compose_project,
        },
        separators=(",", ":"),
    )
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        with os.fdopen(descriptor, "a", encoding="utf-8", closefd=True) as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.write(f"{record}\n")
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def sanitize_project(value: str) -> str:
    normalized = value.lower()
    if not re.match(r"^[a-z0-9]", normalized):
        normalized = f"0{normalized}"
    return re.sub(r"[^a-z0-9_-]", "-", normalized)


def main() -> None:
    registry_path = Path(require_env("PICO_TB_RESOURCE_REGISTRY_PATH")).resolve()
    run_id = require_env("PICO_TB_RUN_ID")
    dataset_fd_raw = os.environ.pop("PICO_TB_DATASET_FD", None)
    if not registry_path.parent.is_dir():
        raise RuntimeError("Harbor resource registry parent is unavailable")

    from harbor.environments.docker.docker import DockerEnvironment

    install_project_registration(DockerEnvironment, registry_path, run_id)
    if dataset_fd_raw is not None:
        dataset_fd = int(dataset_fd_raw)
        if not stat.S_ISDIR(os.fstat(dataset_fd).st_mode):
            raise RuntimeError("Harbor dataset descriptor is not a directory")
        os.fchdir(dataset_fd)

    from harbor.cli.main import app

    app()


def require_env(name: str) -> str:
    value = os.environ.pop(name, None)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    main()
