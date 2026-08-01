from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
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
    *,
    model: str = "gpt-5.4",
) -> dict[str, Any]:
    capability: dict[str, Any] = {"toolCall": True}
    if output_token_field is not None:
        capability["outputTokenField"] = output_token_field
    if output_tokens is not None:
        capability["output"] = output_tokens
    return {
        "schemaVersion": 1,
        "modelRouteId": f"codex-oauth/{model}",
        "providerId": "codex-oauth",
        "provider": {
            "protocol": "openai",
            "baseURL": "http://pico-gateway:8080",
            "models": [model],
            "discoverModels": False,
            "modelCapabilities": {model: capability},
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
        for model in ("gpt-5.4", "gpt-5.6-terra"):
            valid = benchmark_route_config(model=model)
            path.write_text(json.dumps(valid))
            assert adapter.load_route_config(path) == valid
            assert (
                valid["provider"]["modelCapabilities"][model]["output"]
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
                            model=model,
                        )
                    )
                )
                try:
                    adapter.load_route_config(path)
                except ValueError as error:
                    assert str(error) == (
                        f"codex-oauth/{model} benchmark route must pin output=8192 "
                        "and use max_completion_tokens"
                    )
                else:
                    raise AssertionError(
                        "invalid output capability was accepted: "
                        f"{model!r}, {invalid_output!r}, {invalid_field!r}"
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

        with_vision = benchmark_route_config()
        with_vision["provider"]["modelCapabilities"]["gpt-5.4"]["vision"] = True
        path.write_text(json.dumps(with_vision))
        assert adapter.load_route_config(path) == with_vision
        for invalid_vision in (None, 1, "true", {}):
            invalid = benchmark_route_config()
            invalid["provider"]["modelCapabilities"]["gpt-5.4"][
                "vision"
            ] = invalid_vision
            path.write_text(json.dumps(invalid))
            try:
                adapter.load_route_config(path)
            except ValueError as error:
                assert str(error) == (
                    "route config model vision capability must be a boolean"
                )
            else:
                raise AssertionError(
                    f"invalid route vision was accepted: {invalid_vision!r}"
                )


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
        agent._adapter_cleanup_margin_ms = 60_000
        agent._bash_timeout_ms = 180_000
        loop = asyncio.get_running_loop()
        outer_deadline = loop.time() + 120
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
                outer_deadline=outer_deadline,
                headless_deadline=outer_deadline - 75,
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
        for model in ("gpt-5.4", "gpt-5.6-terra"):
            route_config = benchmark_route_config(model=model)
            route_config["provider"]["modelCapabilities"][model]["vision"] = (
                model == "gpt-5.4"
            )
            exact = await project(
                root,
                f"exact-{model}",
                route_config,
            )
            assert exact["route"] == {
                "id": f"codex-oauth/{model}",
                "protocol": "openai",
                "baseURL": "http://pico-gateway:8080",
                "apiKeyEnv": "PICO_TB_GATEWAY_TOKEN",
                "output": 8_192,
                "vision": model == "gpt-5.4",
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


async def assert_task_image_attachment_projection(adapter: Any) -> None:
    class LocalShellEnvironment:
        def __init__(self) -> None:
            self.commands: list[str] = []

        async def exec(self, *, command: str, **_kwargs: Any) -> Any:
            self.commands.append(command)
            completed = subprocess.run(
                command,
                shell=True,
                check=False,
                capture_output=True,
                text=True,
            )
            return types.SimpleNamespace(
                return_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )

    with tempfile.TemporaryDirectory(prefix="pico-task-images-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        existing = workspace / "input.png"
        existing.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        spaced = workspace / "spaced image.png"
        spaced.write_bytes(b"\x89PNG\r\n\x1a\nspaced")
        outside = root / "outside.png"
        outside.write_bytes(b"\x89PNG\r\n\x1a\noutside")
        physical_parent = workspace / "physical-parent"
        physical_parent.mkdir()
        (physical_parent / "nested.png").write_bytes(b"\x89PNG\r\n\x1a\nnested")
        parent_symlink = workspace / "parent-link"
        parent_symlink.symlink_to(physical_parent, target_is_directory=True)
        target_symlink = workspace / "target-link.png"
        target_symlink.symlink_to(existing)
        directory_image = workspace / "directory.gif"
        directory_image.mkdir()
        fifo_image = workspace / "pipe.webp"
        os.mkfifo(fifo_image)

        instruction = " ".join(
            [
                *(f"`missing-{index}.png`" for index in range(4)),
                "`input.png`",
                f"`{existing}`",
                "`spaced image.png`",
                f"`{outside}`",
                "`../outside.png`",
                "https://example.invalid/remote.png",
                "`target-link.png`",
                "`parent-link/nested.png`",
                "`directory.gif`",
                "`pipe.webp`",
            ]
        )
        candidates = adapter.task_image_path_candidates(
            instruction,
            workspace=str(workspace),
        )
        assert candidates[:5] == tuple(
            str(workspace / f"missing-{index}.png") for index in range(4)
        ) + (str(existing),)
        assert str(existing) in candidates
        assert str(spaced) in candidates
        assert str(workspace / "image.png") not in candidates
        assert str(outside) not in candidates
        assert len([path for path in candidates if path == str(existing)]) == 1

        environment = LocalShellEnvironment()
        accepted = await adapter.preflight_task_image_paths(
            instruction,
            workspace=str(workspace),
            environment=environment,
        )
        assert accepted == (str(existing), str(spaced))
        assert len(environment.commands) == 1
        assert str(outside) not in environment.commands[0]
        parent_check = f"[ ! -L {shlex.quote(str(parent_symlink))} ]"
        target_probe = f"[ -f {shlex.quote(str(parent_symlink / 'nested.png'))} ]"
        assert parent_check in environment.commands[0]
        assert target_probe in environment.commands[0]
        assert environment.commands[0].index(parent_check) < environment.commands[
            0
        ].index(target_probe)

        no_image_environment = LocalShellEnvironment()
        assert await adapter.preflight_task_image_paths(
            "code-from-image is only a task name",
            workspace=str(workspace),
            environment=no_image_environment,
        ) == ()
        assert no_image_environment.commands == []

        for index in range(5):
            (workspace / f"accepted-{index}.jpg").write_bytes(b"\xff\xd8\xfffixture")
        bounded = await adapter.preflight_task_image_paths(
            " ".join(f"`accepted-{index}.jpg`" for index in range(5)),
            workspace=str(workspace),
            environment=LocalShellEnvironment(),
        )
        assert bounded == tuple(
            str(workspace / f"accepted-{index}.jpg") for index in range(4)
        )


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


async def assert_runtime_retry_contract(adapter: Any) -> None:
    deadlines = adapter.reserve_agent_run_deadlines(
        outer_deadline=2_400,
        now=0,
        adapter_cleanup_margin_ms=60_000,
    )
    assert deadlines.headless == 2_325
    assert deadlines.cleanup == 2_340
    try:
        adapter.reserve_agent_run_deadlines(
            outer_deadline=75,
            now=0,
            adapter_cleanup_margin_ms=60_000,
        )
    except RuntimeError as error:
        assert str(error) == "outer_timeout_budget_violation"
    else:
        raise AssertionError("reserved phases consumed the complete outer budget")

    full_budget_inner_timeout_ms = adapter.headless_execution_timeout_ms(
        remaining_sec=2_400,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    )
    assert full_budget_inner_timeout_ms == 2_285_000
    internal_completion = (
        full_budget_inner_timeout_ms + 30_000 + 5_000
    ) / 1_000
    assert deadlines.headless - internal_completion == 5

    class PhaseLoop:
        now = deadlines.headless

        def time(self) -> float:
            return self.now

    phase_loop = PhaseLoop()
    original_read_manifest = adapter.read_verifier_service_manifest

    async def consume_verifier_margin(
        _environment: Any,
        *,
        workspace: str,
        timeout_sec: float,
    ) -> None:
        assert workspace == "/app"
        assert timeout_sec == 15
        phase_loop.now += timeout_sec
        return None

    adapter.read_verifier_service_manifest = consume_verifier_margin
    try:
        assert not await adapter.launch_verifier_service_if_requested(
            types.SimpleNamespace(),
            workspace="/app",
            outer_deadline=deadlines.cleanup,
            loop=phase_loop,
        )
    finally:
        adapter.read_verifier_service_manifest = original_read_manifest
    assert phase_loop.now == deadlines.cleanup
    assert 2_400 - phase_loop.now == 60

    assert adapter.headless_execution_timeout_ms(
        remaining_sec=116,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    ) == 1_000
    for insufficient_budget in (115.999, float("nan"), float("inf")):
        try:
            adapter.headless_execution_timeout_ms(
                remaining_sec=insufficient_budget,
                shutdown_grace_ms=30_000,
                result_flush_margin_ms=5_000,
                adapter_cleanup_margin_ms=60_000,
            )
        except RuntimeError as error:
            assert str(error) == "outer_timeout_budget_violation"
        else:
            raise AssertionError("insufficient outer timeout budget was accepted")

    required_destination_prompt = adapter.benchmark_instruction(
        "Install the binary at /usr/local/bin/task-binary.", "/app"
    )
    assert required_destination_prompt.startswith(
        "Install the binary at /usr/local/bin/task-binary.\n\n"
    )
    assert "Never replace a destination explicitly required" in (
        required_destination_prompt
    )
    for acceptance_kind in (
        "tests",
        "metrics",
        "numeric thresholds",
        "format",
        "structure",
        "invariants",
        "direction conventions",
    ):
        assert acceptance_kind in required_destination_prompt
    for strategy_guardrail in (
        "map every explicit acceptance condition",
        "inspect the exact intermediate or transformed artifact first",
        "cheapest deterministic check",
        "change one hypothesis at a time",
        "candidate output or tested hypothesis materially changed",
        "leave enough time for the final authoritative validation",
        "iterating an in-place transformer, filter, migrator, or similar operation",
        "make and test each candidate in a temporary copy",
        "keep the canonical deliverable unchanged until a candidate passes",
        "publish that candidate to the canonical deliverable once",
        "collection quantifiers--such as all, every, each, multiple, or a complete set",
        "enumerate the relevant candidates",
        "check completeness or coverage",
        "stopping after one matching witness",
        "inspect the existing files and runtimes",
        "minimum missing dependencies",
        "limit setup work",
        "switch to literal executable argv or write_file/edit_file only when",
        "command form as the sole issue",
        "policy guidance permits that safe equivalent",
        "do not retry the rejected form",
        "operation itself is destructive or protected",
        "rejection reason is unknown",
        "stop and do not reproduce it through another tool",
    ):
        assert strategy_guardrail in required_destination_prompt
    assert "do not write under /tmp or system paths" not in (
        required_destination_prompt
    )

    class AttemptEnvironment:
        def __init__(self, root: Path, outcomes: list[dict[str, Any]]) -> None:
            self.root = root
            self.outcomes = outcomes
            self.launch_count = 0
            self.trace_clear_count = 0

        async def exec(self, *, command: str, **_kwargs: Any) -> Any:
            if "headless-bootstrap-main.js" in command:
                return types.SimpleNamespace(return_code=0, stdout="", stderr="")
            if command == (
                f"rm -f -- {adapter.PicoInstalledAgent._TRACE_EXPORT.as_posix()}"
            ):
                self.trace_clear_count += 1
                return types.SimpleNamespace(return_code=0, stdout="", stderr="")
            if command == f"cat {adapter.PicoInstalledAgent._PICO_RESULT.as_posix()}":
                request = json.loads(
                    (self.root / "headless-request.json").read_text(encoding="utf-8")
                )
                outcome = self.outcomes[self.launch_count - 1]
                result = {
                    "schemaVersion": 1,
                    "requestId": request["requestId"],
                    "status": outcome["status"],
                    "usage": outcome["usage"],
                    "durationMs": outcome.get("durationMs", 123),
                    "terminationConfirmed": outcome.get(
                        "terminationConfirmed", True
                    ),
                    "error": outcome.get("error"),
                    **(
                        {"policyDenials": outcome["policyDenials"]}
                        if "policyDenials" in outcome
                        else {}
                    ),
                }
                return types.SimpleNamespace(
                    return_code=0,
                    stdout=f"{json.dumps(result)}\n",
                    stderr="",
                )
            if command == f"cat {adapter.PicoInstalledAgent._EXIT_CODE.as_posix()}":
                outcome = self.outcomes[self.launch_count - 1]
                return types.SimpleNamespace(
                    return_code=0,
                    stdout=f"{outcome['exitCode']}\n",
                    stderr="",
                )
            raise AssertionError(f"unexpected retry environment command: {command}")

    runtime_failed = {
        "status": "failed",
        "exitCode": 3,
        "usage": {"promptTokens": 0, "completionTokens": 0, "costCNY": 0},
        "error": {"code": "RUNTIME_FAILED", "summary": "synthetic"},
    }
    assert adapter.should_retry_runtime_failure(
        {**runtime_failed, "terminationConfirmed": True},
        retries_used=0,
        retry_limit=1,
        remaining_sec=145,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    )
    assert not adapter.should_retry_runtime_failure(
        {**runtime_failed, "terminationConfirmed": True},
        retries_used=0,
        retry_limit=1,
        remaining_sec=144.999,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    )
    completed = {
        "status": "completed",
        "exitCode": 0,
        "usage": {"promptTokens": 7, "completionTokens": 5, "costCNY": 0.01},
        "error": None,
    }
    for status, code in (
        ("timed_out", "TIMEOUT"),
        ("canceled", "CANCELED"),
        ("policy_blocked", "POLICY_BLOCKED"),
        ("invalid_request", "INVALID_REQUEST"),
        ("failed", "RUNTIME_EMPTY_RESPONSE"),
    ):
        assert not adapter.should_retry_runtime_failure(
            {
                "status": status,
                "error": {"code": code},
                "terminationConfirmed": True,
            },
            retries_used=0,
            retry_limit=1,
            remaining_sec=120,
            shutdown_grace_ms=30_000,
            result_flush_margin_ms=5_000,
            adapter_cleanup_margin_ms=60_000,
        )
    assert not adapter.should_retry_runtime_failure(
        {**runtime_failed, "terminationConfirmed": False},
        retries_used=0,
        retry_limit=1,
        remaining_sec=120,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    )
    assert adapter.should_retry_runtime_failure(
        {
            **runtime_failed,
            "terminationConfirmed": True,
            "policyDenials": {"total": 1},
        },
        retries_used=0,
        retry_limit=1,
        remaining_sec=145,
        shutdown_grace_ms=30_000,
        result_flush_margin_ms=5_000,
        adapter_cleanup_margin_ms=60_000,
    )

    async def execute(
        root: Path,
        outcomes: list[dict[str, Any]],
        *,
        outer_timeout_sec: float,
        image_paths: tuple[str, ...] = (),
    ) -> tuple[Any, AttemptEnvironment]:
        environment = AttemptEnvironment(root, outcomes)
        agent = object.__new__(adapter.PicoInstalledAgent)
        agent.logs_dir = root
        agent._shutdown_grace_ms = 30_000
        agent._result_flush_margin_ms = 5_000
        agent._adapter_cleanup_margin_ms = 60_000
        agent._bash_timeout_ms = 900_000
        agent._max_turns = 80
        agent._runtime_retry_count = 1
        agent._pico_commit = "a" * 40
        context = types.SimpleNamespace(n_input_tokens=0, n_output_tokens=0, metadata={})
        loop = asyncio.get_running_loop()
        outer_deadline = loop.time() + outer_timeout_sec
        await agent._run_with_gateway(
            instruction="retry contract",
            environment=environment,
            context=context,
            gateway=types.SimpleNamespace(
                base_url="http://pico-gateway:8080",
                capability="pico-workload-identity",
            ),
            route_config=benchmark_route_config(),
            workspace="/app",
            pico_home="/tmp/pico-home",
            request_id="retry-request",
            session_id="retry-session",
            context_id="retry-context",
            outer_timeout_sec=outer_timeout_sec,
            outer_deadline=outer_deadline,
            headless_deadline=outer_deadline - 75,
            loop=loop,
            public_proxy_env={},
            image_paths=image_paths,
        )
        return context, environment

    original_launcher = adapter.docker_exec_secret_stdin

    async def synthetic_launcher(
        environment: AttemptEnvironment,
        _secret: bytes,
        **_kwargs: Any,
    ) -> Any:
        environment.launch_count += 1
        if environment.launch_count > len(environment.outcomes):
            raise AssertionError("runtime retried more than expected")
        return types.SimpleNamespace(returncode=0)

    adapter.docker_exec_secret_stdin = synthetic_launcher
    try:
        with tempfile.TemporaryDirectory(prefix="pico-runtime-retry-") as directory:
            root = Path(directory)
            context, environment = await execute(
                root,
                [runtime_failed, completed],
                outer_timeout_sec=180,
                image_paths=("/app/code.png",),
            )
            assert environment.launch_count == 2
            assert environment.trace_clear_count == 2
            pico = context.metadata["pico"]
            assert pico["retryCount"] == 1
            assert pico["signedGatewayUsageRequired"] is True
            assert [entry["attempt"] for entry in pico["attempts"]] == [1, 2]
            assert pico["attempts"][0]["requestId"] != pico["attempts"][1]["requestId"]
            assert set(pico["attempts"][0]) == {
                "attempt",
                "requestId",
                "status",
                "errorCode",
                "terminationConfirmed",
                "durationMs",
            }
            assert pico["status"] == "completed"
            assert pico["adapterCleanupMarginMs"] == 60_000
            assert pico["headlessAdapterMarginMs"] == 5_000
            assert pico["verifierServiceMarginMs"] == 15_000
            assert context.n_input_tokens == 7 and context.n_output_tokens == 5
            for attempt in (1, 2):
                attempt_dir = root / "attempts" / f"attempt-{attempt}"
                assert (attempt_dir / "pico-result.json").is_file()
                assert (attempt_dir / "pico-exit-code.txt").is_file()
                request = json.loads(
                    (attempt_dir / "headless-request.json").read_text(
                        encoding="utf-8"
                    )
                )
                assert request["maxTurns"] == 80
                assert request["providerRequestMode"] == "single_non_stream"
                assert request["providerTimeoutMs"] == min(
                    330_000, request["timeoutMs"]
                )
                assert request["imagePaths"] == ["/app/code.png"]
                assert "imageData" not in request and "base64" not in request
                assert "inside /app/.pico-tmp or /app/.local" in request["prompt"]
                assert "prefer write_file or edit_file" in request["prompt"]
                assert "invoke executables with literal argv" in request["prompt"]
                assert "Never replace a destination explicitly required" in request[
                    "prompt"
                ]
                assert "map every explicit acceptance condition" in request["prompt"]
                assert (
                    "leave enough time for the final authoritative validation"
                    in request["prompt"]
                )
                assert "command form as the sole issue" in request["prompt"]
                assert (
                    "stop and do not reproduce it through another tool"
                    in request["prompt"]
                )
                assert "pytest itself" in request["prompt"]
                assert "adapter, not your process, launches" in request["prompt"]
                assert "stop that exact process" in request["prompt"]
                assert "confirm port 8080 is closed" in request["prompt"]
                assert "Never stop or take over" in request["prompt"]

            receipt = {
                "schemaVersion": 1,
                "status": "reconciled",
                "withinBudget": True,
                "pricingSha256": "0" * 64,
                "receiptSha256": "1" * 64,
                "actual": {
                    "inputTokens": 11,
                    "outputTokens": 8,
                    "costMicroCNY": 19,
                    "costCNY": 0.000019,
                },
            }
            adapter.apply_gateway_accounting(context, receipt)
            assert (context.n_input_tokens, context.n_output_tokens) == (11, 8)
            accounting = context.metadata["pico"]["gatewayAccounting"]
            assert accounting["usageFallback"] is True
            assert accounting["usageSource"] == "signed_gateway_actual"

        with tempfile.TemporaryDirectory(prefix="pico-runtime-once-") as directory:
            context, environment = await execute(
                Path(directory),
                [runtime_failed, runtime_failed],
                outer_timeout_sec=180,
            )
            assert environment.launch_count == 2
            assert context.metadata["pico"]["retryCount"] == 1

        with tempfile.TemporaryDirectory(prefix="pico-runtime-budget-") as directory:
            context, environment = await execute(
                Path(directory), [runtime_failed], outer_timeout_sec=120
            )
            assert environment.launch_count == 1
            assert context.metadata["pico"]["retryCount"] == 0
            assert context.metadata["pico"]["signedGatewayUsageRequired"] is True

        with tempfile.TemporaryDirectory(prefix="pico-runtime-reject-") as directory:
            try:
                await execute(
                    Path(directory), [completed], outer_timeout_sec=115
                )
            except RuntimeError as error:
                assert str(error) == "outer_timeout_budget_violation"
            else:
                raise AssertionError("headless started without cleanup budget")

        with tempfile.TemporaryDirectory(prefix="pico-runtime-policy-") as directory:
            recovered_policy_incident = {
                **runtime_failed,
                "policyDenials": {"total": 1},
            }
            context, environment = await execute(
                Path(directory), [recovered_policy_incident, completed], outer_timeout_sec=180
            )
            assert environment.launch_count == 2
            assert environment.trace_clear_count == 2
            assert context.metadata["pico"]["retryCount"] == 1

        with tempfile.TemporaryDirectory(prefix="pico-runtime-policy-blocked-") as directory:
            terminal_policy_block = {
                "status": "policy_blocked",
                "exitCode": 4,
                "usage": {"promptTokens": 0, "completionTokens": 0, "costCNY": 0},
                "error": {"code": "POLICY_BLOCKED", "summary": "synthetic"},
                "policyDenials": {"total": 1},
            }
            context, environment = await execute(
                Path(directory), [terminal_policy_block], outer_timeout_sec=120
            )
            assert environment.launch_count == 1
            assert environment.trace_clear_count == 1
            assert context.metadata["pico"]["retryCount"] == 0

        timed_out = {
            "status": "timed_out",
            "exitCode": 124,
            "usage": {"promptTokens": 1, "completionTokens": 1, "costCNY": 0},
            "error": {"code": "TIMEOUT", "summary": "synthetic"},
        }
        with tempfile.TemporaryDirectory(prefix="pico-runtime-timeout-") as directory:
            context, environment = await execute(
                Path(directory), [timed_out], outer_timeout_sec=120
            )
            assert environment.launch_count == 1
            assert context.metadata["pico"]["retryCount"] == 0
            assert context.metadata["pico"]["signedGatewayUsageRequired"] is False

        zero_usage_timeout = {
            **timed_out,
            "usage": {"promptTokens": 0, "completionTokens": 0, "costCNY": 0},
        }
        with tempfile.TemporaryDirectory(
            prefix="pico-runtime-zero-usage-timeout-"
        ) as directory:
            context, environment = await execute(
                Path(directory), [zero_usage_timeout], outer_timeout_sec=120
            )
            assert environment.launch_count == 1
            pico = context.metadata["pico"]
            assert pico["status"] == "timed_out"
            assert pico["retryCount"] == 0
            assert pico["signedGatewayUsageRequired"] is True
            adapter.apply_gateway_accounting(
                context,
                {
                    "schemaVersion": 1,
                    "status": "reconciled",
                    "withinBudget": True,
                    "pricingSha256": "0" * 64,
                    "receiptSha256": "1" * 64,
                    "actual": {
                        "inputTokens": 13,
                        "outputTokens": 2,
                        "costMicroCNY": 15,
                        "costCNY": 0.000015,
                    },
                },
            )
            assert (context.n_input_tokens, context.n_output_tokens) == (13, 2)
            accounting = pico["gatewayAccounting"]
            assert accounting["usageFallback"] is True
            assert accounting["usageSource"] == "signed_gateway_actual"

        with tempfile.TemporaryDirectory(
            prefix="pico-runtime-zero-cost-timeout-"
        ) as directory:
            context, environment = await execute(
                Path(directory), [zero_usage_timeout], outer_timeout_sec=120
            )
            assert environment.launch_count == 1
            adapter.apply_gateway_accounting(
                context,
                {
                    "schemaVersion": 1,
                    "status": "reconciled",
                    "withinBudget": True,
                    "pricingSha256": "0" * 64,
                    "receiptSha256": "1" * 64,
                    "actual": {
                        "inputTokens": 0,
                        "outputTokens": 0,
                        "costMicroCNY": 0,
                        "costCNY": 0,
                    },
                },
            )
            pico = context.metadata["pico"]
            assert (context.n_input_tokens, context.n_output_tokens) == (0, 0)
            assert pico["signedGatewayUsageRequired"] is False
            accounting = pico["gatewayAccounting"]
            assert accounting["usageFallback"] is False
            assert accounting["usageSource"] == "runtime"
    finally:
        adapter.docker_exec_secret_stdin = original_launcher


async def assert_verifier_service_manifest_contract(adapter: Any) -> None:
    for executable, script in (
        ("/installed-agent/pico-node/bin/node", "/app/server.cjs"),
        ("/usr/bin/python3", "/app/server.py"),
        ("/usr/local/bin/python3", "/app/server.py"),
        ("/usr/bin/node", "/app/server.cjs"),
    ):
        parsed = adapter.parse_verifier_service_manifest(
            {
                "schemaVersion": 1,
                "argv": [executable, script],
                "cwd": "/app",
                "port": 8080,
            },
            workspace="/app",
        )
        assert parsed.argv == (executable, script)

    valid = {
        "schemaVersion": 1,
        "argv": ["/installed-agent/pico-node/bin/node", "/app/server.cjs"],
        "cwd": "/app",
        "port": 8080,
    }
    for invalid in (
        {**valid, "extra": True},
        {**valid, "cwd": "/tests"},
        {**valid, "argv": ["/bin/sh", "/app/server.cjs"]},
        {
            **valid,
            "argv": [
                "/installed-agent/pico-node/bin/node",
                "/app/sub/../server.cjs",
            ],
        },
        {
            **valid,
            "argv": ["/installed-agent/pico-node/bin/node", "/app/sub/server.cjs"],
        },
        {
            **valid,
            "argv": ["/installed-agent/pico-node/bin/node", "/app/server.py"],
        },
        {**valid, "argv": ["/usr/bin/node", "-e", "server"]},
        {**valid, "port": 8081},
    ):
        try:
            adapter.parse_verifier_service_manifest(invalid, workspace="/app")
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid verifier manifest was accepted: {invalid!r}")

    node_candidates = [
        Path.home() / ".hermes/node/bin/node",
        Path.home() / ".local/bin/node",
        Path(shutil.which("node") or "/missing-node"),
    ]
    node = next((str(candidate) for candidate in node_candidates if candidate.is_file()), None)
    assert node is not None
    trusted_host_env = {
        **os.environ,
        "LD_AUDIT": "",
        "LD_LIBRARY_PATH": "",
        "LD_PRELOAD": "",
        "NODE_OPTIONS": "",
        "NODE_PATH": "",
    }
    with tempfile.TemporaryDirectory(prefix="pico-verifier-manifest-") as directory:
        workspace = Path(directory).resolve()
        script = workspace / "server.cjs"
        script.write_text("setInterval(() => {}, 1000);\n", encoding="utf-8")
        helper = workspace / "verifier-helper.cjs"
        helper.write_text(adapter._VERIFIER_SERVICE_HELPER, encoding="utf-8")
        runner_declaration = re.search(
            r"const nodeRunner = \[.*?\]\.join\(';'\);",
            adapter._VERIFIER_SERVICE_HELPER,
            re.DOTALL,
        )
        assert runner_declaration is not None
        extracted_runner = subprocess.run(
            [
                node,
                "-e",
                f"{runner_declaration.group(0)}\nprocess.stdout.write(nodeRunner);",
            ],
            check=False,
            capture_output=True,
            text=True,
            env=trusted_host_env,
        )
        assert extracted_runner.returncode == 0, (
            extracted_runner.stdout,
            extracted_runner.stderr,
        )
        cjs_main = subprocess.run(
            [node, "-e", extracted_runner.stdout, str(script)],
            input=(
                "if (require.main !== module) process.exit(41);"
                "const net=require('node:net');"
                "const server=net.createServer();"
                "server.listen(0,'127.0.0.1',()=>{"
                "process.stdout.write('ready');server.close();});"
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=trusted_host_env,
        )
        assert cjs_main.returncode == 0, (cjs_main.stdout, cjs_main.stderr)
        assert cjs_main.stdout == "ready"
        for name, source in (
            ("verifier-probe.cjs", adapter._VERIFIER_SERVICE_PROBE),
            ("verifier-closed.cjs", adapter._VERIFIER_SERVICE_ASSERT_CLOSED),
        ):
            source_path = workspace / name
            source_path.write_text(source, encoding="utf-8")
            syntax = subprocess.run(
                [node, "--check", str(source_path)],
                check=False,
                capture_output=True,
                text=True,
                env=trusted_host_env,
            )
            assert syntax.returncode == 0, (syntax.stdout, syntax.stderr)
        supervisor_matcher = re.search(
            r"function hasTrustedSupervisorArguments\(argv\) \{.*?\n\}",
            adapter._VERIFIER_SERVICE_PROBE,
            re.DOTALL,
        )
        assert supervisor_matcher is not None
        node_mapping_matcher = re.search(
            r"function hasTrustedNodeMappings\(raw, expectedInode\) \{.*?\n\}",
            adapter._VERIFIER_SERVICE_PROBE,
            re.DOTALL,
        )
        assert node_mapping_matcher is not None
        executable_matcher = re.search(
            r"function usesTrustedSupervisorExecutable\(pid\) \{.*?\n\}",
            adapter._VERIFIER_SERVICE_PROBE,
            re.DOTALL,
        )
        assert executable_matcher is not None
        matcher_check = subprocess.run(
            [
                node,
                "-e",
                (
                    "const crypto=require('node:crypto');"
                    "const supervisorNode='/installed-agent/pico-node/bin/node';"
                    "const helperSentinel='pico-verifier-helper';"
                    "const helper='trusted helper';"
                    "const helperSha256=crypto.createHash('sha256').update(helper).digest('hex');"
                    "const manifestPath='/app/.pico-verifier-service.json';"
                    "const workspace='/app';"
                    "const nonce='a'.repeat(64);"
                    f"{supervisor_matcher.group(0)}"
                    "const exact=[supervisorNode,'-e',helper,helperSentinel,'launch',manifestPath,workspace,nonce];"
                    "if(!hasTrustedSupervisorArguments(exact))process.exit(42);"
                    "exact.splice(4,0,'--input-type=commonjs');"
                    "if(hasTrustedSupervisorArguments(exact))process.exit(43);"
                    "const emulated=[supervisorNode,'--no-opt','-r','/proc/.reset','-e',helper,helperSentinel,'launch',manifestPath,workspace,nonce];"
                    "if(!hasTrustedSupervisorArguments(emulated))process.exit(44);"
                    "emulated.splice(4,0,'--input-type=commonjs');"
                    "if(hasTrustedSupervisorArguments(emulated))process.exit(45);"
                    f"{node_mapping_matcher.group(0)}"
                    "const maps='00400000-00e26000 r--p 00000000 00:40 649790 '+supervisorNode+'\\n'"
                    "+'00e26000-00e29000 r-xp 00a26000 00:40 649790 '+supervisorNode+'\\n';"
                    "if(!hasTrustedNodeMappings(maps,649790))process.exit(46);"
                    "if(hasTrustedNodeMappings(maps,649791))process.exit(47);"
                    "if(hasTrustedNodeMappings(maps.replace('r-xp','r--p'),649790))process.exit(48);"
                    "let currentInode=2;"
                    "const expectedStat={dev:64,ino:649790,mode:0o100555,isFile:()=>true};"
                    "const fs={"
                    "statSync:(candidate)=>{"
                    "if(candidate===supervisorNode)return expectedStat;"
                    "if(candidate==='/proc/123/exe')return {dev:58,ino:2};"
                    "if(candidate==='/proc/self/exe')return {dev:58,ino:currentInode};"
                    "if(candidate==='/proc/.reset')return {dev:71,mode:0o100644,size:0,uid:0,gid:0,isFile:()=>true};"
                    "if(candidate==='/proc')return {dev:71};throw new Error('unexpected stat');},"
                    "realpathSync:(candidate)=>candidate==='/proc/self/exe'?supervisorNode:candidate,"
                    "readlinkSync:(candidate)=>candidate==='/proc/123/exe'?'/run/rosetta/rosetta':supervisorNode,"
                    "readFileSync:(candidate)=>candidate.endsWith('/maps')?maps:'',"
                    "};"
                    "process.execPath=supervisorNode;"
                    f"{executable_matcher.group(0)}"
                    "if(!usesTrustedSupervisorExecutable('123'))process.exit(49);"
                    "currentInode=3;"
                    "if(usesTrustedSupervisorExecutable('123'))process.exit(50);"
                ),
            ],
            check=False,
            capture_output=True,
            text=True,
            env=trusted_host_env,
        )
        assert matcher_check.returncode == 0, (
            matcher_check.stdout,
            matcher_check.stderr,
        )
        manifest_path = workspace / ".pico-verifier-service.json"
        missing_manifest = subprocess.run(
            [
                node,
                "-e",
                adapter._VERIFIER_SERVICE_HELPER,
                adapter._VERIFIER_SERVICE_HELPER_SENTINEL,
                "inspect",
                str(manifest_path),
                str(workspace),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=trusted_host_env,
        )
        assert missing_manifest.returncode == 44, (
            missing_manifest.stdout,
            missing_manifest.stderr,
        )
        manifest = {
            "schemaVersion": 1,
            "argv": ["/installed-agent/pico-node/bin/node", str(script)],
            "cwd": str(workspace),
            "port": 8080,
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        production_inspect = subprocess.run(
            [
                node,
                "-e",
                adapter._VERIFIER_SERVICE_HELPER,
                adapter._VERIFIER_SERVICE_HELPER_SENTINEL,
                "inspect",
                str(manifest_path),
                str(workspace),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=trusted_host_env,
        )
        assert production_inspect.returncode == 0, (
            production_inspect.stdout,
            production_inspect.stderr,
        )
        assert json.loads(production_inspect.stdout) == manifest

        def invoke(
            mode: str = "inspect",
            path: Path = manifest_path,
        ) -> subprocess.CompletedProcess[str]:
            command = [
                node,
                str(helper),
                mode,
                str(path),
                str(workspace),
            ]
            if mode == "launch":
                command.append("a" * 64)
            return subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                env=trusted_host_env,
            )

        result = invoke()
        assert result.returncode == 0, (result.stdout, result.stderr)
        assert json.loads(result.stdout) == manifest

        script.write_bytes(b"x" * (1024 * 1024 + 1))
        assert invoke().returncode == 2
        script.write_text("setInterval(() => {}, 1000);\n", encoding="utf-8")

        real_manifest = workspace / "manifest.json"
        manifest_path.replace(real_manifest)
        manifest_path.symlink_to(real_manifest)
        assert invoke().returncode == 2
        assert invoke("launch").returncode == 2
        manifest_path.unlink()

        linked_script = workspace / "linked-server.cjs"
        linked_script.symlink_to(script)
        manifest["argv"] = ["/usr/bin/node", str(linked_script)]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        assert invoke().returncode == 2
        assert invoke("launch").returncode == 2
        manifest_path.unlink()
        assert invoke().returncode == 44

    calls: list[dict[str, Any]] = []
    original_exec = adapter.docker_compose_exec_argv

    async def service_exec(
        _environment: Any,
        argv: list[str],
        **kwargs: Any,
    ) -> tuple[int, bytes, bytes]:
        calls.append({"argv": argv, **kwargs})
        if adapter._VERIFIER_SERVICE_HELPER in argv and "inspect" in argv:
            return 0, f"{json.dumps(valid)}\n".encode(), b""
        return 0, b"", b""

    adapter.docker_compose_exec_argv = service_exec
    try:
        loop = asyncio.get_running_loop()
        launched = await adapter.launch_verifier_service_if_requested(
            FakeEnvironment(),
            workspace="/app",
            outer_deadline=loop.time() + 60,
            loop=loop,
        )
        assert launched is True
        assert len(calls) == 4
        assert adapter._VERIFIER_SERVICE_ASSERT_CLOSED in calls[1]["argv"]
        assert calls[2]["detached"] is True
        assert calls[2]["working_dir"] == "/app"
        assert all(
            call["container_env"] == adapter._TRUSTED_NODE_EXEC_ENV
            for call in calls
        )
        supervisor_nonce = calls[2]["argv"][-1]
        assert re.fullmatch(r"[0-9a-f]{64}", supervisor_nonce)
        assert len(calls[2]["argv"]) == 8
        assert calls[2]["argv"][-5:] == [
            adapter._VERIFIER_SERVICE_HELPER_SENTINEL,
            "launch",
            "/app/.pico-verifier-service.json",
            "/app",
            supervisor_nonce,
        ]
        assert adapter._VERIFIER_SERVICE_PROBE in calls[3]["argv"]
        assert calls[3]["argv"][-4:] == [
            supervisor_nonce,
            "/app/.pico-verifier-service.json",
            "/app",
            hashlib.sha256(adapter._VERIFIER_SERVICE_HELPER.encode()).hexdigest(),
        ]
    finally:
        adapter.docker_compose_exec_argv = original_exec

    occupied_calls: list[dict[str, Any]] = []

    async def occupied_service_exec(
        _environment: Any,
        argv: list[str],
        **kwargs: Any,
    ) -> tuple[int, bytes, bytes]:
        occupied_calls.append({"argv": argv, **kwargs})
        if adapter._VERIFIER_SERVICE_HELPER in argv and "inspect" in argv:
            return 0, f"{json.dumps(valid)}\n".encode(), b""
        if adapter._VERIFIER_SERVICE_ASSERT_CLOSED in argv:
            assert kwargs["allowed_exit_codes"] == {0, 2}
            return 2, b"", b""
        raise AssertionError("occupied task service must not be replaced or adopted")

    adapter.docker_compose_exec_argv = occupied_service_exec
    try:
        loop = asyncio.get_running_loop()
        launched = await adapter.launch_verifier_service_if_requested(
            FakeEnvironment(),
            workspace="/app",
            outer_deadline=loop.time() + 60,
            loop=loop,
        )
        assert launched is False
        assert len(occupied_calls) == 2
    finally:
        adapter.docker_compose_exec_argv = original_exec

    identity_environment = FakeEnvironment()
    identity_environment.default_user = "1000:1000"
    command = adapter.docker_compose_exec_command(
        identity_environment,
        ["/installed-agent/pico-node/bin/node", "-e", "fixed-helper"],
        detached=True,
        working_dir="/app",
        container_env=adapter._TRUSTED_NODE_EXEC_ENV,
    )
    assert command[command.index("exec") :] == [
        "exec",
        "-T",
        "--detach",
        "-u",
        "1000:1000",
        "--workdir",
        "/app",
        "--env",
        "LD_AUDIT=",
        "--env",
        "LD_LIBRARY_PATH=",
        "--env",
        "LD_PRELOAD=",
        "--env",
        "NODE_OPTIONS=",
        "--env",
        "NODE_PATH=",
        "main",
        "/installed-agent/pico-node/bin/node",
        "-e",
        "fixed-helper",
    ]
    assert "/bin/sh" not in command and "bash" not in command

    class AdvancingLoop:
        def __init__(self) -> None:
            self.now = 0.0

        def time(self) -> float:
            return self.now

    budget_calls = 0
    advancing_loop = AdvancingLoop()

    async def budget_exec(
        _environment: Any,
        argv: list[str],
        **_kwargs: Any,
    ) -> tuple[int, bytes, bytes]:
        nonlocal budget_calls
        budget_calls += 1
        advancing_loop.now += 1.1
        if adapter._VERIFIER_SERVICE_HELPER in argv and "inspect" in argv:
            return 0, f"{json.dumps(valid)}\n".encode(), b""
        return 0, b"", b""

    adapter.docker_compose_exec_argv = budget_exec
    try:
        try:
            await adapter.launch_verifier_service_if_requested(
                FakeEnvironment(),
                workspace="/app",
                outer_deadline=1.0,
                loop=advancing_loop,
            )
        except RuntimeError as error:
            assert str(error) == "outer_timeout_budget_violation"
        else:
            raise AssertionError("verifier service launch exceeded the outer budget")
        assert budget_calls == 1
    finally:
        adapter.docker_compose_exec_argv = original_exec


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


def assert_supervisor_request_timeout_contract(adapter: Any) -> None:
    runtime_limits = importlib.import_module(
        "benchmarks.terminal_bench_2_1.runtime_limits"
    )
    assert runtime_limits.GATEWAY_UPSTREAM_HTTP_TIMEOUT_SEC == 300
    assert runtime_limits.GATEWAY_UPSTREAM_WORKER_TIMEOUT_SEC == 310
    assert runtime_limits.GATEWAY_UPSTREAM_WORKER_TIMEOUT_SEC == (
        runtime_limits.GATEWAY_UPSTREAM_HTTP_TIMEOUT_SEC
        + runtime_limits.GATEWAY_UPSTREAM_WORKER_MARGIN_SEC
    )
    assert runtime_limits.GATEWAY_PROXY_SUPERVISOR_TIMEOUT_SEC == 320
    assert runtime_limits.GATEWAY_PROXY_SUPERVISOR_TIMEOUT_SEC == (
        runtime_limits.GATEWAY_UPSTREAM_WORKER_TIMEOUT_SEC
        + runtime_limits.GATEWAY_PROXY_SUPERVISOR_MARGIN_SEC
    )
    assert runtime_limits.GATEWAY_CONTROL_SUPERVISOR_TIMEOUT_SEC == 5
    assert runtime_limits.BENCHMARK_PROVIDER_TIMEOUT_MS == 330_000
    assert runtime_limits.BENCHMARK_PROVIDER_TIMEOUT_MS == (
        runtime_limits.GATEWAY_PROXY_SUPERVISOR_TIMEOUT_SEC * 1_000
        + runtime_limits.BENCHMARK_PROVIDER_RESPONSE_MARGIN_MS
    )

    observed: list[dict[str, Any]] = []

    class ImmediateResponse:
        status = 200

        def read(self, _limit: int) -> bytes:
            return b"{}"

    class ImmediateConnection:
        def __init__(self, path: str, timeout: float):
            observed.append({"path": path, "timeout": timeout})

        def request(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def getresponse(self) -> ImmediateResponse:
            return ImmediateResponse()

        def close(self) -> None:
            pass

    gateway = adapter.ProviderGateway(
        protocol="openai",
        supervisor_socket="/unused",
        capability_seed="a" * 64,
        run_id="supervisor-timeout-contract",
        network_name="timeout-network",
        context_id="timeout-trial",
        ttl_sec=12_000,
        pricing_sha256="b" * 64,
        receipt_path=Path("/unused"),
    )
    original_connection = adapter.UnixHTTPConnection
    adapter.UnixHTTPConnection = ImmediateConnection
    try:
        assert gateway._supervisor_request({"action": "proxy"}) == {}
        assert gateway._supervisor_request({"action": "revoke"}) == {}
    finally:
        adapter.UnixHTTPConnection = original_connection
    assert observed == [
        {"path": "/unused", "timeout": 320},
        {"path": "/unused", "timeout": 5},
    ]


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
    default_access = adapter.PublicEgressAccess(
        run_id=run_id,
        network_name="pico-tb-gw-default-limit",
        context_id="public-egress-default-limit",
        ttl_sec=120,
        receipt_path=Path("/unused"),
    )
    assert default_access.max_total_bytes == 1_073_741_824
    for invalid_limit in (
        1_073_741_823,
        2_147_483_649,
        True,
        1.5,
        "2147483648.0",
        None,
    ):
        try:
            adapter.PublicEgressAccess(
                run_id=run_id,
                network_name="pico-tb-gw-invalid-limit",
                context_id="public-egress-invalid-limit",
                ttl_sec=120,
                receipt_path=Path("/unused"),
                max_total_bytes=invalid_limit,
            )
        except ValueError:
            pass
        else:
            raise AssertionError(
                f"invalid public egress byte limit was accepted: {invalid_limit!r}"
            )
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
            max_total_bytes=2_147_483_648,
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
        assert proxy.max_total_bytes == 2_147_483_648
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


async def assert_public_egress_limit_handoff(adapter: Any) -> None:
    captured: dict[str, Any] = {}

    class AgentAccess:
        max_total_bytes = 2_147_483_648

        async def stop(self, _environment: Any) -> None:
            captured["agentStopped"] = True

    class VerifierAccess:
        scrub_secret = "verifier-scrub-token"

        def __init__(self, **kwargs: Any) -> None:
            captured["verifierArguments"] = kwargs

    def install(
        _environment: Any,
        *,
        networks: Any,
        run_id: str,
        verifier_egress: Any,
    ) -> None:
        captured["install"] = (networks, run_id, verifier_egress)

    original_access = adapter.PublicEgressAccess
    original_install = adapter.install_verifier_egress_lifecycle
    adapter.PublicEgressAccess = VerifierAccess
    adapter.install_verifier_egress_lifecycle = install
    networks = adapter.TrialNetworks("task-network", "gateway-network")
    try:
        scrub_secret = await adapter.cleanup_trial_resources(
            types.SimpleNamespace(),
            networks=networks,
            run_id="egress-limit-handoff",
            context=types.SimpleNamespace(),
            gateway=None,
            public_egress=AgentAccess(),
            context_id="agent-context",
            verifier_timeout_sec=60,
            verifier_receipt_path=Path("/verifier-receipt.json"),
        )
    finally:
        adapter.PublicEgressAccess = original_access
        adapter.install_verifier_egress_lifecycle = original_install

    assert captured["agentStopped"] is True
    assert captured["verifierArguments"]["max_total_bytes"] == 2_147_483_648
    assert captured["install"][:2] == (networks, "egress-limit-handoff")
    assert scrub_secret == "verifier-scrub-token"


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
    await assert_runtime_retry_contract(adapter)
    await assert_verifier_service_manifest_contract(adapter)
    assert_task_timeout_contract(adapter)
    assert_supervisor_request_timeout_contract(adapter)
    assert adapter.PicoInstalledAgent._POLICY_DENIAL_MODE == "incident"
    assert adapter.require_bounded_int(900_000, "bash_timeout_ms", 1_000, 900_000) == 900_000
    for invalid in (999, 900_001, 1.5, True, "180000.0", None):
        try:
            adapter.require_bounded_int(invalid, "bash_timeout_ms", 1_000, 900_000)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid bash timeout was accepted: {invalid!r}")
    assert adapter.require_bounded_int(200, "max_turns", 1, 200) == 200
    assert adapter.require_bounded_int(1, "runtime_retry_count", 0, 1) == 1
    assert (
        adapter.require_bounded_int(
            60_000, "adapter_cleanup_margin_ms", 60_000, 300_000
        )
        == 60_000
    )
    for invalid in (59_999, 300_001, True, "60000.0"):
        try:
            adapter.require_bounded_int(
                invalid, "adapter_cleanup_margin_ms", 60_000, 300_000
            )
        except ValueError:
            pass
        else:
            raise AssertionError(
                f"invalid adapter cleanup margin was accepted: {invalid!r}"
            )

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
    await assert_public_egress_limit_handoff(adapter)
    await assert_container_proxy_env_injection(adapter)
    await assert_verifier_lifecycle_contract(adapter)
    await assert_bootstrap_output_projection(adapter)
    await assert_task_image_attachment_projection(adapter)
    print("Terminal-Bench trial network lifecycle passed.")


asyncio.run(main())
