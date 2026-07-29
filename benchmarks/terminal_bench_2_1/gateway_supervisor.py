from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import signal
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class GatewayState:
    def __init__(self, route_config: dict[str, Any], provider_secret: str):
        self.provider = route_config["provider"]
        self.model = route_config["modelRouteId"].split("/", 1)[1]
        self.provider_secret = provider_secret
        self.lock = threading.Lock()
        self.trials: dict[str, dict[str, Any]] = {}

    def proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        trial_id = require_trial_id(request.get("trialId"))
        ttl_sec = min(float(request.get("ttlSec", 0)), 7_200)
        protocol = request.get("protocol")
        if protocol != self.provider["protocol"] or ttl_sec <= 0:
            raise ValueError("gateway route mismatch")
        body = base64.b64decode(request.get("body", ""), validate=True)
        path = require_path(request.get("path"), protocol, self.model)
        bounded_body, output_limit = bound_request(body, path, protocol, self.model)
        with self.lock:
            trial = self.trials.setdefault(
                trial_id,
                {
                    "expiresAt": time.monotonic() + ttl_sec,
                    "requestsRemaining": 128,
                    "outputTokensRemaining": 65_536,
                    "revoked": False,
                    "active": set(),
                },
            )
            if (
                trial["revoked"]
                or time.monotonic() >= trial["expiresAt"]
                or trial["requestsRemaining"] <= 0
                or trial["outputTokensRemaining"] < output_limit
                or trial["active"]
            ):
                raise ValueError("gateway trial quota exhausted")
            trial["requestsRemaining"] -= 1
            trial["outputTokensRemaining"] -= output_limit
        upstream = urlsplit(self.provider["baseURL"])
        connection_class = (
            http.client.HTTPSConnection
            if upstream.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_class(upstream.hostname, upstream.port, timeout=120)
        with self.lock:
            if trial["revoked"]:
                raise ValueError("gateway trial revoked")
            trial["active"].add(connection)
        try:
            connection.request(
                "POST",
                upstream_path(upstream.path, path, protocol, self.provider_secret),
                body=bounded_body,
                headers=upstream_headers(protocol, self.provider_secret, request.get("headers")),
            )
            response = connection.getresponse()
            response_body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_RESPONSE_BYTES:
                raise ValueError("gateway response exceeds limit")
            return {
                "status": response.status,
                "headers": [
                    [name, value]
                    for name, value in response.getheaders()
                    if name.lower()
                    in {
                        "content-type",
                        "retry-after",
                        "x-ratelimit-limit-requests",
                        "x-ratelimit-remaining-requests",
                        "x-ratelimit-reset-requests",
                    }
                ],
                "body": base64.b64encode(response_body).decode(),
            }
        finally:
            with self.lock:
                trial["active"].discard(connection)
            connection.close()

    def revoke(self, trial_id: Any) -> None:
        key = require_trial_id(trial_id)
        with self.lock:
            trial = self.trials.get(key)
            if trial is None:
                return
            trial["revoked"] = True
            active = list(trial["active"])
        for connection in active:
            connection.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "SupervisorServer"

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 1 or length > MAX_FRAME_BYTES:
                raise ValueError("invalid supervisor frame")
            request = json.loads(self.rfile.read(length))
            if request.get("action") == "proxy":
                response = self.server.state.proxy(request)
            elif request.get("action") == "revoke":
                self.server.state.revoke(request.get("trialId"))
                response = {"status": 204, "headers": [], "body": ""}
            else:
                raise ValueError("unsupported supervisor action")
            data = json.dumps(response, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_error(502, "Gateway supervisor rejected the request")
        finally:
            self.close_connection = True

    def log_message(self, _format: str, *args: Any) -> None:
        del args


class SupervisorServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, state: GatewayState):
        self.state = state
        super().__init__(path, Handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--route-config", required=True)
    args = parser.parse_args()
    route_config = json.loads(Path(args.route_config).read_text(encoding="utf-8"))
    provider_secret = os.pread(4, 64 * 1024, 0).decode()
    os.close(4)
    if not provider_secret or "\n" in provider_secret:
        raise ValueError("invalid provider credential descriptor")
    for name, value in os.environ.items():
        if value == provider_secret or name == "PICO_TB_PROVIDER_API_KEY":
            raise ValueError("provider credential leaked into supervisor environment")
    socket_path = Path(args.socket)
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = SupervisorServer(str(socket_path), GatewayState(route_config, provider_secret))
    os.chmod(socket_path, 0o600)
    parent_pid = os.getppid()
    threading.Thread(
        target=stop_when_parent_exits,
        args=(server, parent_pid),
        daemon=True,
    ).start()
    signal.signal(
        signal.SIGTERM,
        lambda *_args: threading.Thread(target=server.shutdown, daemon=True).start(),
    )
    print("READY", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def stop_when_parent_exits(server: SupervisorServer, parent_pid: int) -> None:
    while True:
        time.sleep(1)
        if os.getppid() != parent_pid:
            server.shutdown()
            return


def require_trial_id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ValueError("invalid trial identity")
    return value


def require_path(value: Any, protocol: str, model: str) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid gateway path")
    split = urlsplit(value)
    if protocol == "openai" and split.path != "/chat/completions":
        raise ValueError("gateway path mismatch")
    if protocol == "claude" and split.path != "/messages":
        raise ValueError("gateway path mismatch")
    if protocol == "gemini" and split.path not in {
        f"/v1beta/models/{model}:generateContent",
        f"/v1beta/models/{model}:streamGenerateContent",
    }:
        raise ValueError("gateway path mismatch")
    return value


def bound_request(body: bytes, path: str, protocol: str, model: str) -> tuple[bytes, int]:
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("gateway request must be an object")
    if protocol == "gemini":
        generation = value.setdefault("generationConfig", {})
        if not isinstance(generation, dict):
            raise ValueError("gateway generation config must be an object")
        output_limit = min(int(generation.get("maxOutputTokens", 8_192)), 8_192)
        generation["maxOutputTokens"] = output_limit
    else:
        if value.get("model") != model:
            raise ValueError("gateway model mismatch")
        output_limit = min(
            int(value.get("max_tokens", value.get("max_completion_tokens", 8_192))),
            8_192,
        )
        if protocol == "openai":
            field = (
                "max_completion_tokens"
                if "max_completion_tokens" in value
                else "max_tokens"
            )
            value[field] = output_limit
        else:
            value["max_tokens"] = output_limit
    if output_limit < 1:
        raise ValueError("gateway output token limit is invalid")
    return json.dumps(value, separators=(",", ":")).encode(), output_limit


def upstream_headers(
    protocol: str, provider_secret: str, incoming: Any
) -> dict[str, str]:
    incoming_headers = incoming if isinstance(incoming, dict) else {}
    headers = {
        "Content-Type": str(incoming_headers.get("content-type", "application/json")),
        "Accept": str(incoming_headers.get("accept", "*/*")),
    }
    if version := incoming_headers.get("anthropic-version"):
        headers["anthropic-version"] = str(version)
    if protocol == "openai":
        headers["Authorization"] = f"Bearer {provider_secret}"
    elif protocol == "claude":
        headers["x-api-key"] = provider_secret
    return headers


def upstream_path(
    base_path: str, incoming: str, protocol: str, provider_secret: str
) -> str:
    split = urlsplit(incoming)
    query = parse_qsl(split.query, keep_blank_values=True)
    if protocol == "gemini":
        query = [
            (name, provider_secret if name == "key" else value) for name, value in query
        ]
    path = f"{base_path.rstrip('/')}/{split.path.lstrip('/')}"
    return urlunsplit(("", "", path, urlencode(query), ""))


if __name__ == "__main__":
    main()
