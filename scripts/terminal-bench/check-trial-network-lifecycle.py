from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import sys
import tempfile
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
        "harbor.models.task",
        "harbor.models.task.verifier_mode",
        "harbor.models.trial",
        "harbor.models.trial.paths",
        "harbor.trial",
        "harbor.trial.single_step",
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
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    adapter_path = project_root / "benchmarks/terminal_bench_2_1/pico_agent.py"
    spec = importlib.util.spec_from_file_location("pico_agent_network_test", adapter_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def benchmark_route_config(
    output_token_field: str | None = "max_completion_tokens",
    output_tokens: Any = 8_192,
) -> dict[str, Any]:
    capability: dict[str, Any] = {"toolCall": True}
    if output_token_field is not None:
        capability["outputTokenField"] = output_token_field
    if output_tokens is not None:
        capability["output"] = output_tokens
    return {
        "schemaVersion": 1,
        "modelRouteId": "codex-oauth/gpt-5.4",
        "providerId": "codex-oauth",
        "provider": {
            "protocol": "openai",
            "baseURL": "http://pico-gateway:8080",
            "models": ["gpt-5.4"],
            "discoverModels": False,
            "modelCapabilities": {"gpt-5.4": capability},
        },
        "pricing": {},
        "pricingSha256": "0" * 64,
        "runBudget": {"currency": "CNY", "maxCostMicroCNY": 1_000_000},
    }


def compatible_route_config(
    output_tokens: Any = None,
    *,
    include_model_capability: bool = True,
    model: str = "compatible-model",
) -> dict[str, Any]:
    capability: dict[str, Any] = {"toolCall": True}
    if output_tokens is not None:
        capability["output"] = output_tokens
    provider: dict[str, Any] = {
        "protocol": "openai",
        "baseURL": "http://pico-gateway:8080",
        "models": [model],
        "discoverModels": False,
    }
    if include_model_capability:
        provider["modelCapabilities"] = {model: capability}
    return {
        "schemaVersion": 1,
        "modelRouteId": f"compatible-provider/{model}",
        "providerId": "compatible-provider",
        "provider": provider,
        "pricing": {},
        "pricingSha256": "0" * 64,
        "runBudget": {"currency": "CNY", "maxCostMicroCNY": 1_000_000},
    }


def assert_route_config_contract(adapter: Any) -> None:
    with tempfile.TemporaryDirectory(prefix="pico-route-contract-") as directory:
        path = Path(directory) / "route.json"
        valid = benchmark_route_config()
        path.write_text(json.dumps(valid))
        assert adapter.load_route_config(path) == valid
        assert (
            valid["provider"]["modelCapabilities"]["gpt-5.4"]["output"]
            == 8_192
        )

        for invalid_output, invalid_field in (
            (8_192, None),
            (8_192, "max_tokens"),
            (None, "max_completion_tokens"),
            (4_096, "max_completion_tokens"),
            (8_193, "max_completion_tokens"),
            (True, "max_completion_tokens"),
            ("8192", "max_completion_tokens"),
        ):
            path.write_text(
                json.dumps(
                    benchmark_route_config(
                        invalid_field,
                        output_tokens=invalid_output,
                    )
                )
            )
            try:
                adapter.load_route_config(path)
            except ValueError as error:
                assert str(error) == (
                    "codex-oauth/gpt-5.4 benchmark route must pin output=8192 "
                    "and use max_completion_tokens"
                )
            else:
                raise AssertionError(
                    "invalid output capability was accepted: "
                    f"{invalid_output!r}, {invalid_field!r}"
                )

        for compatible in (
            compatible_route_config(),
            compatible_route_config(include_model_capability=False),
            compatible_route_config(4_096),
            compatible_route_config(4_096, model="org/compatible-model"),
            compatible_route_config(200_000),
        ):
            path.write_text(json.dumps(compatible))
            assert adapter.load_route_config(path) == compatible


async def assert_bootstrap_output_projection(adapter: Any) -> None:
    class BootstrapFailureEnvironment:
        async def exec(self, **_kwargs: Any) -> Any:
            return types.SimpleNamespace(return_code=1, stdout="", stderr="")

    async def project(
        root: Path,
        name: str,
        route_config: dict[str, Any],
    ) -> dict[str, Any]:
        agent = object.__new__(adapter.PicoInstalledAgent)
        agent.logs_dir = root / name
        agent._shutdown_grace_ms = 30_000
        agent._result_flush_margin_ms = 5_000
        agent._bash_timeout_ms = 180_000
        loop = asyncio.get_running_loop()
        try:
            await agent._run_with_gateway(
                instruction="bootstrap output projection",
                environment=BootstrapFailureEnvironment(),
                context=types.SimpleNamespace(),
                gateway=types.SimpleNamespace(
                    base_url="http://pico-gateway:8080",
                    capability="pico-workload-identity",
                ),
                route_config=route_config,
                workspace="/workspace",
                pico_home="/tmp/pico-home",
                request_id="bootstrap-output-request",
                session_id="bootstrap-output-session",
                context_id="bootstrap-output-context",
                outer_timeout_sec=120,
                outer_deadline=loop.time() + 120,
                loop=loop,
                public_proxy_env={},
            )
        except RuntimeError as error:
            assert str(error) == "Pico isolated bootstrap failed"
        else:
            raise AssertionError("synthetic bootstrap failure unexpectedly succeeded")

        return json.loads(
            (agent.logs_dir / "bootstrap-request.json").read_text(encoding="utf-8")
        )

    with tempfile.TemporaryDirectory(prefix="pico-bootstrap-output-") as directory:
        root = Path(directory)
        exact = await project(root, "exact", benchmark_route_config())
        assert exact["route"] == {
            "id": "codex-oauth/gpt-5.4",
            "protocol": "openai",
            "baseURL": "http://pico-gateway:8080",
            "apiKeyEnv": "PICO_TB_GATEWAY_TOKEN",
            "output": 8_192,
        }
        for name, route_config in (
            ("configured-4096", compatible_route_config(4_096)),
            ("configured-32768", compatible_route_config(32_768)),
            ("configured-200000", compatible_route_config(200_000)),
            (
                "missing",
                compatible_route_config(include_model_capability=False),
            ),
        ):
            compatible = await project(root, name, route_config)
            assert compatible["route"] == {
                "id": "compatible-provider/compatible-model",
                "protocol": "openai",
                "baseURL": "http://pico-gateway:8080",
                "apiKeyEnv": "PICO_TB_GATEWAY_TOKEN",
            }


def assert_accounting_failure_messages(adapter: Any) -> None:
    class AccountingContext:
        def __init__(
            self,
            *,
            input_tokens: int = 2,
            output_tokens: int = 1,
            status: str = "completed",
            error_code: str | None = None,
            termination_confirmed: bool = True,
            cost_cny: int | float = 0.000003,
        ) -> None:
            self.n_input_tokens = input_tokens
            self.n_output_tokens = output_tokens
            self.metadata: dict[str, Any] = {
                "pico": {
                    "status": status,
                    "errorCode": error_code,
                    "terminationConfirmed": termination_confirmed,
                    "costCNY": cost_cny,
                }
            }

    def receipt(
        status: str,
        within_budget: bool,
        *,
        input_tokens: int = 2,
        output_tokens: int = 1,
    ) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "status": status,
            "withinBudget": within_budget,
            "pricingSha256": "0" * 64,
            "receiptSha256": "1" * 64,
            "actual": {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "costMicroCNY": 3,
                "costCNY": 0.000003,
            },
        }

    for value, expected in (
        (
            receipt("unreconciled", False),
            "Gateway accounting could not be reconciled",
        ),
        (
            receipt("reconciled", False),
            "Gateway usage exceeded the configured budget or quota",
        ),
    ):
        try:
            adapter.apply_gateway_accounting(AccountingContext(), value)
        except RuntimeError as error:
            assert str(error) == expected
        else:
            raise AssertionError(f"accounting failure was accepted: {expected}")

    matching = AccountingContext()
    adapter.apply_gateway_accounting(matching, receipt("reconciled", True))
    assert (matching.n_input_tokens, matching.n_output_tokens) == (2, 1)
    assert matching.metadata["pico"]["runtimeReportedUsage"] == {
        "promptTokens": 2,
        "completionTokens": 1,
        "costCNY": 0.000003,
    }
    assert matching.metadata["pico"]["gatewayAccounting"]["usageFallback"] is False
    assert matching.metadata["pico"]["gatewayAccounting"]["usageSource"] == "runtime"

    fallback = AccountingContext(
        input_tokens=0,
        output_tokens=0,
        status="failed",
        error_code="RUNTIME_FAILED",
        cost_cny=0,
    )
    adapter.apply_gateway_accounting(fallback, receipt("reconciled", True))
    assert (fallback.n_input_tokens, fallback.n_output_tokens) == (2, 1)
    assert fallback.metadata["pico"]["runtimeReportedUsage"] == {
        "promptTokens": 0,
        "completionTokens": 0,
        "costCNY": 0,
    }
    assert fallback.metadata["pico"]["gatewayAccounting"]["usageFallback"] is True
    assert (
        fallback.metadata["pico"]["gatewayAccounting"]["usageSource"]
        == "signed_gateway_actual"
    )

    rejected_contexts = (
        AccountingContext(input_tokens=0, output_tokens=0, cost_cny=0),
        AccountingContext(
            input_tokens=0,
            output_tokens=0,
            status="failed",
            error_code="RUNTIME_EMPTY_RESPONSE",
            cost_cny=0,
        ),
        AccountingContext(
            input_tokens=0,
            output_tokens=0,
            status="failed",
            error_code="RUNTIME_FAILED",
            termination_confirmed=False,
            cost_cny=0,
        ),
        AccountingContext(
            input_tokens=0,
            output_tokens=1,
            status="failed",
            error_code="RUNTIME_FAILED",
            cost_cny=0,
        ),
        AccountingContext(
            input_tokens=0,
            output_tokens=0,
            status="failed",
            error_code="RUNTIME_FAILED",
            cost_cny=0.000001,
        ),
    )
    for rejected in rejected_contexts:
        try:
            adapter.apply_gateway_accounting(
                rejected,
                receipt("reconciled", True),
            )
        except RuntimeError as error:
            assert str(error) == (
                "Gateway accounting tokens do not match runtime usage"
            )
        else:
            raise AssertionError(
                "non-qualifying gateway usage fallback unexpectedly succeeded"
            )

    for value, expected in (
        (
            receipt("unreconciled", True),
            "Gateway accounting could not be reconciled",
        ),
        (
            receipt("reconciled", False),
            "Gateway usage exceeded the configured budget or quota",
        ),
    ):
        rejected = AccountingContext(
            input_tokens=0,
            output_tokens=0,
            status="failed",
            error_code="RUNTIME_FAILED",
            cost_cny=0,
        )
        try:
            adapter.apply_gateway_accounting(rejected, value)
        except RuntimeError as error:
            assert str(error) == expected
        else:
            raise AssertionError(
                "gateway usage fallback bypassed an accounting gate"
            )
        assert (rejected.n_input_tokens, rejected.n_output_tokens) == (0, 0)
        gateway_metadata = rejected.metadata["pico"]["gatewayAccounting"]
        assert gateway_metadata["status"] == value["status"]
        assert gateway_metadata["withinBudget"] is value["withinBudget"]
        assert gateway_metadata["usageFallback"] is False
        assert gateway_metadata["usageSource"] == "runtime"


def assert_task_timeout_contract(adapter: Any) -> None:
    assert adapter.MAX_TASK_AGENT_TIMEOUT_SEC == 12_000
    assert adapter.MAX_TASK_VERIFIER_TIMEOUT_SEC == 12_000
    with tempfile.TemporaryDirectory(prefix="pico-task-timeout-") as directory:
        root = Path(directory)
        environment = types.SimpleNamespace(environment_dir=root / "environment")
        task_config = root / "task.toml"
        task_config.write_text(
            "[agent]\ntimeout_sec = 12000.0\n"
            "[verifier]\ntimeout_sec = 12000.0\n"
        )
        assert adapter.task_agent_timeout(environment) == 12_000
        assert adapter.task_verifier_timeout(environment) == 12_000

        for invalid in ("12000.001", "nan", "true", '"12000"'):
            task_config.write_text(
                f"[agent]\ntimeout_sec = {invalid}\n"
                "[verifier]\ntimeout_sec = 60\n"
            )
            try:
                adapter.task_agent_timeout(environment)
            except RuntimeError as error:
                assert str(error) == (
                    "Terminal-Bench task timeout is unsupported by Pico"
                )
            else:
                raise AssertionError(
                    f"unsupported task timeout was accepted: {invalid}"
                )
            task_config.write_text(
                "[agent]\ntimeout_sec = 60\n"
                f"[verifier]\ntimeout_sec = {invalid}\n"
            )
            try:
                adapter.task_verifier_timeout(environment)
            except RuntimeError as error:
                assert str(error) == (
                    "Terminal-Bench verifier timeout is unsupported by Pico"
                )
            else:
                raise AssertionError(
                    f"unsupported verifier timeout was accepted: {invalid}"
                )

    gateway = adapter.ProviderGateway(
        protocol="openai",
        supervisor_socket="/unused",
        capability_seed="a" * 64,
        run_id="timeout-contract",
        network_name="timeout-network",
        context_id="timeout-trial",
        ttl_sec=12_000,
        pricing_sha256="b" * 64,
        receipt_path=Path("/unused"),
    )
    gateway._supervisor_request = lambda value: value
    signed = gateway._signed_supervisor_request(
        {"action": "revoke", "trialId": "timeout-trial"}
    )
    assert signed["auth"]["expiresAt"] - signed["auth"]["issuedAt"] == 12_000


async def assert_verifier_runtime_contract() -> None:
    runtime = importlib.import_module(
        "benchmarks.terminal_bench_2_1.harbor_runtime"
    )

    class DockerEnvironment:
        def __init__(self) -> None:
            self._persistent_env = {"PERSISTENT": "present"}
            self._overlays: list[dict[str, str]] = []
            self.exec_envs: list[dict[str, str]] = []

        @contextlib.contextmanager
        def scoped_exec_env(self, env: dict[str, str]) -> Any:
            self._overlays.append(dict(env))
            try:
                yield
            finally:
                self._overlays.pop()

        async def exec(
            self,
            command: str,
            cwd: str | None = None,
            env: dict[str, str] | None = None,
            timeout_sec: int | None = None,
            user: str | int | None = None,
        ) -> dict[str, Any]:
            del command, cwd, timeout_sec, user
            merged = {**self._persistent_env, **(env or {})}
            for overlay in self._overlays:
                merged.update(overlay)
            self.exec_envs.append(merged)
            return {"env": merged}

        def _compose_env_vars(self) -> dict[str, str]:
            return dict(self._persistent_env)

    DockerEnvironment.__module__ = "harbor.environments.docker.docker"
    runtime.install_verifier_exec_env_overlay(DockerEnvironment)
    runtime.install_verifier_exec_env_overlay(DockerEnvironment)
    environment = DockerEnvironment()
    token = "verifier-token-value"
    proxy_url = f"http://pico:{token}@pico-egress:8081"
    proxy_env = {
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "http_proxy": proxy_url,
        "https_proxy": proxy_url,
        "NO_PROXY": "pico-gateway,main,localhost,127.0.0.1,::1",
        "no_proxy": "pico-gateway,main,localhost,127.0.0.1,::1",
    }
    runtime.set_verifier_exec_env(environment, proxy_env)
    result = await environment.exec(
        "true",
        env={"HTTP_PROXY": "http://attacker.invalid", "CUSTOM": "value"},
    )
    assert result["env"]["HTTP_PROXY"] == proxy_url
    assert result["env"]["CUSTOM"] == "value"
    assert environment._compose_env_vars() == {"PERSISTENT": "present"}
    assert token not in json.dumps(environment._compose_env_vars())
    runtime.clear_verifier_exec_env(environment)
    result = await environment.exec(
        "true",
        env={"HTTP_PROXY": "http://ordinary.invalid"},
    )
    assert result["env"]["HTTP_PROXY"] == "http://ordinary.invalid"

    async def incompatible_exec(self: Any, command: str, *, extra: str) -> None:
        del self, command, extra

    IncompatibleDocker = type(
        "DockerEnvironment",
        (),
        {"exec": incompatible_exec},
    )
    IncompatibleDocker.__module__ = "harbor.environments.docker.docker"
    try:
        runtime.install_verifier_exec_env_overlay(IncompatibleDocker)
    except RuntimeError as error:
        assert str(error) == "Harbor Docker exec signature is unsupported"
    else:
        raise AssertionError("unsupported Harbor Docker exec signature was patched")

    class SingleStepTrial:
        async def _run_verifier(self) -> str:
            self.events.append("verifier")
            return "verified"

    SingleStepTrial.__module__ = "harbor.trial.single_step"

    class VerifierEnvironmentMode:
        SHARED = "shared"
        SEPARATE = "separate"

    verifier_mode_module = sys.modules["harbor.models.task.verifier_mode"]
    verifier_mode_module.VerifierEnvironmentMode = VerifierEnvironmentMode
    verifier_mode_module.resolve_task_verifier_mode = lambda config: config.mode
    runtime.install_verifier_phase_activation(SingleStepTrial)
    runtime.install_verifier_phase_activation(SingleStepTrial)

    for disabled, mode, expected in (
        (False, VerifierEnvironmentMode.SHARED, ["activate", "verifier"]),
        (True, VerifierEnvironmentMode.SHARED, ["verifier"]),
        (False, VerifierEnvironmentMode.SEPARATE, ["verifier"]),
    ):
        trial_environment = types.SimpleNamespace()
        events: list[str] = []

        async def activate(events: list[str] = events) -> None:
            events.append("activate")

        runtime.register_verifier_egress_activation(
            trial_environment,
            activate,
        )
        trial = SingleStepTrial()
        trial.config = types.SimpleNamespace(
            verifier=types.SimpleNamespace(disable=disabled)
        )
        trial.task = types.SimpleNamespace(config=types.SimpleNamespace(mode=mode))
        trial.agent_environment = trial_environment
        trial.events = events
        assert await trial._run_verifier() == "verified"
        assert events == expected
        runtime.clear_verifier_egress_activation(trial_environment)

    async def incompatible_run_verifier(
        self: Any,
        unexpected: str,
    ) -> None:
        del self, unexpected

    IncompatibleTrial = type(
        "SingleStepTrial",
        (),
        {"_run_verifier": incompatible_run_verifier},
    )
    IncompatibleTrial.__module__ = "harbor.trial.single_step"
    try:
        runtime.install_verifier_phase_activation(IncompatibleTrial)
    except RuntimeError as error:
        assert str(error) == "Harbor verifier lifecycle signature is unsupported"
    else:
        raise AssertionError("unsupported Harbor verifier signature was patched")


class FakeEnvironment:
    session_id = "trial-session"
    default_user = "root"
    environment_dir = Path("/tmp/pico-fake-task/environment")
    _docker_compose_paths: list[Path] = []

    @staticmethod
    def _compose_env_vars(*, include_os_env: bool) -> dict[str, str]:
        assert include_os_env is False
        return {}


class FakeDocker:
    def __init__(
        self,
        *,
        fail_gateway_create: bool = False,
        inspect_error: bytes | None = None,
        fail_relay_connect: bool = False,
        fail_relay_remove: bool = False,
        pause_relay_connect: asyncio.Event | None = None,
    ) -> None:
        self.fail_gateway_create = fail_gateway_create
        self.inspect_error = inspect_error
        self.fail_relay_connect = fail_relay_connect
        self.fail_relay_remove = fail_relay_remove
        self.pause_relay_connect = pause_relay_connect
        self.networks: dict[str, dict[str, Any]] = {}
        self.containers: dict[str, dict[str, Any]] = {}
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
        if args[0] == "run":
            relay_name = args[args.index("--name") + 1]
            network_name = args[args.index("--network") + 1]
            network_alias = args[args.index("--network-alias") + 1]
            labels = {
                item.split("=", 1)[0]: item.split("=", 1)[1]
                for index, item in enumerate(args)
                if index > 0 and args[index - 1] == "--label"
            }
            image_index = args.index(
                "sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37"
            )
            self.containers[relay_name] = {
                "Name": f"/{relay_name}",
                "Image": args[image_index],
                "State": {"Running": True},
                "Config": {
                    "Labels": labels,
                    "Cmd": args[image_index + 1 :],
                    "ExposedPorts": None,
                    "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
                    "User": args[args.index("--user") + 1],
                },
                "HostConfig": {
                    "Binds": None,
                    "Mounts": None,
                    "Privileged": False,
                    "CapAdd": None,
                    "CapDrop": ["ALL"],
                    "ReadonlyRootfs": True,
                    "SecurityOpt": ["no-new-privileges"],
                    "Memory": 67_108_864,
                    "PidsLimit": 64,
                    "NetworkMode": network_name,
                    "Devices": None,
                    "PortBindings": None,
                },
                "Mounts": [],
                "NetworkSettings": {
                    "Networks": {
                        network_name: {
                            "Aliases": [relay_name, network_alias],
                        }
                    }
                },
            }
            return 0, b"relay-id", b""
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
        if args[:2] == ["network", "connect"]:
            network_name = args[-2]
            container_name = args[-1]
            if (
                network_name == "bridge"
                and container_name in self.containers
                and self.pause_relay_connect is not None
            ):
                await self.pause_relay_connect.wait()
            if (
                network_name == "bridge"
                and container_name in self.containers
                and self.fail_relay_connect
            ):
                raise RuntimeError("Docker command failed: network connect")
            aliases = [container_name]
            if "--alias" in args:
                aliases.append(args[args.index("--alias") + 1])
            self.containers[container_name]["NetworkSettings"]["Networks"][
                network_name
            ] = {"Aliases": aliases}
            if network_name in self.networks:
                self.networks[network_name]["Containers"][container_name] = {}
            return 0, b"", b""
        if args[:2] == ["network", "inspect"]:
            if self.inspect_error is not None:
                return 1, b"", self.inspect_error
            names = args[2:]
            values = [self.networks[name] for name in names if name in self.networks]
            if len(values) != len(names):
                return 1, b"", b"No such network"
            return 0, json.dumps(values).encode(), b""
        if args[:2] == ["inspect", "--format"]:
            container_name = args[-1]
            if container_name not in self.containers:
                return 1, b"", b"No such container"
            return 0, self.containers[container_name]["Image"].encode(), b""
        if args[0] == "inspect":
            container_names = args[1:]
            if any(name not in self.containers for name in container_names):
                return 1, b"", b"Error: No such object"
            return (
                0,
                json.dumps([self.containers[name] for name in container_names]).encode(),
                b"",
            )
        if args[:2] == ["network", "disconnect"]:
            network_name = args[-2]
            container_id = args[-1]
            self.networks[network_name]["Containers"].pop(container_id, None)
            if container_id in self.containers:
                self.containers[container_id]["NetworkSettings"]["Networks"].pop(
                    network_name,
                    None,
                )
            return 0, b"", b""
        if args[:2] == ["network", "rm"]:
            network_name = args[2]
            if network_name not in self.networks:
                return 1, b"", b"No such network"
            del self.networks[network_name]
            return 0, network_name.encode(), b""
        if args[:2] == ["rm", "--force"]:
            container_name = args[2]
            if container_name not in self.containers:
                return 1, b"", b"No such container"
            if self.fail_relay_remove:
                return 1, b"", b"synthetic relay remove failure"
            for network in self.networks.values():
                network["Containers"].pop(container_name, None)
            del self.containers[container_name]
            return 0, container_name.encode(), b""
        raise AssertionError(f"unexpected docker command: {args}")


def owned_network(run_id: str, *container_ids: str) -> dict[str, Any]:
    return {
        "Internal": True,
        "Labels": {"pico.terminal-bench.run": run_id},
        "Containers": {container_id: {} for container_id in container_ids},
    }


def named_owned_network(
    name: str,
    run_id: str,
    *container_ids: str,
) -> dict[str, Any]:
    network = owned_network(run_id, *container_ids)
    network["Name"] = name
    return network


def workload_container(
    container_id: str,
    service: str,
    initial_network: str,
) -> dict[str, Any]:
    return {
        "Id": container_id,
        "Config": {
            "Labels": {
                "com.docker.compose.service": service,
            }
        },
        "NetworkSettings": {
            "Networks": {
                initial_network: {
                    "Aliases": [container_id, service],
                }
            }
        },
    }


class FakePublicEgressProxy:
    instances: list[FakePublicEgressProxy] = []
    fail_stop = False

    def __init__(
        self,
        *,
        token: str,
        ttl_sec: float,
        max_connections: int,
        max_requests: int,
        max_total_bytes: int,
    ) -> None:
        self.token = token
        self.ttl_sec = ttl_sec
        self.max_connections = max_connections
        self.max_requests = max_requests
        self.max_total_bytes = max_total_bytes
        self.started = 0
        self.revoked = 0
        self.stopped = 0
        self.instances.append(self)

    def start(self) -> int:
        self.started += 1
        return 45_678

    def revoke(self) -> None:
        self.revoked += 1

    def stop(self) -> dict[str, Any]:
        assert self.revoked > 0
        self.stopped += 1
        if self.fail_stop:
            raise RuntimeError("synthetic public proxy stop failure")
        return {
            "schemaVersion": 1,
            "started": 1.0,
            "stopped": 2.0,
            "allowed": 0,
            "denied": 0,
            "bytes": {
                "clientToUpstream": 0,
                "upstreamToClient": 0,
                "total": 0,
            },
            "decisions": [],
            "decisionsTruncated": 0,
        }


def task_environment(allow_internet: str) -> Any:
    directory = tempfile.TemporaryDirectory(prefix="pico-egress-task-")
    root = Path(directory.name)
    (root / "task.toml").write_text(
        "[agent]\ntimeout_sec = 60\n"
        "[verifier]\ntimeout_sec = 60\n"
        f"[environment]\nallow_internet = {allow_internet}\n"
    )
    environment = types.SimpleNamespace(environment_dir=root / "environment")
    environment._temporary_directory = directory
    return environment


async def assert_public_egress_lifecycle(adapter: Any, run_id: str) -> None:
    FakePublicEgressProxy.instances.clear()
    FakePublicEgressProxy.fail_stop = False
    environment = FakeEnvironment()
    module_name = "benchmarks.terminal_bench_2_1.public_egress"
    sys.modules.pop(module_name, None)

    false_environment = task_environment("false")
    false_access = adapter.public_egress_access_for_task(
        false_environment,
        run_id=run_id,
        network_name="pico-tb-gw-false",
        context_id="public-egress-false",
        ttl_sec=120,
        receipt_path=Path("/unused"),
    )
    assert false_access is None
    assert module_name not in sys.modules
    assert FakePublicEgressProxy.instances == []

    public_egress_module = types.ModuleType(module_name)
    public_egress_module.PublicEgressProxy = FakePublicEgressProxy
    sys.modules[module_name] = public_egress_module
    true_environment = task_environment("true")
    assert adapter.task_allows_internet(true_environment) is True
    with tempfile.TemporaryDirectory(prefix="pico-egress-missing-") as directory:
        root = Path(directory)
        (root / "task.toml").write_text("[agent]\ntimeout_sec = 60\n")
        try:
            adapter.task_allows_internet(
                types.SimpleNamespace(environment_dir=root / "environment")
            )
        except RuntimeError as error:
            assert str(error) == "Terminal-Bench task environment policy is missing"
        else:
            raise AssertionError("missing allow_internet policy was accepted")
    for invalid in ("1", '"true"', "[]"):
        invalid_environment = task_environment(invalid)
        try:
            adapter.task_allows_internet(invalid_environment)
        except RuntimeError as error:
            assert str(error) == (
                "Terminal-Bench environment.allow_internet must be a boolean"
            )
        else:
            raise AssertionError(f"invalid allow_internet was accepted: {invalid}")
    with tempfile.TemporaryDirectory(prefix="pico-egress-receipt-") as directory:
        docker = FakeDocker()
        docker.networks["pico-tb-gw-public"] = named_owned_network(
            "pico-tb-gw-public",
            run_id,
        )
        adapter.run_docker = docker.run
        access = adapter.public_egress_access_for_task(
            true_environment,
            run_id=run_id,
            network_name="pico-tb-gw-public",
            context_id="public-egress-success",
            ttl_sec=120,
            receipt_path=Path(directory) / "public-egress-receipt.json",
        )
        assert access is not None
        await access.start(environment)
        proxy = FakePublicEgressProxy.instances[-1]
        assert proxy.started == 1
        assert len(proxy.token) == 64
        assert all(character in "0123456789abcdef" for character in proxy.token)
        assert proxy.ttl_sec == 120
        assert proxy.max_connections == 32
        assert proxy.max_requests == 4_096
        assert proxy.max_total_bytes == 1_073_741_824
        proxy_env = access.container_env
        assert set(proxy_env) == {
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
        }
        forwarded_urls = {
            proxy_env[name]
            for name in proxy_env
            if "PROXY" in name.upper() and "NO_" not in name.upper()
        }
        assert len(forwarded_urls) == 1
        assert proxy_env["HTTP_PROXY"] == (
            f"http://pico:{proxy.token}@pico-egress:8081"
        )
        assert "pico-gateway" in proxy_env["NO_PROXY"].split(",")
        assert "main" in proxy_env["NO_PROXY"].split(",")
        assert len(docker.containers) == 1
        relay = next(iter(docker.containers.values()))
        assert set(relay["NetworkSettings"]["Networks"]) == {
            "pico-tb-gw-public",
            "bridge",
        }
        assert relay["Mounts"] == []
        assert relay["Config"]["User"] == "65534:65534"
        assert relay["HostConfig"]["CapAdd"] is None
        assert relay["HostConfig"]["Memory"] == 67_108_864
        assert relay["HostConfig"]["PidsLimit"] == 64
        assert relay["HostConfig"]["NetworkMode"] == "pico-tb-gw-public"
        assert proxy.token not in json.dumps(relay)
        await access.stop(environment)
        await access.stop(environment)
        assert proxy.revoked == 1
        assert proxy.stopped == 1
        assert access._token == ""
        assert docker.containers == {}
        try:
            await access.start(environment)
        except RuntimeError as error:
            assert str(error) == "Public egress was already started"
        else:
            raise AssertionError("revoked public egress capability was restarted")
        receipt = json.loads(
            (Path(directory) / "public-egress-receipt.json").read_text()
        )
        assert receipt["schemaVersion"] == 1
        assert receipt["bytes"]["total"] == 0

    half_started = FakeDocker(fail_relay_connect=True)
    half_started.networks["pico-tb-gw-half"] = named_owned_network(
        "pico-tb-gw-half",
        run_id,
    )
    adapter.run_docker = half_started.run
    with tempfile.TemporaryDirectory(prefix="pico-egress-half-") as directory:
        access = adapter.PublicEgressAccess(
            run_id=run_id,
            network_name="pico-tb-gw-half",
            context_id="public-egress-half-start",
            ttl_sec=120,
            receipt_path=Path(directory) / "public-egress-receipt.json",
        )
        try:
            await access.start(environment)
        except RuntimeError as error:
            assert "network connect" in str(error)
        else:
            raise AssertionError("half-started relay unexpectedly succeeded")
        await access.stop(environment)
        assert half_started.containers == {}
        assert FakePublicEgressProxy.instances[-1].stopped == 1

    cancellation_gate = asyncio.Event()
    cancelled_docker = FakeDocker(pause_relay_connect=cancellation_gate)
    cancelled_docker.networks["pico-tb-gw-cancel"] = named_owned_network(
        "pico-tb-gw-cancel",
        run_id,
    )
    adapter.run_docker = cancelled_docker.run
    with tempfile.TemporaryDirectory(prefix="pico-egress-cancel-") as directory:
        access = adapter.PublicEgressAccess(
            run_id=run_id,
            network_name="pico-tb-gw-cancel",
            context_id="public-egress-cancel",
            ttl_sec=120,
            receipt_path=Path(directory) / "public-egress-receipt.json",
        )
        start_task = asyncio.create_task(access.start(environment))
        while not cancelled_docker.containers:
            await asyncio.sleep(0)
        start_task.cancel()
        try:
            await start_task
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("cancelled relay startup did not propagate cancellation")
        await access.stop(environment)
        assert cancelled_docker.containers == {}
        assert FakePublicEgressProxy.instances[-1].stopped == 1

    stop_failure = FakeDocker()
    stop_failure.networks["pico-tb-gw-stop"] = named_owned_network(
        "pico-tb-gw-stop",
        run_id,
    )
    adapter.run_docker = stop_failure.run
    with tempfile.TemporaryDirectory(prefix="pico-egress-stop-") as directory:
        access = adapter.PublicEgressAccess(
            run_id=run_id,
            network_name="pico-tb-gw-stop",
            context_id="public-egress-stop",
            ttl_sec=120,
            receipt_path=Path(directory) / "public-egress-receipt.json",
        )
        await access.start(environment)
        FakePublicEgressProxy.fail_stop = True
        try:
            await access.stop(environment)
        except RuntimeError as error:
            assert str(error) == "Could not stop public egress cleanly"
        else:
            raise AssertionError("proxy stop failure unexpectedly succeeded")
        finally:
            FakePublicEgressProxy.fail_stop = False
        assert stop_failure.containers == {}
        assert access._proxy is not None
        await access.stop(environment)
        assert FakePublicEgressProxy.instances[-1].stopped == 2
        assert access._proxy is None

    relay_remove_failure = FakeDocker(fail_relay_remove=True)
    relay_remove_failure.networks["pico-tb-gw-remove"] = named_owned_network(
        "pico-tb-gw-remove",
        run_id,
    )
    adapter.run_docker = relay_remove_failure.run
    with tempfile.TemporaryDirectory(prefix="pico-egress-remove-") as directory:
        access = adapter.PublicEgressAccess(
            run_id=run_id,
            network_name="pico-tb-gw-remove",
            context_id="public-egress-remove",
            ttl_sec=120,
            receipt_path=Path(directory) / "public-egress-receipt.json",
        )
        await access.start(environment)
        proxy = FakePublicEgressProxy.instances[-1]
        try:
            await access.stop(environment)
        except RuntimeError as error:
            assert str(error) == "Could not stop public egress cleanly"
        else:
            raise AssertionError("relay removal failure unexpectedly succeeded")
        assert proxy.revoked == 1
        assert proxy.stopped == 0
        assert access._proxy is proxy
        assert access._token
        assert relay_remove_failure.containers
        relay_remove_failure.fail_relay_remove = False
        await access.stop(environment)
        assert proxy.revoked == 2
        assert proxy.stopped == 1
        assert access._proxy is None
        assert access._token == ""
        assert relay_remove_failure.containers == {}


async def assert_container_proxy_env_injection(adapter: Any) -> None:
    commands: list[tuple[str, ...]] = []
    host_environments: list[dict[str, str]] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self, *, input: bytes) -> tuple[bytes, bytes]:
            assert input.startswith(b"00000006\n")
            return b"", b""

    async def create_subprocess_exec(
        *command: str,
        **kwargs: Any,
    ) -> FakeProcess:
        commands.append(command)
        host_environments.append(dict(kwargs["env"]))
        return FakeProcess()

    adapter.assert_secure_docker_environment = lambda _environment: None
    adapter.asyncio.create_subprocess_exec = create_subprocess_exec
    environment = FakeEnvironment()
    proxy_url = f"http://pico:{'ab' * 32}@pico-egress:8081"
    proxy_env = {
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "http_proxy": proxy_url,
        "https_proxy": proxy_url,
        "NO_PROXY": "pico-gateway,main,localhost,127.0.0.1,::1",
        "no_proxy": "pico-gateway,main,localhost,127.0.0.1,::1",
    }
    await adapter.docker_exec_secret_stdin(
        environment,
        b"secret",
        timeout_sec=5,
        secret_env_names={"PICO_TB_GATEWAY_TOKEN"},
        container_env=proxy_env,
    )
    command = list(commands[-1])
    assert [
        "-e",
        (
            f"{adapter._AGENT_CONTROLLED_PROXY_GATE_ENV}="
            f"{adapter._AGENT_CONTROLLED_PROXY_GATE_ENABLED}"
        ),
    ] in [command[index : index + 2] for index in range(len(command) - 1)]
    for name, value in proxy_env.items():
        assert ["-e", f"{name}={value}"] in [
            command[index : index + 2] for index in range(len(command) - 1)
        ]
    assert command.index("main") > max(
        index for index, item in enumerate(command) if item == "-e"
    )
    assert not set(host_environments[-1]) & (
        set(proxy_env) | {adapter._AGENT_CONTROLLED_PROXY_GATE_ENV}
    )

    for invalid_proxy_env in (
        {name: value for name, value in proxy_env.items() if name != "no_proxy"},
        {
            **proxy_env,
            "HTTP_PROXY": f"http://pico:{'ab' * 32}@untrusted-proxy:8081",
        },
        {**proxy_env, "NO_PROXY": "*", "no_proxy": "*"},
        {**proxy_env, adapter._AGENT_CONTROLLED_PROXY_GATE_ENV: "attacker-value"},
    ):
        command_count = len(commands)
        try:
            await adapter.docker_exec_secret_stdin(
                environment,
                b"secret",
                timeout_sec=5,
                secret_env_names={"PICO_TB_GATEWAY_TOKEN"},
                container_env=invalid_proxy_env,
            )
        except RuntimeError as error:
            assert str(error) in {
                "Container public proxy environment is incomplete",
                "Container public proxy environment is invalid",
            }
        else:
            raise AssertionError("invalid agent controlled proxy environment was accepted")
        assert len(commands) == command_count

    await adapter.docker_exec_secret_stdin(
        environment,
        b"secret",
        timeout_sec=5,
        secret_env_names={"PICO_TB_GATEWAY_TOKEN"},
        container_env={},
    )
    disabled_command = list(commands[-1])
    assert [
        "-e",
        (
            f"{adapter._AGENT_CONTROLLED_PROXY_GATE_ENV}="
            f"{adapter._AGENT_CONTROLLED_PROXY_GATE_DISABLED}"
        ),
    ] in [
        disabled_command[index : index + 2]
        for index in range(len(disabled_command) - 1)
    ]
    for name in proxy_env:
        assert not any(
            item.startswith(f"{name}=")
            for item in disabled_command
        )


async def assert_verifier_lifecycle_contract(adapter: Any) -> None:
    adapter.assert_secure_docker_environment = lambda _environment: None
    events: list[str] = []

    async def topology(
        _environment: Any,
        *,
        networks: Any,
        run_id: str,
        verifier_egress: Any,
    ) -> None:
        del networks, run_id, verifier_egress
        events.append("topology")

    async def remove(
        _environment: Any,
        _networks: Any,
        _run_id: str,
    ) -> None:
        events.append("networks")

    adapter.assert_verifier_egress_topology = topology
    adapter.restore_verifier_and_remove_trial_networks = remove
    proxy_url = "http://pico:verifier-token@pico-egress:8081"

    class LifecycleAccess:
        def __init__(
            self,
            *,
            fail_start: bool = False,
            fail_stop: bool = False,
            stop_started: asyncio.Event | None = None,
            stop_release: asyncio.Event | None = None,
        ) -> None:
            self.fail_start = fail_start
            self.fail_stop = fail_stop
            self.stop_started = stop_started
            self.stop_release = stop_release
            self.start_calls = 0
            self.stop_calls = 0

        @property
        def container_env(self) -> dict[str, str]:
            return {
                "HTTP_PROXY": proxy_url,
                "HTTPS_PROXY": proxy_url,
                "http_proxy": proxy_url,
                "https_proxy": proxy_url,
                "NO_PROXY": "pico-gateway,main,localhost,127.0.0.1,::1",
                "no_proxy": "pico-gateway,main,localhost,127.0.0.1,::1",
            }

        async def start(self, _environment: Any) -> None:
            self.start_calls += 1
            events.append("start")
            if self.fail_start:
                raise RuntimeError("synthetic verifier activation failure")

        async def stop(self, _environment: Any) -> None:
            self.stop_calls += 1
            events.append("egress")
            if self.stop_started is not None:
                self.stop_started.set()
            if self.stop_release is not None:
                await self.stop_release.wait()
            if self.fail_stop:
                raise RuntimeError("synthetic verifier stop failure")

    class LifecycleEnvironment:
        def __init__(self, *, fail_original_stop: bool = False) -> None:
            self.original_stop_calls = 0
            self.fail_original_stop = fail_original_stop

        async def stop(self, *, delete: bool) -> None:
            assert delete is True
            self.original_stop_calls += 1
            events.append("original")
            if self.fail_original_stop:
                raise RuntimeError("synthetic original stop failure")

    networks = adapter.TrialNetworks("task-network", "gateway-network")
    environment = LifecycleEnvironment()
    access = LifecycleAccess()
    adapter.install_verifier_egress_lifecycle(
        environment,
        networks=networks,
        run_id="verifier-lifecycle",
        verifier_egress=access,
    )
    assert access.start_calls == 0
    assert not hasattr(
        environment,
        "_pico_terminal_bench_verifier_exec_env",
    )
    await adapter.activate_verifier_egress(environment)
    await adapter.activate_verifier_egress(environment)
    assert access.start_calls == 1
    assert events[:2] == ["start", "topology"]
    first_stop = asyncio.create_task(environment.stop(delete=True))
    second_stop = asyncio.create_task(environment.stop(delete=True))
    await asyncio.gather(first_stop, second_stop)
    await environment.stop(delete=True)
    assert access.stop_calls == 1
    assert environment.original_stop_calls == 1
    assert events == ["start", "topology", "egress", "networks", "original"]
    assert not hasattr(
        environment,
        "_pico_terminal_bench_verifier_activation",
    )
    assert not hasattr(
        environment,
        "_pico_terminal_bench_verifier_exec_env",
    )

    events.clear()
    failing_environment = LifecycleEnvironment(fail_original_stop=True)
    failing_access = LifecycleAccess(fail_stop=True)

    async def failing_remove(
        _environment: Any,
        _networks: Any,
        _run_id: str,
    ) -> None:
        events.append("networks")
        raise RuntimeError("synthetic network cleanup failure")

    adapter.restore_verifier_and_remove_trial_networks = failing_remove
    adapter.install_verifier_egress_lifecycle(
        failing_environment,
        networks=networks,
        run_id="verifier-lifecycle-failure",
        verifier_egress=failing_access,
    )
    try:
        await failing_environment.stop(delete=True)
    except RuntimeError as error:
        assert str(error) == "Terminal-Bench verifier egress cleanup failed"
    else:
        raise AssertionError("verifier cleanup failures unexpectedly succeeded")
    assert failing_access.start_calls == 0
    assert failing_access.stop_calls == 1
    assert failing_environment.original_stop_calls == 1
    assert events == ["egress", "networks", "original"]

    events.clear()
    stop_started = asyncio.Event()
    stop_release = asyncio.Event()
    cancelled_environment = LifecycleEnvironment()
    cancelled_access = LifecycleAccess(
        stop_started=stop_started,
        stop_release=stop_release,
    )
    adapter.restore_verifier_and_remove_trial_networks = remove
    adapter.install_verifier_egress_lifecycle(
        cancelled_environment,
        networks=networks,
        run_id="verifier-lifecycle-cancel",
        verifier_egress=cancelled_access,
    )
    cancelled_stop = asyncio.create_task(
        cancelled_environment.stop(delete=True)
    )
    await stop_started.wait()
    cancelled_stop.cancel()
    stop_release.set()
    try:
        await cancelled_stop
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("cancelled verifier cleanup did not propagate")
    assert cancelled_access.stop_calls == 1
    assert cancelled_environment.original_stop_calls == 1
    assert events == ["egress", "networks", "original"]
    await cancelled_environment.stop(delete=True)
    assert cancelled_environment.original_stop_calls == 1

    events.clear()
    activation_failure_environment = LifecycleEnvironment()
    activation_failure_access = LifecycleAccess(fail_start=True)
    adapter.install_verifier_egress_lifecycle(
        activation_failure_environment,
        networks=networks,
        run_id="verifier-activation-failure",
        verifier_egress=activation_failure_access,
    )
    try:
        await adapter.activate_verifier_egress(
            activation_failure_environment
        )
    except RuntimeError as error:
        assert str(error) == "synthetic verifier activation failure"
    else:
        raise AssertionError("verifier activation failure unexpectedly succeeded")
    assert activation_failure_access.stop_calls == 1
    await activation_failure_environment.stop(delete=True)
    assert activation_failure_access.stop_calls == 2
    assert activation_failure_environment.original_stop_calls == 1


async def main() -> None:
    adapter = load_adapter()
    await assert_verifier_runtime_contract()
    assert_route_config_contract(adapter)
    assert_accounting_failure_messages(adapter)
    assert_task_timeout_contract(adapter)
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

    exact = FakeDocker()
    initial_network = "trial-session-default"
    main_id = "main-workload"
    sidecar_id = "task-sidecar"
    exact.containers[main_id] = workload_container(
        main_id,
        "main",
        initial_network,
    )
    exact.containers[sidecar_id] = workload_container(
        sidecar_id,
        "sidecar",
        initial_network,
    )
    exact.networks[initial_network] = {
        "Internal": True,
        "Labels": {
            "pico.terminal-bench.run": run_id,
            "com.docker.compose.project": environment.session_id,
        },
        "Containers": {
            main_id: {},
            sidecar_id: {},
        },
    }
    adapter.run_docker = exact.run
    isolated_networks = await adapter.isolate_container_network(
        environment,
        [main_id, sidecar_id],
        run_id,
    )
    assert set(exact.containers[main_id]["NetworkSettings"]["Networks"]) == {
        isolated_networks.task,
        isolated_networks.gateway,
    }
    assert set(exact.containers[sidecar_id]["NetworkSettings"]["Networks"]) == {
        isolated_networks.task,
    }
    assert not any(
        command[:3] == ["network", "connect", "bridge"]
        and command[-1] in {main_id, sidecar_id}
        for command in exact.commands
    )
    await adapter.restore_verifier_and_remove_trial_networks(
        environment,
        isolated_networks,
        run_id,
    )
    assert exact.containers[main_id]["NetworkSettings"]["Networks"] == {}
    assert exact.containers[sidecar_id]["NetworkSettings"]["Networks"] == {}
    assert set(exact.networks) == {initial_network}

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

    async def remove(
        _environment: Any,
        _networks: Any,
        _run_id: str,
    ) -> None:
        order.append("remove")

    adapter.remove_owned_trial_networks = remove
    await adapter.restore_verifier_and_remove_trial_networks(
        environment,
        networks,
        run_id,
    )
    assert order == ["remove"]

    cleanup_order: list[str] = []

    class FailingPublicEgress:
        async def stop(self, _environment: Any) -> None:
            cleanup_order.append("public-egress")
            raise RuntimeError("synthetic proxy stop failure")

    class FailingGateway:
        def stop(self) -> dict[str, Any]:
            cleanup_order.append("gateway")
            raise RuntimeError("synthetic gateway stop failure")

    async def remove_after_failures(
        _environment: Any,
        _networks: Any,
        _run_id: str,
    ) -> None:
        cleanup_order.append("networks")

    adapter.remove_owned_trial_networks = remove_after_failures
    try:
        await adapter.cleanup_trial_resources(
            environment,
            networks=networks,
            run_id=run_id,
            context=types.SimpleNamespace(),
            gateway=FailingGateway(),
            public_egress=FailingPublicEgress(),
            context_id="cleanup-failure",
            verifier_timeout_sec=60,
            verifier_receipt_path=Path("/unused"),
        )
    except RuntimeError as error:
        assert str(error) == "Terminal-Bench trial cleanup failed"
    else:
        raise AssertionError("trial cleanup failures unexpectedly succeeded")
    assert cleanup_order == ["public-egress", "gateway", "networks"]

    await assert_public_egress_lifecycle(adapter, run_id)
    await assert_container_proxy_env_injection(adapter)
    await assert_verifier_lifecycle_contract(adapter)
    await assert_bootstrap_output_projection(adapter)
    print("Terminal-Bench trial network lifecycle passed.")


asyncio.run(main())
