from __future__ import annotations

import functools
import inspect
from collections.abc import Awaitable, Callable
from types import MappingProxyType
from typing import Any, Mapping

PUBLIC_EGRESS_PROXY_ENV_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
)
_VERIFIER_EXEC_ENV_ATTRIBUTE = "_pico_terminal_bench_verifier_exec_env"
_VERIFIER_ACTIVATION_ATTRIBUTE = "_pico_terminal_bench_verifier_activation"
_EXEC_PATCH_MARKER = "_pico_terminal_bench_exec_overlay_installed"
_VERIFIER_PATCH_MARKER = "_pico_terminal_bench_verifier_activation_installed"


def install_verifier_exec_env_overlay(docker_environment: type[Any]) -> None:
    if (
        docker_environment.__module__ != "harbor.environments.docker.docker"
        or docker_environment.__name__ != "DockerEnvironment"
    ):
        raise RuntimeError("Pico verifier overlay requires the exact Harbor Docker backend")
    if docker_environment.__dict__.get(_EXEC_PATCH_MARKER) is True:
        return

    original_exec = docker_environment.exec
    parameters = tuple(inspect.signature(original_exec).parameters.values())
    if (
        tuple(parameter.name for parameter in parameters)
        != ("self", "command", "cwd", "env", "timeout_sec", "user")
        or any(
            parameter.kind
            not in {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
            for parameter in parameters
        )
        or any(
            parameter.default is not inspect.Parameter.empty
            for parameter in parameters[:2]
        )
        or any(parameter.default is not None for parameter in parameters[2:])
    ):
        raise RuntimeError("Harbor Docker exec signature is unsupported")

    @functools.wraps(original_exec)
    async def exec_with_verifier_overlay(
        instance: Any,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> Any:
        overlay = getattr(instance, _VERIFIER_EXEC_ENV_ATTRIBUTE, None)
        if overlay is None:
            return await original_exec(
                instance,
                command,
                cwd=cwd,
                env=env,
                timeout_sec=timeout_sec,
                user=user,
            )
        verified = validate_verifier_exec_env(overlay)
        # scoped_exec_env is consumed only by BaseEnvironment._merge_env for the
        # in-container command. DockerEnvironment._compose_env_vars does not read
        # it, so the authenticated proxy URL never enters the host compose env.
        with instance.scoped_exec_env(verified):
            return await original_exec(
                instance,
                command,
                cwd=cwd,
                env=env,
                timeout_sec=timeout_sec,
                user=user,
            )

    docker_environment.exec = exec_with_verifier_overlay
    setattr(docker_environment, _EXEC_PATCH_MARKER, True)


def install_verifier_phase_activation(single_step_trial: type[Any]) -> None:
    if (
        single_step_trial.__module__ != "harbor.trial.single_step"
        or single_step_trial.__name__ != "SingleStepTrial"
    ):
        raise RuntimeError("Pico verifier activation requires exact Harbor trial class")
    if single_step_trial.__dict__.get(_VERIFIER_PATCH_MARKER) is True:
        return

    original_run_verifier = single_step_trial._run_verifier
    parameters = tuple(inspect.signature(original_run_verifier).parameters.values())
    if (
        len(parameters) != 1
        or parameters[0].name != "self"
        or parameters[0].kind
        not in {
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        }
        or parameters[0].default is not inspect.Parameter.empty
    ):
        raise RuntimeError("Harbor verifier lifecycle signature is unsupported")

    @functools.wraps(original_run_verifier)
    async def run_verifier_with_activation(instance: Any) -> Any:
        verifier_config = instance.config.verifier
        disabled = verifier_config.disable
        if type(disabled) is not bool:
            raise RuntimeError("Harbor verifier disable policy is invalid")
        if not disabled:
            from harbor.models.task.verifier_mode import (
                VerifierEnvironmentMode,
                resolve_task_verifier_mode,
            )

            mode = resolve_task_verifier_mode(instance.task.config)
            if mode == VerifierEnvironmentMode.SHARED:
                await activate_verifier_egress(instance.agent_environment)
        return await original_run_verifier(instance)

    single_step_trial._run_verifier = run_verifier_with_activation
    setattr(single_step_trial, _VERIFIER_PATCH_MARKER, True)


def register_verifier_egress_activation(
    environment: Any,
    activation: Callable[[], Awaitable[None]],
) -> None:
    if not callable(activation):
        raise RuntimeError("Harbor verifier egress activation is invalid")
    if getattr(environment, _VERIFIER_ACTIVATION_ATTRIBUTE, None) is not None:
        raise RuntimeError("Harbor verifier egress activation is already registered")
    setattr(environment, _VERIFIER_ACTIVATION_ATTRIBUTE, activation)


async def activate_verifier_egress(environment: Any) -> None:
    activation = getattr(environment, _VERIFIER_ACTIVATION_ATTRIBUTE, None)
    if activation is not None:
        if not callable(activation):
            raise RuntimeError("Harbor verifier egress activation is invalid")
        await activation()


def clear_verifier_egress_activation(environment: Any) -> None:
    if hasattr(environment, _VERIFIER_ACTIVATION_ATTRIBUTE):
        delattr(environment, _VERIFIER_ACTIVATION_ATTRIBUTE)


def set_verifier_exec_env(environment: Any, values: Mapping[str, str]) -> None:
    if getattr(environment, _VERIFIER_EXEC_ENV_ATTRIBUTE, None) is not None:
        raise RuntimeError("Harbor verifier proxy environment is already active")
    verified = validate_verifier_exec_env(values)
    setattr(
        environment,
        _VERIFIER_EXEC_ENV_ATTRIBUTE,
        MappingProxyType(verified),
    )


def clear_verifier_exec_env(environment: Any) -> None:
    if hasattr(environment, _VERIFIER_EXEC_ENV_ATTRIBUTE):
        delattr(environment, _VERIFIER_EXEC_ENV_ATTRIBUTE)


def validate_verifier_exec_env(values: Mapping[str, str]) -> dict[str, str]:
    if (
        not isinstance(values, Mapping)
        or set(values) != set(PUBLIC_EGRESS_PROXY_ENV_NAMES)
    ):
        raise RuntimeError("Harbor verifier proxy environment is incomplete")
    verified = dict(values)
    if any(
        not isinstance(value, str)
        or not value
        or any(character in value for character in ("\x00", "\r", "\n"))
        for value in verified.values()
    ):
        raise RuntimeError("Harbor verifier proxy environment is invalid")
    return verified
