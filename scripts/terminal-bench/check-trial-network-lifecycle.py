from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path
from typing import Any


def install_harbor_stubs() -> None:
    modules = [
        "harbor",
        "harbor.agents",
        "harbor.agents.installed",
        "harbor.agents.installed.base",
        "harbor.environments",
        "harbor.environments.base",
        "harbor.environments.docker",
        "harbor.environments.docker.docker",
        "harbor.models",
        "harbor.models.agent",
        "harbor.models.agent.context",
        "harbor.models.trial",
        "harbor.models.trial.paths",
    ]
    for name in modules:
        sys.modules[name] = types.ModuleType(name)

    class BaseInstalledAgent:
        pass

    class BaseEnvironment:
        pass

    class DockerEnvironment:
        pass

    class AgentContext:
        pass

    class EnvironmentPaths:
        agent_dir = Path("/logs/agent")

    sys.modules["harbor.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent
    sys.modules["harbor.environments.base"].BaseEnvironment = BaseEnvironment
    docker_module = sys.modules["harbor.environments.docker.docker"]
    docker_module.DockerEnvironment = DockerEnvironment
    docker_module._sanitize_docker_compose_project_name = lambda value: value
    sys.modules["harbor.models.agent.context"].AgentContext = AgentContext
    sys.modules["harbor.models.trial.paths"].EnvironmentPaths = EnvironmentPaths


def load_adapter() -> Any:
    install_harbor_stubs()
    project_root = Path(__file__).resolve().parents[2]
    adapter_path = project_root / "benchmarks/terminal_bench_2_1/pico_agent.py"
    spec = importlib.util.spec_from_file_location("pico_agent_network_test", adapter_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeEnvironment:
    session_id = "trial-session"


class FakeDocker:
    def __init__(
        self,
        *,
        fail_gateway_create: bool = False,
        inspect_error: bytes | None = None,
    ) -> None:
        self.fail_gateway_create = fail_gateway_create
        self.inspect_error = inspect_error
        self.networks: dict[str, dict[str, Any]] = {}
        self.commands: list[list[str]] = []

    async def run(
        self,
        args: list[str],
        _environment: Any,
        *,
        allowed_exit_codes: set[int] = {0},
    ) -> tuple[int, bytes, bytes]:
        del allowed_exit_codes
        self.commands.append(args)
        if args[:2] == ["network", "create"]:
            network_name = args[-1]
            if self.fail_gateway_create and network_name.startswith("pico-tb-gw-"):
                return 1, b"", b"default address pools exhausted"
            run_id = args[args.index("--label") + 1].split("=", 1)[1]
            self.networks[network_name] = {
                "Name": network_name,
                "Internal": True,
                "Labels": {"pico.terminal-bench.run": run_id},
                "Containers": {},
            }
            return 0, network_name.encode(), b""
        if args[:2] == ["network", "inspect"]:
            if self.inspect_error is not None:
                return 1, b"", self.inspect_error
            names = args[2:]
            values = [self.networks[name] for name in names if name in self.networks]
            if len(values) != len(names):
                return 1, b"", b"No such network"
            return 0, json.dumps(values).encode(), b""
        if args[:2] == ["network", "disconnect"]:
            network_name = args[-2]
            container_id = args[-1]
            self.networks[network_name]["Containers"].pop(container_id, None)
            return 0, b"", b""
        if args[:2] == ["network", "rm"]:
            network_name = args[2]
            if network_name not in self.networks:
                return 1, b"", b"No such network"
            del self.networks[network_name]
            return 0, network_name.encode(), b""
        raise AssertionError(f"unexpected docker command: {args}")


def owned_network(run_id: str, *container_ids: str) -> dict[str, Any]:
    return {
        "Internal": True,
        "Labels": {"pico.terminal-bench.run": run_id},
        "Containers": {container_id: {} for container_id in container_ids},
    }


async def main() -> None:
    adapter = load_adapter()
    assert adapter.PicoInstalledAgent._POLICY_DENIAL_MODE == "incident"
    assert adapter.require_bounded_int(180_000, "bash_timeout_ms", 1_000, 300_000) == 180_000
    for invalid in (999, 300_001, 1.5, True, "180000.0", None):
        try:
            adapter.require_bounded_int(invalid, "bash_timeout_ms", 1_000, 300_000)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid bash timeout was accepted: {invalid!r}")

    environment = FakeEnvironment()
    run_id = "network-lifecycle-test"

    partial = FakeDocker(fail_gateway_create=True)
    adapter.run_docker = partial.run
    try:
        await adapter.isolate_container_network(environment, ["main"], run_id)
    except RuntimeError as error:
        assert str(error) == "Could not create the isolated trial network"
    else:
        raise AssertionError("partial network creation unexpectedly succeeded")
    assert partial.networks == {}
    assert any(command[:2] == ["network", "rm"] for command in partial.commands)

    repeated = FakeDocker()
    adapter.run_docker = repeated.run
    for sequence in range(13):
        networks = adapter.TrialNetworks(
            task=f"pico-tb-task-cycle-{sequence}",
            gateway=f"pico-tb-gw-cycle-{sequence}",
        )
        repeated.networks[networks.task] = owned_network(run_id, "main", "sidecar")
        repeated.networks[networks.gateway] = owned_network(run_id, "main")
        await adapter.remove_owned_trial_networks(environment, networks, run_id)
        assert repeated.networks == {}

    unowned = FakeDocker()
    adapter.run_docker = unowned.run
    networks = adapter.TrialNetworks(
        task="pico-tb-task-unowned",
        gateway="pico-tb-gw-unowned",
    )
    unowned.networks[networks.task] = owned_network("another-run", "main")
    unowned.networks[networks.gateway] = owned_network(run_id, "main")
    try:
        await adapter.remove_owned_trial_networks(environment, networks, run_id)
    except RuntimeError as error:
        assert networks.task in str(error)
    else:
        raise AssertionError("unowned network identity mismatch was accepted")
    assert networks.task in unowned.networks
    assert not any(
        command[:2] == ["network", "rm"] and command[2] == networks.task
        for command in unowned.commands
    )

    unavailable = FakeDocker(inspect_error=b"Cannot connect to the Docker daemon")
    adapter.run_docker = unavailable.run
    unavailable.networks[networks.task] = owned_network(run_id, "main")
    unavailable.networks[networks.gateway] = owned_network(run_id, "main")
    try:
        await adapter.remove_owned_trial_networks(environment, networks, run_id)
    except RuntimeError as error:
        assert networks.task in str(error)
        assert networks.gateway in str(error)
    else:
        raise AssertionError("Docker inspect failure was mistaken for an absent network")
    assert set(unavailable.networks) == {networks.task, networks.gateway}

    order: list[str] = []

    async def enable(_environment: Any) -> None:
        order.append("bridge")

    async def remove(
        _environment: Any,
        _networks: Any,
        _run_id: str,
    ) -> None:
        order.append("remove")

    adapter.enable_verifier_network = enable
    adapter.remove_owned_trial_networks = remove
    await adapter.restore_verifier_and_remove_trial_networks(
        environment,
        networks,
        run_id,
    )
    assert order == ["bridge", "remove"]
    print("Terminal-Bench trial network lifecycle passed.")


asyncio.run(main())
