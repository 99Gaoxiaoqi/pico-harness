from __future__ import annotations

import base64
import contextlib
import http.client
import importlib.util
import io
import json
import socket
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


def load_public_egress() -> Any:
    project_root = Path(__file__).resolve().parents[2]
    module_path = project_root / "benchmarks/terminal_bench_2_1/public_egress.py"
    spec = importlib.util.spec_from_file_location(
        "pico_public_egress_security_test", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def basic_auth(token: str, username: str = "pico") -> str:
    encoded = base64.b64encode(f"{username}:{token}".encode()).decode()
    return f"Basic {encoded}"


def wait_until(predicate: Callable[[], bool], timeout_sec: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_sec
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("timed out waiting for local proxy state")
        time.sleep(0.005)


def functional_test_proxy(module: Any, token: str, *args: Any, **kwargs: Any) -> Any:
    """Keep non-TTL checks independent from hosted-runner scheduling delays."""
    return module.PublicEgressProxy(token, module.MAX_TTL_SEC, *args, **kwargs)


def run_check(name: str, check: Callable[[], None]) -> None:
    """Leave a bounded progress trail when a hosted runner suspends local threads."""
    started = time.monotonic()
    print(f"[public-egress] start {name}", file=sys.stderr, flush=True)
    check()
    elapsed = time.monotonic() - started
    print(f"[public-egress] pass {name} ({elapsed:.3f}s)", file=sys.stderr, flush=True)


def port_is_bindable(module: Any, port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((module.PUBLIC_EGRESS_BIND_HOST, port))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def http_request(
    port: int,
    target: str,
    *,
    auth: str | None,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    request_headers = dict(headers or {})
    if auth is not None:
        request_headers["Proxy-Authorization"] = auth
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request(
            method,
            target,
            body=body,
            headers=request_headers,
        )
        response = connection.getresponse()
        response_body = response.read()
        return response.status, response_body, dict(response.getheaders())
    finally:
        connection.close()


def connect_request(port: int, target: str, auth: str) -> tuple[int, socket.socket]:
    client = socket.create_connection(("127.0.0.1", port), timeout=2)
    request = (
        f"CONNECT {target} HTTP/1.1\r\n"
        f"Host: {target}\r\n"
        f"Proxy-Authorization: {auth}\r\n"
        "\r\n"
    ).encode()
    client.sendall(request)
    response = receive_until(client, b"\r\n\r\n")
    status = int(response.split(b" ", 2)[1])
    if status == 200:
        assert b"Connection: close" not in response
    return status, client


def raw_request_status(port: int, request: bytes) -> int:
    client = socket.create_connection(("127.0.0.1", port), timeout=2)
    try:
        client.sendall(request)
        response = receive_until(client, b"\r\n\r\n")
        return int(response.split(b" ", 2)[1])
    finally:
        client.close()


def receive_until(
    connection: socket.socket, marker: bytes, max_bytes: int = 16 * 1024
) -> bytes:
    result = bytearray()
    while marker not in result:
        chunk = connection.recv(4096)
        if not chunk:
            break
        result.extend(chunk)
        if len(result) > max_bytes:
            raise AssertionError("local response exceeded test bound")
    return bytes(result)


class MappingResolver:
    def __init__(self, values: dict[str, list[str]]):
        self.values = values
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int) -> list[str]:
        self.calls.append((host, port))
        return self.values[host]


class RebindingResolver:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, _host: str, _port: int) -> list[str]:
        self.calls += 1
        return ["93.184.216.34"] if self.calls == 1 else ["127.0.0.1"]


class SocketPairConnector:
    def __init__(self, responder: Callable[[socket.socket], None]):
        self.responder = responder
        self.calls: list[tuple[str, int, float]] = []
        self.threads: list[threading.Thread] = []

    def __call__(self, ip: str, port: int, timeout: float) -> socket.socket:
        self.calls.append((ip, port, timeout))
        proxy_side, peer = socket.socketpair()
        thread = threading.Thread(
            target=self._run_responder,
            args=(peer,),
            name="pico-public-egress-test-upstream",
            daemon=True,
        )
        self.threads.append(thread)
        thread.start()
        return proxy_side

    def _run_responder(self, peer: socket.socket) -> None:
        try:
            self.responder(peer)
        finally:
            peer.close()

    def join(self) -> None:
        for thread in self.threads:
            thread.join(timeout=2)
            assert not thread.is_alive()


class HoldingConnector:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, float]] = []
        self.peers: list[socket.socket] = []

    def __call__(self, ip: str, port: int, timeout: float) -> socket.socket:
        self.calls.append((ip, port, timeout))
        proxy_side, peer = socket.socketpair()
        self.peers.append(peer)
        return proxy_side

    def close(self) -> None:
        for peer in self.peers:
            peer.close()


class FakeClock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def encoded_doh_response(
    module: Any,
    payload: Any,
    *,
    status: int = 200,
    content_type: str = "application/dns-json",
) -> Any:
    body = json.dumps(payload, separators=(",", ":")).encode()
    return module._DoHResponse(
        status,
        (
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
        ),
        body,
    )


def fake_doh_response(
    module: Any,
    host: str,
    record_name: str,
    addresses: list[str],
) -> Any:
    record_code = 1 if record_name == "A" else 28
    return encoded_doh_response(
        module,
        {
            "Status": 0,
            "TC": False,
            "Question": [{"name": f"{host}.", "type": record_code}],
            "Answer": [
                {
                    "name": f"{host}.",
                    "type": record_code,
                    "TTL": 60,
                    "data": address,
                }
                for address in addresses
            ],
        },
    )


def read_http_request(peer: socket.socket) -> bytes:
    received = bytearray()
    while b"\r\n\r\n" not in received:
        chunk = peer.recv(4096)
        if not chunk:
            return bytes(received)
        received.extend(chunk)
    header_end = received.index(b"\r\n\r\n") + 4
    headers = received[:header_end].decode("latin-1")
    content_length = 0
    for line in headers.split("\r\n"):
        if line.lower().startswith("content-length:"):
            content_length = int(line.split(":", 1)[1].strip())
    while len(received) - header_end < content_length:
        chunk = peer.recv(4096)
        if not chunk:
            break
        received.extend(chunk)
    return bytes(received)


def http_responder(
    capture: list[bytes], body: bytes = b"ok"
) -> Callable[[socket.socket], None]:
    def respond(peer: socket.socket) -> None:
        request = read_http_request(peer)
        capture.append(request)
        if not request:
            return
        response = (
            b"HTTP/1.1 200 OK\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Connection: close\r\n\r\n"
            + body
        )
        peer.sendall(response)

    return respond


def echo_responder(peer: socket.socket) -> None:
    while True:
        chunk = peer.recv(4096)
        if not chunk:
            return
        peer.sendall(chunk)


def assert_http_and_audit(module: Any) -> None:
    token = "http-token-query-secret"
    header_secret = "header-secret-never-audit"
    body_secret = b"body-secret-never-audit"
    capture: list[bytes] = []
    resolver = RebindingResolver()
    connector = SocketPairConnector(http_responder(capture))
    proxy = functional_test_proxy(module, token)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        status, body, _headers = http_request(
            port,
            "http://public.test/download?credential=query-secret-never-audit",
            auth=basic_auth(token),
            method="POST",
            body=body_secret,
            headers={
                "X-Test-Secret": header_secret,
                "Proxy-Connection": "keep-alive",
            },
        )
    finally:
        receipt = proxy.stop()
        connector.join()

    assert status == 200, (
        f"expected HTTP forwarding status 200, got {status}; "
        f"receipt={json.dumps(receipt, sort_keys=True)}"
    )
    assert body == b"ok"
    assert resolver.calls == 1
    assert len(connector.calls) == 1
    assert connector.calls[0][0] == "93.184.216.34"
    request = capture[0]
    assert b"POST /download?credential=query-secret-never-audit HTTP/1.1" in request
    assert body_secret in request
    assert header_secret.encode() in request
    assert b"Proxy-Authorization" not in request
    assert b"Proxy-Connection" not in request

    encoded_receipt = json.dumps(receipt, sort_keys=True)
    for secret in (
        token,
        "query-secret-never-audit",
        header_secret,
        body_secret.decode(),
    ):
        assert secret not in encoded_receipt
    assert receipt["schemaVersion"] == 1
    assert receipt["started"] is not None
    assert receipt["stopped"] is not None
    assert receipt["allowed"] == 1
    assert receipt["denied"] == 0
    assert receipt["bytes"]["total"] > 0
    assert receipt["decisions"] == [
        {
            "host": "public.test",
            "port": 80,
            "decision": "allow",
            "reason": "completed",
            "bytes": receipt["bytes"]["total"],
        }
    ]


def assert_connect(module: Any) -> None:
    token = "connect-token"
    resolver = MappingResolver({"tunnel.test": ["93.184.216.34"]})
    connector = SocketPairConnector(echo_responder)
    proxy = functional_test_proxy(module, token)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    client: socket.socket | None = None
    try:
        status, client = connect_request(port, "tunnel.test:443", basic_auth(token))
        assert status == 200
        client.sendall(b"tunnel-payload")
        assert client.recv(len(b"tunnel-payload")) == b"tunnel-payload"
    finally:
        if client is not None:
            client.close()
        receipt = proxy.stop()
        connector.join()
    assert resolver.calls == [("tunnel.test", 443)]
    assert connector.calls[0][0] == "93.184.216.34"
    assert receipt["allowed"] == 1
    assert receipt["bytes"]["clientToUpstream"] == len(b"tunnel-payload")
    assert receipt["bytes"]["upstreamToClient"] == len(b"tunnel-payload")


def assert_policy_denials(module: Any) -> None:
    token = "policy-token"
    resolver = MappingResolver(
        {
            "private.test": ["10.0.0.1"],
            "mixed.test": ["93.184.216.34", "127.0.0.1"],
            "mapped.test": ["::ffff:5db8:d822"],
            "nat64-well-known.test": ["64:ff9b::5db8:d822"],
            "nat64-local.test": ["64:ff9b:1::5db8:d822"],
            "six-to-four.test": ["2002:5db8:d822::"],
            "teredo.test": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
            "site-local.test": ["fec0::1"],
            "isatap-public.test": ["2001:4860:4860:0:200:5efe:808:808"],
            "isatap-private.test": ["2001:4860:4860:0:0:5efe:a00:1"],
        }
    )

    def unexpected_connector(_ip: str, _port: int, _timeout: float) -> socket.socket:
        raise AssertionError("a denied target reached the connector")

    proxy = functional_test_proxy(module, token)
    proxy._resolver = resolver
    proxy._connector = unexpected_connector
    port = proxy.start()
    try:
        targets = (
            "http://private.test/",
            "http://mixed.test/",
            "http://mapped.test/",
            "http://nat64-well-known.test/",
            "http://nat64-local.test/",
            "http://six-to-four.test/",
            "http://teredo.test/",
            "http://site-local.test/",
            "http://isatap-public.test/",
            "http://isatap-private.test/",
            "http://localhost/",
            "http://service.local/",
            "http://service.internal/",
            "http://host.docker.internal/",
            "http://metadata.google.internal/",
            "http://93.184.216.34/",
            "http://public.test:81/",
            "https://public.test/",
            "ftp://public.test/",
        )
        for target in targets:
            status, _body, _headers = http_request(port, target, auth=basic_auth(token))
            assert status == 403, (target, status)
        status, client = connect_request(port, "public.test:80", basic_auth(token))
        client.close()
        assert status == 403
    finally:
        receipt = proxy.stop()

    assert resolver.calls == [
        ("private.test", 80),
        ("mixed.test", 80),
        ("mapped.test", 80),
        ("nat64-well-known.test", 80),
        ("nat64-local.test", 80),
        ("six-to-four.test", 80),
        ("teredo.test", 80),
        ("site-local.test", 80),
        ("isatap-public.test", 80),
        ("isatap-private.test", 80),
    ]
    reasons = {decision["reason"] for decision in receipt["decisions"]}
    assert {
        "non_public_address",
        "ipv6_address",
        "localhost",
        "local_name",
        "internal_name",
        "docker_internal",
        "metadata_name",
        "ip_literal",
        "port",
        "https_requires_connect",
        "invalid_scheme",
    } <= reasons
    assert receipt["allowed"] == 0
    assert receipt["denied"] == len(targets) + 1


def assert_authentication(module: Any) -> None:
    token = "authentication-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    capture: list[bytes] = []
    connector = SocketPairConnector(http_responder(capture))
    proxy = functional_test_proxy(module, token)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        attempts = (
            None,
            basic_auth("wrong-password"),
            basic_auth("pässword"),
            basic_auth(token, username="wrong-user"),
            "Bearer unsupported",
            "Basic !!!",
        )
        for auth in attempts:
            status, _body, headers = http_request(
                port, "http://public.test/", auth=auth
            )
            assert status == 407
            assert headers["Proxy-Authenticate"] == 'Basic realm="pico-egress"'
        status, body, _headers = http_request(
            port, "http://public.test/", auth=basic_auth(token)
        )
        assert (status, body) == (200, b"ok")
    finally:
        receipt = proxy.stop()
        connector.join()
    assert resolver.calls == [("public.test", 80)]
    assert len(connector.calls) == 1
    assert receipt["denied"] == len(attempts)
    assert receipt["allowed"] == 1


def assert_header_smuggling_rejected(module: Any) -> None:
    token = "header-validation-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})

    def unexpected_connector(_ip: str, _port: int, _timeout: float) -> socket.socket:
        raise AssertionError("an invalid header reached the connector")

    proxy = functional_test_proxy(module, token)
    proxy._resolver = resolver
    proxy._connector = unexpected_connector
    port = proxy.start()
    try:
        status = raw_request_status(
            port,
            (
                "GET http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                "X-Test: accepted-prefix\r\n"
                " injected: rejected-fold\r\n"
                "\r\n"
            ).encode(),
        )
        assert status == 403
        expectation_status = raw_request_status(
            port,
            (
                "POST http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                "Content-Length: 4\r\n"
                "Expect: 100-continue\r\n"
                "\r\n"
            ).encode(),
        )
        assert expectation_status == 417
    finally:
        receipt = proxy.stop()
    assert resolver.calls == []
    assert [decision["reason"] for decision in receipt["decisions"]] == [
        "headers",
        "expectation",
    ]


def assert_content_length_bound(module: Any) -> None:
    token = "content-length-token"

    def unexpected_resolver(_host: str, _port: int) -> list[str]:
        raise AssertionError("an invalid Content-Length reached DNS")

    proxy = functional_test_proxy(module, token)
    proxy._resolver = unexpected_resolver
    port = proxy.start()
    try:
        overlong_status = raw_request_status(
            port,
            (
                "POST http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                f"Content-Length: {'9' * 5_000}\r\n"
                "\r\n"
            ).encode(),
        )
        assert overlong_status == 413
        non_ascii_status = raw_request_status(
            port,
            (
                "POST http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                "Content-Length: "
            ).encode()
            + b"\xb2\r\n\r\n",
        )
        assert non_ascii_status == 400
    finally:
        receipt = proxy.stop()
    assert [decision["reason"] for decision in receipt["decisions"]] == [
        "content_length",
        "content_length",
    ]


def assert_doh_parser(module: Any) -> None:
    host = "example.com"
    a_response = fake_doh_response(
        module,
        host,
        "A",
        ["93.184.216.34"],
    )
    assert module._parse_doh_response(host, 1, 4, a_response) == ("93.184.216.34",)

    cname_response = encoded_doh_response(
        module,
        {
            "Status": 0,
            "TC": False,
            "Question": [{"name": "example.com.", "type": 1}],
            "Answer": [
                {
                    "name": "example.com.",
                    "type": 5,
                    "TTL": 60,
                    "data": "edge.example.net.",
                },
                {
                    "name": "edge.example.net.",
                    "type": 1,
                    "TTL": 30,
                    "data": "93.184.216.34",
                },
            ],
        },
    )
    assert module._parse_doh_response(host, 1, 4, cname_response) == ("93.184.216.34",)

    invalid_payloads = (
        module._DoHResponse(
            503,
            (("Content-Type", "application/dns-json"),),
            b"{}",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "text/plain"),),
            b"{}",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            b"x" * (module.DOH_MAX_RESPONSE_BYTES + 1),
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            b"{invalid-json",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            (
                b'{"Status":0,"Status":0,"TC":false,'
                b'"Question":[{"name":"example.com.","type":1}]}'
            ),
        ),
        encoded_doh_response(
            module,
            {
                "Status": 2,
                "TC": False,
                "Question": [{"name": "example.com.", "type": 1}],
            },
        ),
        encoded_doh_response(
            module,
            {
                "Status": 0,
                "TC": True,
                "Question": [{"name": "example.com.", "type": 1}],
            },
        ),
        encoded_doh_response(
            module,
            {
                "Status": 0,
                "TC": False,
                "Question": [{"name": "other.example.", "type": 1}],
            },
        ),
        fake_doh_response(module, host, "A", ["198.18.0.14"]),
        fake_doh_response(module, host, "A", ["10.0.0.1"]),
        fake_doh_response(
            module,
            host,
            "AAAA",
            ["2606:2800:220:1:248:1893:25c8:1946"],
        ),
    )
    for response in invalid_payloads:
        try:
            module._parse_doh_response(host, 1, 4, response)
        except module.ProxyRequestError:
            pass
        else:
            raise AssertionError("invalid DoH response was accepted")


def assert_doh_fallback_and_fail_closed(module: Any) -> None:
    original_getaddrinfo = module.socket.getaddrinfo
    calls: list[tuple[str, str, str, float]] = []
    proxy = functional_test_proxy(module, "doh-fail-closed-token")
    proxy.start()

    def forbidden_system_dns(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("default resolver used system DNS")

    def fallback_request(
        endpoint_ip: str,
        host: str,
        record_name: str,
        deadline: float,
    ) -> Any:
        calls.append((endpoint_ip, host, record_name, deadline))
        if endpoint_ip == "1.1.1.1":
            raise OSError("synthetic primary DoH failure")
        return fake_doh_response(module, host, record_name, ["93.184.216.34"])

    try:
        module.socket.getaddrinfo = forbidden_system_dns
        proxy._doh_requester = fallback_request
        addresses = tuple(proxy._resolve_via_doh("example.com", 443))
        assert addresses == ("93.184.216.34",)
        assert [(endpoint, host, record) for endpoint, host, record, _ in calls] == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]

        calls.clear()

        def failed_request(
            endpoint_ip: str,
            host: str,
            record_name: str,
            deadline: float,
        ) -> Any:
            calls.append((endpoint_ip, host, record_name, deadline))
            raise OSError("synthetic pinned DoH outage")

        proxy._doh_requester = failed_request
        try:
            tuple(proxy._resolve_via_doh("example.com", 443))
        except module.ProxyRequestError as error:
            assert error.reason == "resolution_failed"
        else:
            raise AssertionError("DoH outage fell back or failed open")
        assert [(endpoint, host, record) for endpoint, host, record, _ in calls] == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]

        calls.clear()

        def empty_request(
            endpoint_ip: str,
            host: str,
            record_name: str,
            deadline: float,
        ) -> Any:
            calls.append((endpoint_ip, host, record_name, deadline))
            return fake_doh_response(module, host, record_name, [])

        proxy._doh_requester = empty_request
        try:
            tuple(proxy._resolve_via_doh("example.com", 443))
        except module.ProxyRequestError as error:
            assert error.reason == "resolution_failed"
        else:
            raise AssertionError("empty A answer was accepted")
        assert [(endpoint, host, record) for endpoint, host, record, _ in calls] == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]

        calls.clear()

        def fake_ip_request(
            endpoint_ip: str,
            host: str,
            record_name: str,
            deadline: float,
        ) -> Any:
            calls.append((endpoint_ip, host, record_name, deadline))
            return fake_doh_response(module, host, record_name, ["198.18.0.14"])

        proxy._doh_requester = fake_ip_request
        try:
            tuple(proxy._resolve_via_doh("example.com", 443))
        except module.ProxyRequestError:
            pass
        else:
            raise AssertionError("Fake-IP DoH answer was accepted")
        assert [(endpoint, host, record) for endpoint, host, record, _ in calls] == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]
    finally:
        module.socket.getaddrinfo = original_getaddrinfo
        proxy.stop()


def assert_ttl(module: Any) -> None:
    token = "ttl-token"
    clock = FakeClock()
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    proxy = module.PublicEgressProxy(token, 10)
    proxy._monotonic = clock
    proxy._resolver = resolver
    port = proxy.start()
    clock.advance(11)
    try:
        status, _body, _headers = http_request(
            port, "http://public.test/", auth=basic_auth(token)
        )
        assert status == 503
    finally:
        receipt = proxy.stop()
    assert resolver.calls == []
    assert receipt["decisions"][0]["reason"] == "ttl"


def assert_ttl_listener_lifecycle(module: Any) -> None:
    proxy = module.PublicEgressProxy("ttl-listener-token", 0.05)
    port = proxy.start()
    try:
        assert not port_is_bindable(module, port)
        assert proxy._expiry_fired.wait(timeout=2)
        assert not port_is_bindable(module, port)
        status, _body, _headers = http_request(
            port,
            "http://public.test/",
            auth=basic_auth("ttl-listener-token"),
        )
        assert status == 503
    finally:
        receipt = proxy.stop()
    assert port_is_bindable(module, port)
    assert receipt["decisions"][0]["reason"] == "ttl"


def assert_revoke_lifecycle(module: Any) -> None:
    proxy = functional_test_proxy(module, "revoke-token")
    port = proxy.start()
    try:
        proxy.revoke()
        proxy.revoke()
        assert not port_is_bindable(module, port)
        status, _body, _headers = http_request(
            port,
            "http://public.test/",
            auth=basic_auth("revoke-token"),
        )
        assert status == 503
    finally:
        receipt = proxy.stop()
    assert port_is_bindable(module, port)
    assert receipt["requestsAccepted"] == 0
    assert receipt["decisions"][0]["reason"] == "revoked"


def assert_request_limit(module: Any) -> None:
    proxy = functional_test_proxy(module, "request-limit-token", 32, 1_024, 2)
    port = proxy.start()
    try:
        for _attempt in range(2):
            status, _body, _headers = http_request(
                port,
                "http://public.test/",
                auth=None,
            )
            assert status == 407
        status, _body, _headers = http_request(
            port,
            "http://public.test/",
            auth=None,
        )
        assert status == 503
    finally:
        receipt = proxy.stop()
    assert receipt["requestsAccepted"] == 2
    assert receipt["denied"] == 3
    assert [decision["reason"] for decision in receipt["decisions"]] == [
        "authentication",
        "authentication",
        "request_limit",
    ]


def assert_connection_limit(module: Any) -> None:
    proxy = functional_test_proxy(module, "connection-limit-token", max_connections=1)
    port = proxy.start()
    holding_client = socket.create_connection(("127.0.0.1", port), timeout=2)
    try:
        wait_until(lambda: len(proxy._active_sockets) == 1)
        rejected_client = socket.create_connection(("127.0.0.1", port), timeout=2)
        try:
            response = receive_until(rejected_client, b"\r\n\r\n")
            assert b" 503 " in response
        finally:
            rejected_client.close()
    finally:
        holding_client.close()
        receipt = proxy.stop()
    assert receipt["denied"] == 1
    assert receipt["decisions"][0]["reason"] == "connection_limit"


def assert_server_error_is_bounded(module: Any) -> None:
    proxy = functional_test_proxy(module, "server-error-token")
    proxy.start()
    client, peer = socket.socketpair()
    try:
        server = proxy._server
        assert server is not None
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            server.handle_error(client, ("local", 0))
        assert stderr.getvalue() == ""
    finally:
        client.close()
        peer.close()
        receipt = proxy.stop()
    assert receipt["decisions"] == [
        {
            "host": "",
            "port": 0,
            "decision": "deny",
            "reason": "server_error",
            "bytes": 0,
        }
    ]


def assert_blocked_doh_action(module: Any, action: str) -> None:
    ttl_sec = 0.5 if action == "ttl" else module.MAX_TTL_SEC
    proxy = module.PublicEgressProxy(f"blocked-doh-{action}-token", ttl_sec)
    entered = threading.Event()
    peers: list[socket.socket] = []
    outcome: list[str] = []

    def blocked_socket_factory() -> socket.socket:
        proxy_side, peer = socket.socketpair()
        peers.append(peer)
        entered.set()
        return proxy_side

    proxy._doh_socket_factory = blocked_socket_factory
    proxy._doh_socket_connect = lambda _connection, _address: None
    port = proxy.start()

    def issue_request() -> None:
        client: socket.socket | None = None
        try:
            status, client = connect_request(
                port,
                "blocked.test:443",
                basic_auth(f"blocked-doh-{action}-token"),
            )
            outcome.append(f"status:{status}")
        except (OSError, IndexError, ValueError, http.client.HTTPException) as error:
            outcome.append(type(error).__name__)
        finally:
            if client is not None:
                client.close()

    requester = threading.Thread(
        target=issue_request,
        name=f"pico-public-egress-test-blocked-{action}",
        daemon=True,
    )
    requester.start()
    assert entered.wait(timeout=2)
    wait_until(lambda: len(proxy._active_sockets) >= 2)

    receipt: dict[str, Any] | None = None
    try:
        if action == "stop":
            receipt = proxy.stop()
        elif action == "revoke":
            proxy.revoke()
        else:
            assert action == "ttl"
            assert proxy._expiry_fired.wait(timeout=2)

        requester.join(timeout=2)
        assert not requester.is_alive()
        assert outcome
        try:
            wait_until(lambda: not proxy._active_sockets)
        except AssertionError as error:
            raise AssertionError(
                f"{action} retained {len(proxy._active_sockets)} active sockets"
            ) from error
        assert len(peers) == 1

        if action != "stop":
            assert not port_is_bindable(module, port)
            receipt = proxy.stop()
        assert port_is_bindable(module, port)
        assert receipt is not None
        assert receipt["requestsAccepted"] == 1
        expected_reason = {
            "stop": "stopped",
            "revoke": "revoked",
            "ttl": "ttl",
        }[action]
        assert any(
            decision["reason"] == expected_reason for decision in receipt["decisions"]
        )
        stable_receipt = json.dumps(receipt, sort_keys=True)
        time.sleep(0.05)
        assert json.dumps(proxy.stop(), sort_keys=True) == stable_receipt
    finally:
        for peer in peers:
            peer.close()
        if receipt is None:
            proxy.stop()


def assert_blocked_doh_cancellation(module: Any) -> None:
    for action in ("stop", "revoke", "ttl"):
        assert_blocked_doh_action(module, action)


def assert_byte_limit(module: Any) -> None:
    token = "byte-limit-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    capture: list[bytes] = []
    connector = SocketPairConnector(http_responder(capture, body=b"x" * 1_024))
    proxy = functional_test_proxy(module, token, max_total_bytes=512)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        try:
            http_request(port, "http://public.test/", auth=basic_auth(token))
        except (http.client.HTTPException, OSError):
            pass
    finally:
        receipt = proxy.stop()
        connector.join()
    assert receipt["bytes"]["total"] <= 512
    assert receipt["decisions"][0]["reason"] == "byte_limit"

    preflight_proxy = functional_test_proxy(module, token, max_total_bytes=512)
    preflight_proxy._resolver = resolver
    preflight_proxy._connector = connector
    preflight_port = preflight_proxy.start()
    try:
        status, _body, _headers = http_request(
            preflight_port,
            "http://public.test/",
            auth=basic_auth(token),
            method="POST",
            body=b"x" * 513,
        )
        assert status == 413
    finally:
        preflight_receipt = preflight_proxy.stop()
    assert preflight_receipt["bytes"]["total"] == 0
    assert preflight_receipt["decisions"][0]["reason"] == "byte_limit"


def assert_connection_timeout(module: Any) -> None:
    token = "connection-timeout-token"
    clock = FakeClock()
    resolver = MappingResolver({"tunnel.test": ["93.184.216.34"]})
    connector = HoldingConnector()
    proxy = module.PublicEgressProxy(token, 1_000)
    proxy._monotonic = clock
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    client: socket.socket | None = None
    try:
        status, client = connect_request(port, "tunnel.test:443", basic_auth(token))
        assert status == 200
        clock.advance(module.PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC + 1)
        wait_until(lambda: client.recv(1) == b"", timeout_sec=2)
    finally:
        if client is not None:
            client.close()
        receipt = proxy.stop()
        connector.close()
    assert receipt["decisions"][0]["reason"] == "connection_timeout"


def assert_bounded_audit(module: Any) -> None:
    proxy = functional_test_proxy(module, "bounded-audit-token")
    proxy.start()
    server_thread = proxy._server_thread
    expiry_thread = proxy._expiry_thread
    for sequence in range(module.MAX_AUDIT_DECISIONS + 44):
        proxy._record_decision(
            host=f"host-{sequence}.test",
            port=80,
            decision="deny",
            reason="test",
            byte_count=0,
        )
    receipt = proxy.stop()
    assert server_thread is not None and not server_thread.is_alive()
    assert expiry_thread is not None and not expiry_thread.is_alive()
    assert len(receipt["decisions"]) == module.MAX_AUDIT_DECISIONS
    assert receipt["decisionsTruncated"] == 44


def assert_constructor_contract(module: Any) -> None:
    assert module.PROXY_POLICY_VERSION == 1
    assert module.DEFAULT_MAX_CONNECTIONS == 32
    assert module.DEFAULT_MAX_TOTAL_BYTES == 1_073_741_824
    assert module.DEFAULT_MAX_REQUESTS == 4_096
    assert module.ALLOWED_HTTP_PORTS == (80,)
    assert module.ALLOWED_CONNECT_PORTS == (443,)
    assert module.DOH_HOST == "cloudflare-dns.com"
    assert module.DOH_ENDPOINT_IPS == ("1.1.1.1", "1.0.0.1")
    for args in (
        ("", 60),
        ("token with space", 60),
        ("令牌", 60),
        ("token", 0),
        ("token", float("inf")),
        ("token", 60, 0),
        ("token", 60, 32, 0),
        ("token", 60, 32, 1_024, 0),
        ("token", 60, 32, 1_024, True),
        ("token", 60, 32, 1_024, 1_000_001),
    ):
        try:
            module.PublicEgressProxy(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid constructor values were accepted: {args!r}")


def main() -> None:
    module = load_public_egress()
    checks = (
        ("constructor", lambda: assert_constructor_contract(module)),
        ("http-and-audit", lambda: assert_http_and_audit(module)),
        ("connect", lambda: assert_connect(module)),
        ("policy-denials", lambda: assert_policy_denials(module)),
        ("authentication", lambda: assert_authentication(module)),
        ("header-smuggling", lambda: assert_header_smuggling_rejected(module)),
        ("content-length", lambda: assert_content_length_bound(module)),
        ("doh-parser", lambda: assert_doh_parser(module)),
        ("doh-fail-closed", lambda: assert_doh_fallback_and_fail_closed(module)),
        ("ttl", lambda: assert_ttl(module)),
        ("ttl-listener", lambda: assert_ttl_listener_lifecycle(module)),
        ("revoke", lambda: assert_revoke_lifecycle(module)),
        ("request-limit", lambda: assert_request_limit(module)),
        ("connection-limit", lambda: assert_connection_limit(module)),
        ("server-error", lambda: assert_server_error_is_bounded(module)),
        ("blocked-doh", lambda: assert_blocked_doh_cancellation(module)),
        ("byte-limit", lambda: assert_byte_limit(module)),
        ("connection-timeout", lambda: assert_connection_timeout(module)),
        ("bounded-audit", lambda: assert_bounded_audit(module)),
    )
    for name, check in checks:
        run_check(name, check)
    print(
        json.dumps(
            {
                "ok": True,
                "proxyPolicyVersion": module.PROXY_POLICY_VERSION,
                "checks": 19,
                "maxConnections": module.DEFAULT_MAX_CONNECTIONS,
                "maxRequests": module.DEFAULT_MAX_REQUESTS,
                "maxTotalBytes": module.DEFAULT_MAX_TOTAL_BYTES,
                "maxAuditDecisions": module.MAX_AUDIT_DECISIONS,
                "allowedHttpPorts": list(module.ALLOWED_HTTP_PORTS),
                "allowedConnectPorts": list(module.ALLOWED_CONNECT_PORTS),
                "connectionTimeoutSec": (module.PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC),
                "dnsMode": "pinned-doh",
                "dohHost": module.DOH_HOST,
                "dohEndpointIps": list(module.DOH_ENDPOINT_IPS),
                "systemDnsFallback": False,
                "ipv4Only": True,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
