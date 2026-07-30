from __future__ import annotations

import argparse
import json
import math
import tomllib
from pathlib import Path
from typing import Any

from benchmarks.terminal_bench_2_1.runtime_limits import (
    MAX_TASK_AGENT_TIMEOUT_SEC,
)


def require_supported_agent_timeout(config: dict[str, Any], task_name: str) -> float:
    agent = config.get("agent")
    timeout = agent.get("timeout_sec") if isinstance(agent, dict) else None
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
        or timeout > MAX_TASK_AGENT_TIMEOUT_SEC
    ):
        raise ValueError(
            f"{task_name} agent.timeout_sec must be finite, greater than zero, "
            f"and at most {MAX_TASK_AGENT_TIMEOUT_SEC} seconds"
        )
    return float(timeout)


def validate_dataset_task_timeouts(dataset_path: Path) -> dict[str, Any]:
    dataset = dataset_path.resolve(strict=True)
    if not dataset.is_dir():
        raise ValueError("Terminal-Bench timeout preflight requires a dataset directory")
    entries = sorted(dataset.iterdir(), key=lambda path: path.name)
    if not entries:
        raise ValueError("Terminal-Bench timeout preflight found no tasks")

    maximum_observed = 0.0
    for task_directory in entries:
        if task_directory.is_symlink() or not task_directory.is_dir():
            raise ValueError(
                f"Terminal-Bench dataset contains an invalid task entry: "
                f"{task_directory.name}"
            )
        task_config_path = task_directory / "task.toml"
        if task_config_path.is_symlink() or not task_config_path.is_file():
            raise ValueError(
                f"Terminal-Bench task is missing a regular task.toml: "
                f"{task_directory.name}"
            )
        with task_config_path.open("rb") as handle:
            config = tomllib.load(handle)
        maximum_observed = max(
            maximum_observed,
            require_supported_agent_timeout(config, task_directory.name),
        )

    return {
        "schemaVersion": 1,
        "taskCount": len(entries),
        "maximumObservedAgentTimeoutSec": maximum_observed,
        "supportedMaximumAgentTimeoutSec": MAX_TASK_AGENT_TIMEOUT_SEC,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    args = parser.parse_args()
    try:
        result = validate_dataset_task_timeouts(Path(args.dataset))
    except (OSError, ValueError) as error:
        parser.exit(1, f"Terminal-Bench timeout preflight failed: {error}\n")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
