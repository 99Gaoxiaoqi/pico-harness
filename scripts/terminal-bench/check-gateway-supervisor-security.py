from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class ProviderHandler(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self) -> None:
        type(self).calls += 1
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if b'"delay":true' in body:
            time.sleep(2)
        response = b'{"choices":[{"message":{"content":"ok"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *args: Any) -> None:
        del args


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost", timeout=5)
        self.path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def sign(seed: str, run_id: str, trial_id: str, value: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time())
    auth = {
        "runId": run_id,
        "trialId": trial_id,
        "nonce": secrets.token_hex(16),
        "issuedAt": now,
        "expiresAt": now + 60,
    }
    value = {**value, "trialId": trial_id, "auth": auth}
    signature = hmac.new(
        seed.encode(),
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode(),
        hashlib.sha256,
    ).hexdigest()
    value["auth"] = {**auth, "signature": signature}
    return value


def request(path: str, value: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    body = json.dumps(value, separators=(",", ":")).encode()
    connection = UnixConnection(path)
    try:
        connection.request(
            "POST",
            "/",
            body=body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        )
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if response.status == 200 else None
    finally:
        connection.close()


def proxy_frame(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": "proxy",
        "protocol": "openai",
        "path": "/chat/completions",
        "headers": {"content-type": "application/json"},
        "body": base64.b64encode(
            json.dumps({"model": "test-model", "max_tokens": 8, **body}).encode()
        ).decode(),
    }


def main() -> None:
    project_root = Path(__file__).resolve().parents[2]
    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    run_id = "security-e2e"
    seed = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="pico-gateway-security-") as directory:
        root = Path(directory)
        socket_path = root / "gateway.sock"
        route_path = root / "route.json"
        route_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "modelRouteId": "test/test-model",
                    "provider": {
                        "protocol": "openai",
                        "baseURL": f"http://127.0.0.1:{provider.server_port}",
                    },
                }
            )
        )
        process = subprocess.Popen(
            [
                sys.executable,
                str(
                    project_root
                    / "benchmarks/terminal_bench_2_1/gateway_supervisor.py"
                ),
                "--socket",
                str(socket_path),
                "--route-config",
                str(route_path),
            ],
            cwd=root,
            env={"PATH": str(Path(sys.executable).parent)},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        process.stdin.write(
            json.dumps(
                {
                    "providerSecret": "provider-secret-canary",
                    "runId": run_id,
                    "capabilitySeed": seed,
                }
            ).encode()
        )
        process.stdin.close()
        assert process.stdout is not None
        if process.stdout.readline() != b"READY\n":
            raise AssertionError(process.stderr.read().decode() if process.stderr else "")

        assert request(
            str(socket_path), {"action": "proxy", "trialId": "forged", **proxy_frame({})}
        )[0] == 502
        assert ProviderHandler.calls == 0

        register = sign(
            seed,
            run_id,
            "trial-a",
            {"action": "register", "protocol": "openai", "ttlSec": 60},
        )
        assert request(str(socket_path), register)[0] == 200
        assert request(str(socket_path), register)[0] == 502
        assert request(
            str(socket_path), sign(seed, run_id, "trial-b", proxy_frame({}))
        )[0] == 502
        assert request(
            str(socket_path), sign(seed, run_id, "trial-a", proxy_frame({}))
        )[0] == 200
        assert ProviderHandler.calls == 1

        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-revoked", {"action": "revoke"}),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-revoked",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 502

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-large",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-large", proxy_frame({"padding": "x" * 1_100_000})),
        )[0] == 502
        assert ProviderHandler.calls == 1

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-in-flight",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        result: list[int] = []
        thread = threading.Thread(
            target=lambda: result.append(
                request(
                    str(socket_path),
                    sign(seed, run_id, "trial-in-flight", proxy_frame({"delay": True})),
                )[0]
            )
        )
        thread.start()
        deadline = time.time() + 2
        while ProviderHandler.calls < 2 and time.time() < deadline:
            time.sleep(0.01)
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-in-flight", proxy_frame({})),
        )[0] == 502
        assert ProviderHandler.calls == 2
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-in-flight", {"action": "revoke"}),
        )[0] == 200
        revoked_at = time.monotonic()
        thread.join(4)
        assert result == [502]
        assert time.monotonic() - revoked_at < 1

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-ambiguous",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-ambiguous",
                proxy_frame({"max_tokens": 8, "max_completion_tokens": 1_000_000}),
            ),
        )[0] == 502
        process.terminate()
        process.wait(timeout=5)
    provider.shutdown()
    provider.server_close()
    print("Gateway supervisor security E2E passed")


if __name__ == "__main__":
    main()
